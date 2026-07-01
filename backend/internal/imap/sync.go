package imap

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"regexp"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"mailgo/internal/appclock"
	"mailgo/internal/crypto"
	"mailgo/internal/database"
	"mailgo/internal/microsoftauth"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
	"github.com/emersion/go-message/charset"
)

// Per-account mutex — prevents concurrent IMAP syncs for the same account.
var (
	syncMu    sync.Mutex
	syncLocks = make(map[int64]*sync.Mutex)
)

// Global sync state — a single atomic flag that indicates whether ANY sync
// (manual, auto, background loop) is currently running. This ensures a
// single-flight queue: if a sync is in progress, new triggers are rejected
// with 409 instead of spawning overlapping goroutines.
var (
	globalSyncing   atomic.Bool
	globalSyncStart time.Time
)

// IsSyncRunning reports whether a sync is currently in progress.
func IsSyncRunning() bool { return globalSyncing.Load() }

// SyncStartedAt returns the time the current sync started. Zero value if idle.
func SyncStartedAt() time.Time { return globalSyncStart }

// TryBeginGlobalSync attempts to acquire the global sync flag.
// Returns true if acquired (caller should run the sync), false if a sync
// is already running (caller should skip or return 409).
func TryBeginGlobalSync() bool {
	if !globalSyncing.CompareAndSwap(false, true) {
		return false
	}
	globalSyncStart = time.Now()
	return true
}

// EndGlobalSync releases the global sync flag.
func EndGlobalSync() {
	globalSyncing.Store(false)
}

// AccountSyncLock returns the mutex for the given account. Creates one if
// it doesn't exist yet. Exported so the handlers package can use TryLock
// to skip (rather than block) duplicate requests.
func AccountSyncLock(id int64) *sync.Mutex {
	syncMu.Lock()
	defer syncMu.Unlock()
	mu, ok := syncLocks[id]
	if !ok {
		mu = &sync.Mutex{}
		syncLocks[id] = mu
	}
	return mu
}

// SyncResult describes the outcome of a single sync run.
type SyncResult struct {
	AccountID   int64
	OK          bool
	Folders     int
	NewMessages int
	LastUID     uint32
	Error       error
}

// batchSize is the number of messages fetched per IMAP round-trip in a
// single syncFolder call.  Keeping this finite avoids holding the entire
// mailbox in memory at once and lets us print progress for large folders.
const batchSize = 500

type imapFetchFunc func(*imap.SeqSet, []imap.FetchItem, chan *imap.Message) error

func startFetch(fetch imapFetchFunc, seqSet *imap.SeqSet, items []imap.FetchItem, messages chan *imap.Message) <-chan error {
	errCh := make(chan error, 1)
	go func() {
		errCh <- fetch(seqSet, items, messages)
	}()
	return errCh
}

