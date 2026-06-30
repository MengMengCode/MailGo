package imap

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"mime"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"time"

	"mailgo/internal/database"

	goimap "github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
)

type remoteDraftCopy struct {
	ID             int64
	DraftID        sql.NullInt64
	Mailbox        string
	UID            int64
	MessageID      string
	SyncedRevision int64
	AccountID      sql.NullInt64
	IsTrashed      sql.NullBool
	Revision       sql.NullInt64
}

type localDraftSnapshot struct {
	ID           int64
	AccountID    int64
	ToAddresses  string
	CcAddresses  string
	BccAddresses string
	Subject      string
	BodyHTML     string
	BodyText     string
	InReplyTo    string
	References   string
	Revision     int64
	UpdatedAt    time.Time
}

type draftLiteral struct {
	*bytes.Reader
	size int
}

func newDraftLiteral(data []byte) *draftLiteral {
	return &draftLiteral{Reader: bytes.NewReader(data), size: len(data)}
}

func (l *draftLiteral) Len() int { return l.size }

// PushLocalDrafts reconciles local drafts with their selected account's
// remote Drafts mailbox. The local drafts table is the source of truth:
// remote copies are replaced when content/account changes and removed when
// the local draft is trashed or permanently deleted.
func PushLocalDrafts() {
	accountIDs, err := draftSyncAccountIDs()
	if err != nil {
		log.Printf("draft sync: list accounts: %v", err)
		return
	}
	// Two phases are important when drafts swap accounts: all old copies
	// must be removed before any new copy is inserted, regardless of account
	// ID ordering.
	for _, accountID := range accountIDs {
		if err := syncAccountDrafts(accountID, false); err != nil {
			log.Printf("draft sync: clean account %d: %v", accountID, err)
		}
	}
	for _, accountID := range accountIDs {
		if err := syncAccountDrafts(accountID, true); err != nil {
			log.Printf("draft sync: append account %d: %v", accountID, err)
		}
	}
}