// SyncAccount connects to the account's IMAP server and pulls new mail
// for every known folder, up to fetchLimit messages per folder since the
// last synced UID. Password is the stored credential (already decrypted
// at the call site).
//
// A per-account mutex ensures only one sync runs per account at a time.
// Concurrent calls for the same account block until the first finishes.
func SyncAccount(cfg AccountConfig) SyncResult {
	mu := AccountSyncLock(cfg.ID)
	mu.Lock()
	defer mu.Unlock()

	res := SyncResult{AccountID: cfg.ID}
	// Clear stale progress from any previous sync before writing fresh state.
	database.SyncProgressClear(cfg.ID)
	database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
		"status":     "syncing",
		"started_at": time.Now().UTC().Format(time.RFC3339),
		"updated_at": time.Now().UTC().Format(time.RFC3339),
		"error":      "",
	})
	log.Printf("imap sync acct%d: connecting to %s:%d...", cfg.ID, cfg.Host, cfg.Port)
	c, err := Connect(cfg)
	if err != nil {
		log.Printf("imap sync acct%d: connect FAILED: %v", cfg.ID, err)
		res.Error = err
		database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
			"status":     "failed",
			"error":      err.Error(),
			"updated_at": time.Now().UTC().Format(time.RFC3339),
		})
		return res
	}
	log.Printf("imap sync acct%d: connected, listing mailboxes...", cfg.ID)
	defer disconnect(c)

	// Discover the mailboxes that actually exist on the server. We use
	// this to (a) skip local folder entries whose name doesn't match any
	// server mailbox (e.g. "Archive" when the server calls it nothing),
	// and (b) map our canonical folder names to the server's names (e.g.
	// "Sent" → "Sent Messages").
	serverMailboxes, err := FetchMailboxInfos(c)
	if err != nil {
		res.Error = fmt.Errorf("list mailboxes: %w", err)
		return res
	}
	serverSet := make(map[string]bool, len(serverMailboxes))
	for _, mb := range serverMailboxes {
		serverSet[normalizeMailboxName(mb.Name)] = true
	}

	// Resolve the folders we should sync for this account.
	localFolders, err := loadAccountFolders(cfg.ID)
	if err != nil {
		res.Error = fmt.Errorf("load folders: %w", err)
		database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
			"status":     "failed",
			"error":      res.Error.Error(),
			"updated_at": time.Now().UTC().Format(time.RFC3339),
		})
		return res
	}

	// Sync each folder, mapping its name to the server's actual mailbox
	// name when they differ. If the connection drops mid-sync (common with
	// Gmail which closes idle connections), we reconnect and retry.
	now := time.Now().UTC()
	syncedServerNames := make(map[string]bool)
	syncedFolderCount := 0
	for _, f := range localFolders {
		if isProviderContainerFolder(f.Name) {
			continue
		}
		serverName := resolveServerFolderName(f.Name, f.Role, serverSet, serverMailboxes)
		if serverName == "" {
			continue
		}
		serverKey := strings.ToLower(strings.TrimSpace(serverName))
		if syncedServerNames[serverKey] {
			continue
		}
		syncedServerNames[serverKey] = true

		database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
			"folder":        serverName,
			"folder_id":     f.ID,
			"folder_synced": 0,
			"folder_total":  0,
			"updated_at":    time.Now().UTC().Format(time.RFC3339),
		})

		n, lastUID, ferr := syncFolder(c, cfg.ID, f, serverName, cfg.SyncDays, cfg.SyncMaxMessages)

		// If the connection was closed, reconnect and retry once.
		if ferr != nil && isConnectionError(ferr) {
			log.Printf("imap sync account %d: connection lost, reconnecting...", cfg.ID)
			disconnect(c)
			c, err = Connect(cfg)
			if err != nil {
				log.Printf("imap sync account %d reconnect failed: %v", cfg.ID, err)
				database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
					"status":     "failed",
					"error":      fmt.Sprintf("reconnect failed: %v", err),
					"updated_at": time.Now().UTC().Format(time.RFC3339),
				})
				break
			}
			// Re-discover mailboxes after reconnect.
			serverMailboxes, err = FetchMailboxInfos(c)
			if err != nil {
				log.Printf("imap sync account %d re-list mailboxes: %v", cfg.ID, err)
				database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
					"status":     "failed",
					"error":      fmt.Sprintf("re-list mailboxes: %v", err),
					"updated_at": time.Now().UTC().Format(time.RFC3339),
				})
				break
			}
			serverSet = make(map[string]bool, len(serverMailboxes))
			for _, mb := range serverMailboxes {
				serverSet[normalizeMailboxName(mb.Name)] = true
			}
			n, lastUID, ferr = syncFolder(c, cfg.ID, f, serverName, cfg.SyncDays, cfg.SyncMaxMessages)
		}

		if ferr != nil {
			log.Printf("imap sync account %d folder %s: %v", cfg.ID, serverName, ferr)
			continue
		}
		syncedFolderCount++
		res.Folders++
		res.NewMessages += n
		if lastUID > res.LastUID {
			res.LastUID = lastUID
		}
		_, _ = database.DB.Exec(
			"UPDATE folders SET last_synced_at = ?, uid_next = ? WHERE id = ?",
			now, int64(lastUID), f.ID,
		)
		database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
			"synced_folders": syncedFolderCount,
			"new_messages":   res.NewMessages,
			"updated_at":     time.Now().UTC().Format(time.RFC3339),
		})
	}

	// Stamp the account's last successful sync.
	_, _ = database.DB.Exec(
		"UPDATE accounts SET last_sync_at = ?, updated_at = ? WHERE id = ?",
		now, now, cfg.ID,
	)

	database.SyncProgressSetMulti(cfg.ID, map[string]interface{}{
		"status":     "completed",
		"updated_at": time.Now().UTC().Format(time.RFC3339),
		"error":      "",
	})

	res.OK = true
	return res
}

// isConnectionError reports whether err indicates a dropped or closed IMAP
// connection so the caller can reconnect and retry.
func isConnectionError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "connection closed") ||
		strings.Contains(msg, "use of closed") ||
		strings.Contains(msg, "io: read/write on closed") ||
		strings.Contains(msg, "reset by peer") ||
		strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "EOF")
}

// resolveServerFolderName maps a local folder name (e.g. "Sent") to the
// actual mailbox name on the server. Different providers use different
// names for the same logical folder ("Sent" vs "Sent Messages" vs
// "Sent Items"). If an exact match exists we use it; otherwise we try
// common aliases. Returns "" when no match is found (folder should be
// skipped).
func resolveServerFolderName(local, role string, serverSet map[string]bool, serverMailboxes []ServerMailbox) string {
	localKey := normalizeMailboxName(local)
	for _, mb := range serverMailboxes {
		if normalizeMailboxName(mb.Name) == localKey {
			return mb.Name
		}
	}

	role = canonicalFolderRole(role)
	if role == "" || role == "other" {
		role = canonicalFolderRole(local)
	}
	for _, mb := range serverMailboxes {
		if role != "" && canonicalRoleFromAttributes(mb.Attributes) == role {
			return mb.Name
		}
	}
	for _, mb := range serverMailboxes {
		if role != "" && canonicalFolderRole(mb.Name) == role {
			return mb.Name
		}
	}
	if serverSet[localKey] {
		return local
	}
	return ""
}

func ensureServerFolders(accountID int64, mailboxes []ServerMailbox) error {
	for _, mb := range mailboxes {
		role := canonicalRoleFromAttributes(mb.Attributes)
		if role == "" {
			role = canonicalFolderRole(mb.Name)
		}
		if role == "" {
			role = "other"
		}
		if _, err := database.DB.Exec(
			`INSERT INTO folders (account_id, name, role) VALUES (?, ?, ?)
			 ON CONFLICT(account_id, name) DO UPDATE SET role = excluded.role`,
			accountID, mb.Name, role,
		); err != nil {
			return err
		}
	}
	return nil
}

func canonicalRoleFromAttributes(attrs []string) string {
	for _, attr := range attrs {
		switch strings.ToLower(strings.TrimSpace(attr)) {
		case "\\inbox":
			return "inbox"
		case "\\sent":
			return "sent"
		case "\\drafts":
			return "drafts"
		case "\\trash":
			return "trash"
		case "\\junk":
			return "spam"
		case "\\archive":
			return "archive"
		case "\\flagged":
			return "important"
		}
	}
	return ""
}

func canonicalFolderRole(name string) string {
	key := normalizeMailboxName(name)
	aliases := map[string]string{
		"inbox":                          "inbox",
		"sent":                           "sent",
		"sent mail":                      "sent",
		"sent messages":                  "sent",
		"sent items":                     "sent",
		"draft":                          "drafts",
		"drafts":                         "drafts",
		"draft messages":                 "drafts",
		"trash":                          "trash",
		"deleted":                        "trash",
		"deleted items":                  "trash",
		"deleted messages":               "trash",
		"bin":                            "trash",
		"junk":                           "spam",
		"junk mail":                      "spam",
		"junk e-mail":                    "spam",
		"spam":                           "spam",
		"bulk mail":                      "spam",
		"inbox.spam":                     "spam",
		"archive":                        "archive",
		"archives":                       "archive",
		"all mail":                       "archive",
		"allmail":                        "archive",
		"flagged":                        "important",
		"starred":                        "important",
		"important":                      "important",
		"\u5df2\u53d1\u9001":             "sent",
		"\u5df2\u53d1\u9001\u90ae\u4ef6": "sent",
		"\u8349\u7a3f\u7bb1":             "drafts",
		"\u5df2\u5220\u9664":             "trash",
		"\u5df2\u5220\u9664\u90ae\u4ef6": "trash",
		"\u5783\u573e\u90ae\u4ef6":       "spam",
		"\u6240\u6709\u90ae\u4ef6":       "archive",
		"\u5df2\u52a0\u661f\u6807":       "important",
		"\u91cd\u8981":                   "important",
	}
	if role, ok := aliases[key]; ok {
		return role
	}
	return ""
}

func normalizeMailboxName(name string) string {
	key := strings.ToLower(strings.TrimSpace(name))
	key = strings.ReplaceAll(key, "\\", "/")
	if idx := strings.LastIndex(key, "/"); idx >= 0 {
		key = strings.TrimSpace(key[idx+1:])
	}
	key = strings.TrimPrefix(key, "[gmail]")
	key = strings.TrimPrefix(key, "[google mail]")
	key = strings.Trim(key, " []")
	return strings.Join(strings.Fields(key), " ")
}

func isProviderContainerFolder(name string) bool {
	key := strings.ToLower(strings.TrimSpace(name))
	return key == "[gmail]" || key == "[google mail]"
}

// accountFolder is a lightweight view of a folders row.
type accountFolder struct {
	ID      int64
	Name    string
	Role    string
	LastUID uint32
}