func draftSyncAccountIDs() ([]int64, error) {
	rows, err := database.DB.Query(`
		SELECT DISTINCT account_id FROM (
			SELECT account_id FROM drafts WHERE account_id IS NOT NULL AND is_trashed = 0
			UNION
			SELECT account_id FROM draft_remote_copies
		) accounts ORDER BY account_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func syncAccountDrafts(accountID int64, appendMissing bool) error {
	configs, err := LoadAccountConfigs(accountID)
	if err != nil || len(configs) == 0 {
		if err == nil {
			err = fmt.Errorf("account configuration not found")
		}
		return err
	}
	c, err := Connect(configs[0])
	if err != nil {
		return err
	}
	defer disconnect(c)

	mailboxes, err := FetchMailboxInfos(c)
	if err != nil {
		return err
	}
	draftsMailbox, err := ensureDraftsMailbox(c, mailboxes)
	if err != nil {
		return err
	}

	if appendMissing {
		drafts, err := loadUnsyncedDrafts(accountID)
		if err != nil {
			return err
		}
		for _, draft := range drafts {
			if err := appendRemoteDraft(c, draftsMailbox, draft); err != nil {
				log.Printf("draft sync: append draft %d: %v", draft.ID, err)
			}
		}
		return nil
	}

	copies, err := loadRemoteDraftCopies(accountID)
	if err != nil {
		return err
	}
	for _, copy := range copies {
		if !remoteDraftCopyIsStale(copy, accountID) {
			continue
		}
		mailbox := copy.Mailbox
		if mailbox == "" {
			mailbox = draftsMailbox
		}
		if err := deleteRemoteDraft(c, mailbox, copy.MessageID, copy.UID); err != nil {
			log.Printf("draft sync: delete copy %d: %v", copy.ID, err)
			continue
		}
		// Incremental IMAP sync does not discover expunged UIDs, so remove
		// the cached mirror row explicitly when replacing/deleting a draft.
		// Delete from ANY folder, not just drafts — Gmail's All Mail / Archive
		// may also contain a copy of the synced-back draft.
		_, _ = database.DB.Exec(`
			DELETE FROM messages
			WHERE account_id = ? AND uid = ?`,
			accountID, copy.UID)
		if _, err := database.DB.Exec("DELETE FROM draft_remote_copies WHERE id = ?", copy.ID); err != nil {
			return err
		}
	}
	return nil
}

func ensureDraftsMailbox(c *client.Client, mailboxes []ServerMailbox) (string, error) {
	serverSet := make(map[string]bool, len(mailboxes))
	for _, mailbox := range mailboxes {
		serverSet[normalizeMailboxName(mailbox.Name)] = true
	}
	if name := resolveServerFolderName("Drafts", "drafts", serverSet, mailboxes); name != "" {
		return name, nil
	}
	if err := c.Create("Drafts"); err != nil {
		return "", fmt.Errorf("create Drafts mailbox: %w", err)
	}
	return "Drafts", nil
}

func loadRemoteDraftCopies(accountID int64) ([]remoteDraftCopy, error) {
	rows, err := database.DB.Query(`
		SELECT rc.id, rc.draft_id, rc.mailbox, rc.uid, rc.message_id, rc.synced_revision,
		       d.account_id, d.is_trashed, d.sync_revision
		FROM draft_remote_copies rc
		LEFT JOIN drafts d ON d.id = rc.draft_id
		WHERE rc.account_id = ?
		ORDER BY rc.id`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var copies []remoteDraftCopy
	for rows.Next() {
		var copy remoteDraftCopy
		if err := rows.Scan(
			&copy.ID, &copy.DraftID, &copy.Mailbox, &copy.UID, &copy.MessageID,
			&copy.SyncedRevision, &copy.AccountID, &copy.IsTrashed, &copy.Revision,
		); err != nil {
			return nil, err
		}
		copies = append(copies, copy)
	}
	return copies, rows.Err()
}

func remoteDraftCopyIsStale(copy remoteDraftCopy, remoteAccountID int64) bool {
	return !copy.DraftID.Valid ||
		!copy.AccountID.Valid ||
		copy.AccountID.Int64 != remoteAccountID ||
		!copy.IsTrashed.Valid ||
		copy.IsTrashed.Bool ||
		!copy.Revision.Valid ||
		copy.Revision.Int64 != copy.SyncedRevision
}

func loadUnsyncedDrafts(accountID int64) ([]localDraftSnapshot, error) {
	rows, err := database.DB.Query(`
		SELECT d.id, d.account_id, d.to_addresses, d.cc_addresses, d.bcc_addresses,
		       d.subject, COALESCE(d.body_html, ''), COALESCE(d.body_text, ''),
		       COALESCE(d.in_reply_to, ''), COALESCE(d.ref_references, ''),
		       d.sync_revision, d.updated_at
		FROM drafts d
		LEFT JOIN draft_remote_copies rc ON rc.draft_id = d.id
		WHERE d.account_id = ? AND d.is_trashed = 0 AND rc.id IS NULL
		ORDER BY d.id`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var drafts []localDraftSnapshot
	for rows.Next() {
		var draft localDraftSnapshot
		if err := rows.Scan(
			&draft.ID, &draft.AccountID, &draft.ToAddresses, &draft.CcAddresses,
			&draft.BccAddresses, &draft.Subject, &draft.BodyHTML, &draft.BodyText,
			&draft.InReplyTo, &draft.References, &draft.Revision, &draft.UpdatedAt,
		); err != nil {
			return nil, err
		}
		drafts = append(drafts, draft)
	}
	return drafts, rows.Err()
}

func appendRemoteDraft(c *client.Client, mailbox string, draft localDraftSnapshot) error {
	messageID := fmt.Sprintf("<mailgo-draft-%d-r%d@mailgo.local>", draft.ID, draft.Revision)
	if uid, err := findRemoteDraftUID(c, mailbox, messageID); err == nil && uid != 0 {
		return saveRemoteDraftCopy(draft, mailbox, uid, messageID)
	}

	fromName, fromAddress, err := draftSender(draft.AccountID)
	if err != nil {
		return err
	}
	raw, err := buildRemoteDraftMIME(draft, fromName, fromAddress, messageID)
	if err != nil {
		return err
	}
	if err := c.Append(
		mailbox,
		[]string{goimap.DraftFlag, goimap.SeenFlag},
		draft.UpdatedAt,
		newDraftLiteral(raw),
	); err != nil {
		return fmt.Errorf("append to %s: %w", mailbox, err)
	}

	uid, err := findRemoteDraftUID(c, mailbox, messageID)
	if err != nil {
		return fmt.Errorf("find appended draft: %w", err)
	}
	if uid == 0 {
		return fmt.Errorf("appended draft was not found by Message-ID")
	}
	if err := saveRemoteDraftCopy(draft, mailbox, uid, messageID); err != nil {
		_ = deleteRemoteDraft(c, mailbox, messageID, int64(uid))
		return err
	}
	return nil
}

func saveRemoteDraftCopy(draft localDraftSnapshot, mailbox string, uid uint32, messageID string) error {
	_, err := database.DB.Exec(`
		INSERT INTO draft_remote_copies
			(draft_id, account_id, mailbox, uid, message_id, synced_revision)
		VALUES (?, ?, ?, ?, ?, ?)`,
		draft.ID, draft.AccountID, mailbox, int64(uid), messageID, draft.Revision)
	return err
}

func findRemoteDraftUID(c *client.Client, mailbox, messageID string) (uint32, error) {
	if _, err := c.Select(mailbox, true); err != nil {
		return 0, err
	}
	criteria := goimap.NewSearchCriteria()
	criteria.Header.Set("Message-ID", messageID)
	uids, err := c.UidSearch(criteria)
	if err != nil {
		return 0, err
	}
	var newest uint32
	for _, uid := range uids {
		if uid > newest {
			newest = uid
		}
	}
	return newest, nil
}

func deleteRemoteDraft(c *client.Client, mailbox, messageID string, fallbackUID int64) error {
	if _, err := c.Select(mailbox, false); err != nil {
		// A missing mailbox means the remote copy is already gone.
		if strings.Contains(strings.ToLower(err.Error()), "not exist") {
			return nil
		}
		return err
	}

	criteria := goimap.NewSearchCriteria()
	criteria.Header.Set("Message-ID", messageID)
	uids, err := c.UidSearch(criteria)
	if err != nil && fallbackUID > 0 {
		uids = []uint32{uint32(fallbackUID)}
	} else if err != nil {
		return err
	}
	if len(uids) == 0 {
		return nil
	}

	set := new(goimap.SeqSet)
	for _, uid := range uids {
		set.AddNum(uid)
	}
	if err := c.UidStore(set, goimap.AddFlags, []interface{}{goimap.DeletedFlag}, nil); err != nil {
		return err
	}
	return c.Expunge(nil)
}

func draftSender(accountID int64) (string, string, error) {
	var name, address string
	err := database.DB.QueryRow(
		`SELECT name, COALESCE(NULLIF(sender_email, ''), email) FROM accounts WHERE id = ?`,
		accountID,
	).Scan(&name, &address)
	return name, address, err
}

func buildRemoteDraftMIME(
	draft localDraftSnapshot,
	fromName, fromAddress, messageID string,
) ([]byte, error) {
	headers := []string{
		"From: " + (&mail.Address{Name: fromName, Address: fromAddress}).String(),
		"Subject: " + mime.QEncoding.Encode("utf-8", sanitizeDraftHeader(draft.Subject)),
		"Date: " + draft.UpdatedAt.Format(time.RFC1123Z),
		"Message-ID: " + messageID,
		"MIME-Version: 1.0",
		"X-MailGo-Draft-ID: " + fmt.Sprint(draft.ID),
	}
	if value := draftAddressHeader(draft.ToAddresses); value != "" {
		headers = append(headers, "To: "+value)
	}
	if value := draftAddressHeader(draft.CcAddresses); value != "" {
		headers = append(headers, "Cc: "+value)
	}
	if value := draftAddressHeader(draft.BccAddresses); value != "" {
		headers = append(headers, "Bcc: "+value)
	}
	if value := sanitizeDraftHeader(draft.InReplyTo); value != "" {
		headers = append(headers, "In-Reply-To: "+value)
	}
	if value := sanitizeDraftHeader(draft.References); value != "" {
		headers = append(headers, "References: "+value)
	}

	contentType := "text/plain"
	body := draft.BodyText
	if draft.BodyHTML != "" {
		contentType = "text/html"
		body = draft.BodyHTML
	} else if body == "" {
		body = html.EscapeString(draft.BodyText)
	}

	var out bytes.Buffer
	for _, header := range headers {
		out.WriteString(header + "\r\n")
	}
	out.WriteString("Content-Type: " + contentType + "; charset=utf-8\r\n")
	out.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	writer := quotedprintable.NewWriter(&out)
	if _, err := writer.Write([]byte(body)); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func draftAddressHeader(raw string) string {
	type addressObject struct {
		Name    string `json:"name"`
		Address string `json:"address"`
	}
	var objects []addressObject
	if err := json.Unmarshal([]byte(raw), &objects); err == nil {
		values := make([]string, 0, len(objects))
		for _, item := range objects {
			if strings.TrimSpace(item.Address) == "" {
				continue
			}
			values = append(values, (&mail.Address{Name: item.Name, Address: item.Address}).String())
		}
		return strings.Join(values, ", ")
	}

	var stringsList []string
	if err := json.Unmarshal([]byte(raw), &stringsList); err != nil {
		return ""
	}
	values := make([]string, 0, len(stringsList))
	for _, value := range stringsList {
		if parsed, err := mail.ParseAddress(value); err == nil {
			values = append(values, parsed.String())
		} else if strings.TrimSpace(value) != "" {
			values = append(values, sanitizeDraftHeader(value))
		}
	}
	return strings.Join(values, ", ")
}

func sanitizeDraftHeader(value string) string {
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}