// loadAccountFolders returns the folders we track for the given account.
func loadAccountFolders(accountID int64) ([]accountFolder, error) {
	rows, err := database.DB.Query(
		`SELECT id, name, role, COALESCE(uid_next, 0) FROM folders WHERE account_id = ? ORDER BY id`,
		accountID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []accountFolder
	for rows.Next() {
		var f accountFolder
		var uidNext int64
		if err := rows.Scan(&f.ID, &f.Name, &f.Role, &uidNext); err != nil {
			return nil, err
		}
		f.LastUID = uint32(uidNext)
		out = append(out, f)
	}
	return out, rows.Err()
}

// syncFolder selects a mailbox and pulls all messages with UID greater
// than the folder's LastUID. serverName is the actual mailbox name on
// the IMAP server (may differ from f.Name when the provider uses a
// different name like "Sent Messages"). Returns the count of newly
// stored messages and the highest UID seen.
func syncFolder(c *client.Client, accountID int64, f accountFolder, serverName string, syncDays, syncMaxMessages int) (int, uint32, error) {
	mbox, err := c.Select(serverName, false)
	if err != nil {
		return 0, 0, fmt.Errorf("select %s: %w", serverName, err)
	}

	if mbox.Messages == 0 {
		return 0, 0, nil
	}

	section := &imap.BodySectionName{Peek: true}
	items := []imap.FetchItem{
		imap.FetchUid,
		imap.FetchFlags,
		imap.FetchEnvelope,
		imap.FetchInternalDate,
		imap.FetchRFC822Size,
		section.FetchItem(),
	}

	totalCount := 0
	lastUID := f.LastUID

	database.SyncProgressSetMulti(accountID, map[string]interface{}{
		"folder_total":  mbox.Messages,
		"folder_synced": 0,
		"updated_at":    time.Now().UTC().Format(time.RFC3339),
	})

	if f.LastUID == 0 {
		// ── First sync: fetch NEWEST-first so the user sees recent
		//    mail immediately.  Oldest boundary = sync_days cutoff. ──
		log.Printf("imap sync acct%d %s: first sync, fetching %d messages (syncDays=%d)",
			accountID, serverName, mbox.Messages, syncDays)

		var cutoff time.Time
		if syncDays > 0 {
			cutoff = appclock.StartOfDayDaysAgo(syncDays)
		}
		processedCount := 0
		reachedCutoff := false
		reachedLimit := false
		// Fetch ALL messages newest-first (descending sequence numbers), but
		// stop as soon as the configured time or message-count boundary is
		// reached. This is more reliable than IMAP SEARCH because SEARCH
		// returns sequence numbers unless UID SEARCH is used, and providers
		// differ in how they interpret date criteria.
		for start := mbox.Messages; start >= 1; {
			end := start
			batchStart := uint32(1)
			if start > uint32(batchSize) {
				batchStart = start - uint32(batchSize) + 1
			}

			seqSet := new(imap.SeqSet)
			seqSet.AddRange(batchStart, end)

			messages := make(chan *imap.Message, 16)
			errCh := startFetch(c.Fetch, seqSet, items, messages)

			var batchMessages []*imap.Message
			for msg := range messages {
				if msg != nil {
					batchMessages = append(batchMessages, msg)
				}
			}
			if err := <-errCh; err != nil {
				return totalCount, lastUID, fmt.Errorf("fetch %s seq %d:%d: %w", serverName, batchStart, end, err)
			}
			sort.Slice(batchMessages, func(i, j int) bool {
				return batchMessages[i].SeqNum > batchMessages[j].SeqNum
			})

			batchCount := 0
			batchSkipped := 0
			for _, msg := range batchMessages {
				msgDate := messageSyncDate(msg)
				if !cutoff.IsZero() && msgDate.Before(cutoff) {
					reachedCutoff = true
					break
				}
				if msg.Uid > lastUID {
					lastUID = msg.Uid
				}
				if syncMaxMessages > 0 && processedCount >= syncMaxMessages {
					reachedLimit = true
					break
				}
				processedCount++
				if stored := storeMessage(accountID, f.ID, msg, section); stored {
					batchCount++
					totalCount++
				} else {
					batchSkipped++
				}
			}

			if reachedCutoff && lastUID == 0 && mbox.UidNext > 1 {
				// The mailbox only had older mail. Mark the first sync as
				// complete so future syncs only look for genuinely new mail.
				lastUID = mbox.UidNext - 1
			}

			log.Printf("imap sync acct%d %s: batch %d-%d done, %d new, %d existing (total %d/%d)",
				accountID, serverName, batchStart, end, batchCount, batchSkipped, totalCount, mbox.Messages)

			// Persist uid_next after each batch for resume.
			if lastUID > 0 {
				_, _ = database.DB.Exec(
					"UPDATE folders SET last_synced_at = ?, uid_next = ? WHERE id = ?",
					time.Now().UTC(), int64(lastUID), f.ID)
			}
			database.SyncProgressSetMulti(accountID, map[string]interface{}{
				"folder_synced": totalCount,
				"last_uid":      lastUID,
				"updated_at":    time.Now().UTC().Format(time.RFC3339),
			})

			if reachedCutoff {
				log.Printf("imap sync acct%d %s: reached syncDays cutoff %s, stopping history backfill",
					accountID, serverName, cutoff.Format("2006-01-02"))
				break
			}
			if reachedLimit {
				log.Printf("imap sync acct%d %s: reached syncMaxMessages=%d, stopping history backfill",
					accountID, serverName, syncMaxMessages)
				break
			}
			// Move to the next batch. Use an explicit guard to
			// prevent unsigned underflow when start < batchSize.
			if batchStart <= 1 {
				break
			}
			start = batchStart - 1
		}

		cleanupOldMessages(accountID, f.ID, serverName, syncDays)
	} else {
		// ── Incremental sync: fetch from LastUID+1 to UidNext-1 ──
		// This naturally covers all messages arrived since the last sync.
		from := f.LastUID + 1
		if from >= mbox.UidNext {
			cleanupOldMessages(accountID, f.ID, serverName, syncDays)
			return 0, mbox.UidNext - 1, nil
		}

		log.Printf("imap sync acct%d %s: incremental sync, UID %d..%d", accountID, serverName, from, mbox.UidNext-1)

		seqSet := new(imap.SeqSet)
		seqSet.AddRange(from, mbox.UidNext-1)

		messages := make(chan *imap.Message, 16)
		errCh := startFetch(c.UidFetch, seqSet, items, messages)

		for msg := range messages {
			if msg == nil {
				continue
			}
			if msg.Uid > lastUID {
				lastUID = msg.Uid
			}
			if stored := storeMessage(accountID, f.ID, msg, section); stored {
				totalCount++
			}
		}
		if err := <-errCh; err != nil {
			return totalCount, lastUID, fmt.Errorf("uid fetch %s: %w", serverName, err)
		}

		database.SyncProgressSetMulti(accountID, map[string]interface{}{
			"folder_synced": totalCount,
			"last_uid":      lastUID,
			"updated_at":    time.Now().UTC().Format(time.RFC3339),
		})

		cleanupOldMessages(accountID, f.ID, serverName, syncDays)
	}

	return totalCount, lastUID, nil
}

func cleanupOldMessages(accountID, folderID int64, serverName string, syncDays int) {
	if syncDays <= 0 {
		return
	}
	cutoff := appclock.StartOfDayDaysAgo(syncDays)
	res, delErr := database.DB.Exec(
		"DELETE FROM messages WHERE account_id = ? AND folder_id = ? AND received_at < ?",
		accountID, folderID, cutoff.Format("2006-01-02"))
	if delErr != nil {
		log.Printf("imap sync acct%d %s: cleanup error: %v", accountID, serverName, delErr)
	} else if n, _ := res.RowsAffected(); n > 0 {
		log.Printf("imap sync acct%d %s: cleaned up %d old messages (older than %s)",
			accountID, serverName, n, cutoff.Format("2006-01-02"))
	}
}

// storeMessage parses one IMAP message and inserts it (if not already
// present). Returns true when a new row was created.
func storeMessage(accountID, folderID int64, msg *imap.Message, section *imap.BodySectionName) bool {
	if msg == nil || msg.Uid == 0 {
		return false
	}

	rawBody := ""
	if r := msg.GetBody(section); r != nil {
		if b, err := io.ReadAll(r); err == nil {
			rawBody = string(b)
		}
	}

	parsed := parseRawMessage(rawBody, msg)

	// Check whether this message is already stored. If it is, we normally
	// skip it — but if the previously stored body looks like undecoded
	// quoted-printable (a pre-fix sync left "=E4=BA=B2..." gibberish),
	// we overwrite the body so the user sees correct text after a re-sync.
	var existingID int64
	var oldBodyText, oldBodyHTML string
	_ = database.DB.QueryRow(
		`SELECT id, COALESCE(body_text,''), COALESCE(body_html,'')
		 FROM messages WHERE account_id = ? AND folder_id = ? AND uid = ?`,
		accountID, folderID, msg.Uid,
	).Scan(&existingID, &oldBodyText, &oldBodyHTML)

	if existingID != 0 {
		// Re-fetch body when:
		// 1. The stored body looks like undecoded quoted-printable (old bug)
		// 2. The body was cleared by the user (storage cleanup / manual clear)
		bodyEmpty := oldBodyText == "" && oldBodyHTML == ""
		if (bodyEmpty || needsBodyRepair(oldBodyText, oldBodyHTML)) && (parsed.bodyText != "" || parsed.bodyHTML != "") {
			_, _ = database.DB.Exec(
				`UPDATE messages SET body_text = ?, body_html = ?, snippet = ?,
				 has_attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
				parsed.bodyText, parsed.bodyHTML, parsed.snippet,
				parsed.hasAttachments, existingID,
			)
			return true
		}
		return false
	}

	_, err := database.DB.Exec(
		`INSERT IGNORE INTO messages
		(account_id, folder_id, uid, message_id, subject,
		 from_address, from_name, to_addresses, cc_addresses, bcc_addresses, reply_to,
		 body_text, body_html, snippet, received_at, sent_at, size,
		 is_read, is_starred, is_answered, is_forwarded, is_draft,
		 has_attachments, labels, in_reply_to, ref_references)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
		accountID, folderID, int64(msg.Uid), parsed.messageID, parsed.subject,
		parsed.fromAddr, parsed.fromName, parsed.toJSON, parsed.ccJSON, "[]", parsed.replyTo,
		parsed.bodyText, parsed.bodyHTML, parsed.snippet, parsed.receivedAt, parsed.sentAt, parsed.size,
		parsed.isRead, parsed.isStarred, parsed.isAnswered, false, parsed.isDraft,
		parsed.hasAttachments, parsed.inReplyTo, parsed.references,
	)
	if err != nil {
		log.Printf("store message uid=%d: %v", msg.Uid, err)
		return false
	}

	// Persist attachments metadata only — content is lazily fetched
	// from IMAP when the user previews or downloads.
	if parsed.hasAttachments && len(parsed.attachments) > 0 {
		var msgDBID int64
		_ = database.DB.QueryRow(
			`SELECT id FROM messages WHERE account_id = ? AND folder_id = ? AND uid = ?`,
			accountID, folderID, msg.Uid,
		).Scan(&msgDBID)
		for _, a := range parsed.attachments {
			_, _ = database.DB.Exec(
				`INSERT INTO attachments (message_id, filename, mime_type, size, content_id, part_id)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				msgDBID, a.filename, a.mimeType, a.size, a.contentID, a.partID,
			)
		}
	}
	return true
}

func messageSyncDate(msg *imap.Message) time.Time {
	if msg == nil {
		return time.Now().UTC()
	}
	if !msg.InternalDate.IsZero() {
		return msg.InternalDate
	}
	if msg.Envelope != nil && !msg.Envelope.Date.IsZero() {
		return msg.Envelope.Date
	}
	return time.Now().UTC()
}

// qpEncodedPattern matches runs of quoted-printable escape sequences such
// as "=E4=BA=B2". A body that contains several of these and no HTML is
// almost certainly a pre-fix sync that stored the raw encoded bytes.
var qpEncodedPattern = regexp.MustCompile(`(?:=[0-9A-Fa-f]{2}){3,}`)

// needsBodyRepair reports whether a previously stored body should be
// overwritten by a freshly parsed one. We only repair when the old text
// body clearly looks like undecoded quoted-printable and there's no HTML
// fallback — that way we never clobber legitimately encoded content.
func needsBodyRepair(bodyText, bodyHTML string) bool {
	if bodyHTML != "" {
		return false
	}
	return qpEncodedPattern.MatchString(bodyText)
}

/* ----------------------- RFC822 parsing ----------------------- */

type parsedMessage struct {
	messageID      string
	subject        string
	fromAddr       string
	fromName       string
	toJSON         string
	ccJSON         string
	replyTo        string
	bodyText       string
	bodyHTML       string
	snippet        string
	receivedAt     time.Time
	sentAt         sql.NullTime
	size           int64
	isRead         bool
	isStarred      bool
	isAnswered     bool
	isDraft        bool
	hasAttachments bool
	inReplyTo      string
	references     string
	attachments    []attMeta
}

type attMeta struct {
	filename  string
	mimeType  string
	size      int64
	partID    string
	contentID string
}

func parseRawMessage(raw string, msg *imap.Message) parsedMessage {
	out := parsedMessage{}

	// Envelope-backed fields (authoritative when available).
	if env := msg.Envelope; env != nil {
		out.messageID = strings.TrimSpace(env.MessageId)
		out.subject = mimeHeaderDecode(env.Subject)
		out.inReplyTo = strings.TrimSpace(env.InReplyTo)
		if env.Date.IsZero() {
			out.sentAt.Valid = false
		} else {
			out.sentAt.Valid = true
			out.sentAt.Time = env.Date
		}
		out.fromAddr, out.fromName = pickAddress(env.From)
		out.toJSON = addressesToJSON(env.To)
		out.ccJSON = addressesToJSON(env.Cc)
		if len(env.ReplyTo) > 0 {
			_, out.replyTo = pickAddress(env.ReplyTo)
		}
	}

	// Flags → read/starred/answered/draft.
	for _, f := range msg.Flags {
		switch f {
		case imap.SeenFlag:
			out.isRead = true
		case imap.FlaggedFlag:
			out.isStarred = true
		case imap.AnsweredFlag:
			out.isAnswered = true
		case imap.DraftFlag:
			out.isDraft = true
		}
	}
	// Fallback: some IMAP servers strip the \Draft flag. Detect MailGo's
	// synthetic draft Message-ID and force isDraft = true.
	if !out.isDraft && strings.HasPrefix(out.messageID, "mailgo-draft-") &&
		strings.HasSuffix(out.messageID, "@mailgo.local") {
		out.isDraft = true
	}

	if !msg.InternalDate.IsZero() {
		out.receivedAt = msg.InternalDate
	} else {
		out.receivedAt = time.Now().UTC()
	}
	out.size = int64(msg.Size)

	// Parse the raw RFC822 body for text/html + attachments.
	if raw != "" {
		body, html, atts := extractParts(raw)
		if out.bodyText == "" {
			out.bodyText = body
		}
		out.bodyHTML = html
		out.attachments = atts
		out.hasAttachments = len(atts) > 0
		// References isn't part of the IMAP envelope in go-imap v1,
		// pull it from the raw RFC822 headers instead.
		if m, err := mail.ReadMessage(strings.NewReader(raw)); err == nil {
			out.references = strings.TrimSpace(m.Header.Get("References"))
		}
	}

	out.snippet = makeSnippet(out.bodyText)
	return out
}

// pickAddress extracts a single address pair from an imap.Address slice.
func pickAddress(addrs []*imap.Address) (addr, name string) {
	if len(addrs) == 0 {
		return "", ""
	}
	a := addrs[0]
	full := strings.TrimSpace(a.MailboxName + "@" + a.HostName)
	return full, mimeHeaderDecode(a.PersonalName)
}

// addressesToJSON encodes an address list as the JSON array string the
// schema expects (matches the MessageAddress shape on the frontend).
func addressesToJSON(addrs []*imap.Address) string {
	type entry struct {
		Name    string `json:"name,omitempty"`
		Address string `json:"address"`
	}
	out := make([]entry, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, entry{
			Name:    mimeHeaderDecode(a.PersonalName),
			Address: strings.TrimSpace(a.MailboxName + "@" + a.HostName),
		})
	}
	b, err := json.Marshal(out)
	if err != nil {
		return "[]"
	}
	return string(b)
}

// mimeHeaderDecode decodes RFC 2047 encoded-words ("=?utf-8?B?...?=").
// We rely on charset.CharsetReader for non-UTF encodings.
func mimeHeaderDecode(s string) string {
	if s == "" {
		return ""
	}
	dec := new(mime.WordDecoder)
	dec.CharsetReader = charset.Reader
	out, err := dec.DecodeHeader(s)
	if err != nil || out == "" {
		return s
	}
	return out
}

// decodeReader wraps a part reader so its bytes are decoded according to
// the Content-Transfer-Encoding header (base64 / quoted-printable).
func decodeReader(r io.Reader, cte string) io.Reader {
	switch cte {
	case "base64":
		return base64.NewDecoder(base64.StdEncoding, r)
	case "quoted-printable":
		return quotedprintable.NewReader(r)
	default:
		return r
	}
}

// extractParts walks a raw RFC822 message to pull out the plain text body,
// the HTML body, and attachment metadata.
func extractParts(raw string) (text, html string, attachments []attMeta) {
	// Re-parse via net/mail to get a reliable message structure.
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		return "", "", nil
	}

	mediaType, params, _ := mime.ParseMediaType(m.Header.Get("Content-Type"))
	// The top-level Content-Transfer-Encoding applies to non-multipart
	// messages. Without it, quoted-printable / base64 bodies would be
	// stored verbatim and show up as "=E4=BA=B2..." gibberish.
	cte := strings.ToLower(m.Header.Get("Content-Transfer-Encoding"))
	text, html, attachments = walkParts(m.Body, mediaType, params, cte, textproto.MIMEHeader(m.Header), "")
	return
}

// walkParts recursively extracts text/html/attachments from a multipart tree.
// The cte argument is the Content-Transfer-Encoding of the passed body; it is
// only meaningful for non-multipart parts (the multipart container itself is
// always 7bit/8bit). partIndex tracks the current MIME part number for
// hierarchical part_id assignment (e.g. "1", "2.1", "2.2.3").
func walkParts(body io.Reader, mediaType string, params map[string]string, cte string, msgHeader textproto.MIMEHeader, partIndex string) (string, string, []attMeta) {
	var text, html string
	var atts []attMeta

	if strings.HasPrefix(mediaType, "multipart/") {
		mr := multipart.NewReader(body, params["boundary"])
		idx := 0
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			idx++
			childIndex := partIndex
			if childIndex == "" {
				childIndex = fmt.Sprintf("%d", idx)
			} else {
				childIndex = fmt.Sprintf("%s.%d", partIndex, idx)
			}
			pMediaType, pParams, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
			pCTE := strings.ToLower(p.Header.Get("Content-Transfer-Encoding"))
			partReader := decodeReader(p, pCTE)

			if strings.HasPrefix(pMediaType, "multipart/") {
				// Recurse into nested multipart (e.g. multipart/mixed → multipart/alternative).
				t, h, a := walkParts(partReader, pMediaType, pParams, pCTE, p.Header, childIndex)
				if t != "" && text == "" {
					text = t
				}
				if h != "" && html == "" {
					html = h
				}
				atts = append(atts, a...)
				continue
			}

			disposition, dParams, _ := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
			filename := pParams["name"]
			if fn := dParams["filename"]; fn != "" {
				filename = fn
			}

			cid := p.Header.Get("Content-ID")
			cid = strings.Trim(cid, "<>")

			if disposition == "attachment" || disposition == "inline" || filename != "" || cid != "" {
				// Read decoded content to determine actual size, then
				// discard. The content itself is lazily fetched from IMAP
				// when the user clicks to preview or download.
				contentBytes, _ := io.ReadAll(partReader)
				actualSize := int64(len(contentBytes))

				// For inline images without a filename, generate one from the Content-Type.
				if filename == "" {
					ext := extensionForMIME(pMediaType)
					filename = "inline" + ext
				}
				atts = append(atts, attMeta{
					filename:  mimeHeaderDecode(filename),
					mimeType:  pMediaType,
					size:      actualSize,
					partID:    childIndex,
					contentID: cid,
				})
				continue
			}

			switch pMediaType {
			case "text/plain":
				b, _ := io.ReadAll(partReader)
				if text == "" {
					text = strings.TrimSpace(string(b))
				}
			case "text/html":
				b, _ := io.ReadAll(partReader)
				if html == "" {
					html = strings.TrimSpace(string(b))
				}
			}
		}
	} else {
		// Non-multipart message: the whole body is a single part. Decode
		// it according to the (top-level) Content-Transfer-Encoding.
		decoded := decodeReader(body, cte)

		// Check Content-Disposition — if it's an attachment, or the
		// media type is non-text (e.g. application/zip), treat the
		// entire message body as a single attachment.  This covers
		// DMARC reports, calendar invites, and similar mails that
		// carry no text body, only a binary payload.
		disposition, dParams, _ := mime.ParseMediaType(msgHeader.Get("Content-Disposition"))
		filename := params["name"]
		if fn := dParams["filename"]; fn != "" {
			filename = fn
		}
		isAttachment := disposition == "attachment" || filename != ""

		if isAttachment || (!strings.HasPrefix(mediaType, "text/") && mediaType != "") {
			if filename == "" {
				filename = "attachment"
			}
			// Read to determine actual size, then discard.
			contentBytes, _ := io.ReadAll(decoded)
			actualSize := int64(len(contentBytes))
			cid := msgHeader.Get("Content-ID")
			cid = strings.Trim(cid, "<>")
			atts = append(atts, attMeta{
				filename:  mimeHeaderDecode(filename),
				mimeType:  mediaType,
				size:      actualSize,
				partID:    partIndex + "1",
				contentID: cid,
			})
		} else {
			b, _ := io.ReadAll(decoded)
			switch mediaType {
			case "text/plain", "":
				text = strings.TrimSpace(string(b))
			case "text/html":
				html = strings.TrimSpace(string(b))
			}
		}
	}

	return text, html, atts
}

// makeSnippet produces a short preview of the body for list views.
func makeSnippet(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 160 {
		return s[:160] + "…"
	}
	return s
}

// repairCandidate is one message whose stored body looks like undecoded QP
// and should be re-fetched from the server.
type repairCandidate struct {
	ID, AccountID, FolderID, UID int64
	FolderName                   string
}

// RepairGarbledBodies scans all stored messages whose body text looks like
// undecoded quoted-printable ("=E4=BA=B2..." gibberish), re-fetches the raw
// RFC822 from the IMAP server, and overwrites the stored body with a freshly
// parsed version. This fixes messages that were synced by an older version
// of the parser before QP decoding was added.
//
// It connects to each account once and repairs all affected messages in
// every folder. Returns the number of messages repaired.
func RepairGarbledBodies() int {
	// We can't use REGEXP (not enabled in modernc sqlite by default), so we
	// fetch all text-only messages and filter in Go with the QP pattern.
	rows, err := database.DB.Query(
		`SELECT m.id, m.account_id, m.folder_id, m.uid, f.name, m.body_text
		 FROM messages m
		 JOIN folders f ON m.folder_id = f.id
		 WHERE (m.body_html IS NULL OR m.body_html = '')
		   AND m.body_text LIKE '%=%'`)
	if err != nil {
		log.Printf("RepairGarbledBodies query: %v", err)
		return 0
	}

	var candidates []repairCandidate
	for rows.Next() {
		var c repairCandidate
		var bodyText string
		if err := rows.Scan(&c.ID, &c.AccountID, &c.FolderID, &c.UID, &c.FolderName, &bodyText); err != nil {
			continue
		}
		// Only repair bodies that contain 3+ consecutive QP escape sequences.
		if qpEncodedPattern.MatchString(bodyText) {
			candidates = append(candidates, c)
		}
	}
	rows.Close()

	if len(candidates) == 0 {
		return 0
	}

	// Group candidates by account so we only open one IMAP connection each.
	byAccount := make(map[int64][]repairCandidate)
	for _, c := range candidates {
		byAccount[c.AccountID] = append(byAccount[c.AccountID], c)
	}

	total := 0
	for accountID, msgs := range byAccount {
		configs, err := LoadAccountConfigs(accountID)
		if err != nil || len(configs) == 0 {
			continue
		}
		cfg := configs[0]

		c, err := Connect(cfg)
		if err != nil {
			log.Printf("RepairGarbledBodies connect account %d: %v", accountID, err)
			continue
		}

		mailboxes, err := FetchMailboxInfos(c)
		if err != nil {
			disconnect(c)
			continue
		}
		serverSet := make(map[string]bool, len(mailboxes))
		for _, mb := range mailboxes {
			serverSet[normalizeMailboxName(mb.Name)] = true
		}

		// Group by folder within the account so we only SELECT each mailbox once.
		byFolder := make(map[int64][]repairCandidate)
		for _, m := range msgs {
			byFolder[m.FolderID] = append(byFolder[m.FolderID], m)
		}

		for _, folderMsgs := range byFolder {
			if len(folderMsgs) == 0 {
				continue
			}
			serverName := resolveServerFolderName(folderMsgs[0].FolderName, "", serverSet, mailboxes)
			if serverName == "" {
				continue
			}
			n := repairFolderMessages(c, folderMsgs, serverName)
			total += n
		}
		disconnect(c)
	}
	if total > 0 {
		log.Printf("RepairGarbledBodies: repaired %d message(s)", total)
	}
	return total
}

// repairFolderMessages re-fetches and re-parses a set of messages from one
// mailbox, overwriting their stored body text/html/snippet.
func repairFolderMessages(c *client.Client, msgs []repairCandidate, serverName string) int {
	mbox, err := c.Select(serverName, true)
	if err != nil {
		log.Printf("repair select %s: %v", serverName, err)
		return 0
	}
	if mbox.Messages == 0 {
		return 0
	}

	section := &imap.BodySectionName{Peek: true}
	items := []imap.FetchItem{
		imap.FetchUid,
		section.FetchItem(),
	}

	// Build a UID set of just the messages we need to repair.
	seqSet := new(imap.SeqSet)
	uidToID := make(map[uint32]int64, len(msgs))
	for _, m := range msgs {
		seqSet.AddNum(uint32(m.UID))
		uidToID[uint32(m.UID)] = m.ID
	}

	ch := make(chan *imap.Message, 16)
	go func() {
		if err := c.UidFetch(seqSet, items, ch); err != nil {
			log.Printf("repair uid fetch %s: %v", serverName, err)
		}
	}()

	repaired := 0
	for msg := range ch {
		if msg == nil || msg.Uid == 0 {
			continue
		}
		dbID, ok := uidToID[msg.Uid]
		if !ok {
			continue
		}
		rawBody := ""
		if r := msg.GetBody(section); r != nil {
			if b, err := io.ReadAll(r); err == nil {
				rawBody = string(b)
			}
		}
		if rawBody == "" {
			continue
		}
		parsed := parseRawMessage(rawBody, msg)
		if parsed.bodyText == "" && parsed.bodyHTML == "" {
			continue
		}
		_, _ = database.DB.Exec(
			`UPDATE messages SET body_text = ?, body_html = ?, snippet = ?,
			 has_attachments = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
			parsed.bodyText, parsed.bodyHTML, parsed.snippet,
			parsed.hasAttachments, dbID,
		)
		repaired++
	}
	return repaired
}

// LoadAccountConfigs reads the IMAP connection parameters for one (when
// accountID > 0) or all accounts from the database. The password column
// is encrypted at rest; it is transparently decrypted here.
// Accounts without a host or password are skipped because they could never
// connect.
func LoadAccountConfigs(accountID int64) ([]AccountConfig, error) {
	query := `SELECT id, imap_host, imap_port, imap_tls, COALESCE(imap_encryption, ''), username,
		COALESCE(provider, ''),
		COALESCE(password_encrypted, ''), COALESCE(sync_days, 0), COALESCE(sync_max_messages, 0) FROM accounts`
	args := []interface{}{}
	if accountID > 0 {
		query += ` WHERE id = ?`
		args = append(args, accountID)
	}
	query += ` ORDER BY id`

	rows, err := database.DB.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AccountConfig
	for rows.Next() {
		var cfg AccountConfig
		var provider string
		if err := rows.Scan(&cfg.ID, &cfg.Host, &cfg.Port, &cfg.TLS, &cfg.Encryption, &cfg.Username, &provider, &cfg.Password, &cfg.SyncDays, &cfg.SyncMaxMessages); err != nil {
			return nil, err
		}
		if dec, err := crypto.Decrypt(cfg.Password); err == nil {
			cfg.Password = dec
		} else {
			log.Printf("LoadAccountConfigs: decrypt password for account %d: %v", cfg.ID, err)
		}
		if provider == "microsoft" {
			token, err := microsoftauth.AccessTokenForAccount(context.Background(), cfg.ID)
			if err != nil {
				log.Printf("LoadAccountConfigs: Microsoft token for account %d: %v", cfg.ID, err)
				continue
			}
			cfg.OAuthToken = token
		}
		if cfg.Host == "" || cfg.Username == "" || (cfg.Password == "" && cfg.OAuthToken == "") {
			continue
		}
		out = append(out, cfg)
	}
	return out, rows.Err()
}

// extensionForMIME returns a file extension (with dot) for common image MIME types.
func extensionForMIME(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "image/png":
		return ".png"
	case "image/jpeg", "image/jpg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	case "image/svg+xml":
		return ".svg"
	case "image/bmp":
		return ".bmp"
	case "image/tiff":
		return ".tiff"
	default:
		return ".bin"
	}
}
