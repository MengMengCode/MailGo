package imap

import (
	"database/sql"
	"fmt"
	"log"
	"time"

	"mailgo/internal/database"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
)

// pendingOp is one row from pending_remote_ops that hasn't been applied
// to the IMAP server yet.
type pendingOp struct {
	ID        int64
	AccountID int64
	MessageID int64
	Action    string
	Payload   string
}

// PushResult summarises a single push run.
type PushResult struct {
	AccountID int64
	Processed int
	Failed    int
}

// PushPendingOps processes all pending remote operations by applying them
// to the IMAP server. Operations are grouped by account so we only open
// one connection per account. Successfully applied ops are marked "done";
// failed ops are marked "failed" and left for the next cycle to retry.
func PushPendingOps() []PushResult {
	rows, err := database.DB.Query(
		`SELECT DISTINCT account_id FROM pending_remote_ops WHERE status = 'pending' ORDER BY account_id`,
	)
	if err != nil {
		log.Printf("PushPendingOps query accounts: %v", err)
		return nil
	}
	var accountIDs []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			continue
		}
		accountIDs = append(accountIDs, id)
	}
	rows.Close()

	var results []PushResult
	for _, accountID := range accountIDs {
		r := pushAccountOps(accountID)
		if r.Processed > 0 {
			results = append(results, r)
		}
	}
	return results
}

// pushAccountOps connects to one account and drains its pending ops.
func pushAccountOps(accountID int64) PushResult {
	res := PushResult{AccountID: accountID}

	ops, err := loadPendingOps(accountID)
	if err != nil || len(ops) == 0 {
		return res
	}

	configs, err := LoadAccountConfigs(accountID)
	if err != nil || len(configs) == 0 {
		return res
	}
	cfg := configs[0]

	c, err := Connect(cfg)
	if err != nil {
		log.Printf("PushPendingOps connect account %d: %v", accountID, err)
		return res
	}
	defer disconnect(c)

	serverMailboxes, err := FetchMailboxInfos(c)
	if err != nil {
		log.Printf("PushPendingOps list mailboxes account %d: %v", accountID, err)
		return res
	}
	serverSet := make(map[string]bool, len(serverMailboxes))
	for _, mb := range serverMailboxes {
		serverSet[normalizeMailboxName(mb.Name)] = true
	}

	for _, op := range ops {
		res.Processed++
		if err := applyOp(c, op, serverSet, serverMailboxes); err != nil {
			res.Failed++
			log.Printf("PushPendingOps op %d (%s) msg %d account %d: %v",
				op.ID, op.Action, op.MessageID, accountID, err)
			markOpStatus(op.ID, "failed")
			continue
		}
		markOpStatus(op.ID, "done")
	}
	return res
}

func loadPendingOps(accountID int64) ([]pendingOp, error) {
	rows, err := database.DB.Query(
		`SELECT id, account_id, message_id, action, payload
		 FROM pending_remote_ops
		 WHERE account_id = ? AND status = 'pending'
		 ORDER BY id`,
		accountID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ops []pendingOp
	for rows.Next() {
		var op pendingOp
		if err := rows.Scan(&op.ID, &op.AccountID, &op.MessageID, &op.Action, &op.Payload); err != nil {
			return nil, err
		}
		ops = append(ops, op)
	}
	return ops, rows.Err()
}

func markOpStatus(id int64, status string) {
	database.DB.Exec(
		`UPDATE pending_remote_ops SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		status, id,
	)
}

// applyOp dispatches a single operation to the appropriate IMAP command.
func applyOp(c *client.Client, op pendingOp, serverSet map[string]bool, serverMailboxes []ServerMailbox) error {
	var uid int64
	var folderID int64
	var prevFolderID sql.NullInt64
	var messageIDHeader string
	if err := database.DB.QueryRow(
		`SELECT uid, folder_id, previous_folder_id, COALESCE(message_id, '')
		 FROM messages WHERE id = ?`,
		op.MessageID,
	).Scan(&uid, &folderID, &prevFolderID, &messageIDHeader); err != nil {
		if err == sql.ErrNoRows {
			return nil // message already gone, nothing to sync
		}
		return fmt.Errorf("load message: %w", err)
	}

	// Locally-created messages (e.g. sent mail) have no IMAP UID.
	if uid == 0 {
		return nil
	}

	switch op.Action {
	case "toggle_read", "mark_read", "mark_unread":
		var isRead bool
		database.DB.QueryRow("SELECT is_read FROM messages WHERE id = ?", op.MessageID).Scan(&isRead)
		return applyFlagSet(c, folderID, uid, imap.SeenFlag, isRead, serverSet, serverMailboxes)

	case "toggle_star", "star", "unstar":
		var isStarred bool
		database.DB.QueryRow("SELECT is_starred FROM messages WHERE id = ?", op.MessageID).Scan(&isStarred)
		return applyFlagSet(c, folderID, uid, imap.FlaggedFlag, isStarred, serverSet, serverMailboxes)

	case "move_to_trash", "move_archive", "move", "restore":
		return applyMove(c, op.MessageID, folderID, prevFolderID, uid, messageIDHeader, serverSet, serverMailboxes)

	case "permanent_delete":
		return applyPermanentDelete(c, op.MessageID, folderID, uid, serverSet, serverMailboxes)

	default:
		return fmt.Errorf("unknown action: %s", op.Action)
	}
}

// applyFlagSet adds or removes an IMAP flag on a message by UID.
func applyFlagSet(c *client.Client, folderID, uid int64, flag string, desired bool, serverSet map[string]bool, serverMailboxes []ServerMailbox) error {
	serverName, err := resolveFolderServerName(folderID, serverSet, serverMailboxes)
	if err != nil {
		return err
	}
	if _, err := c.Select(serverName, false); err != nil {
		return fmt.Errorf("select %s: %w", serverName, err)
	}

	seqSet := new(imap.SeqSet)
	seqSet.AddNum(uint32(uid))

	item := imap.StoreItem(imap.AddFlags)
	if !desired {
		item = imap.StoreItem(imap.RemoveFlags)
	}
	if err := c.UidStore(seqSet, item, []interface{}{flag}, nil); err != nil {
		return fmt.Errorf("uidstore %s: %w", flag, err)
	}
	return nil
}

// applyMove moves a message from its previous folder to its current folder
// on the IMAP server, then updates the local UID to match the new copy.
func applyMove(c *client.Client, messageID, targetFolderID int64, sourceFolderID sql.NullInt64, uid int64, messageIDHeader string, serverSet map[string]bool, serverMailboxes []ServerMailbox) error {
	if !sourceFolderID.Valid || sourceFolderID.Int64 == 0 {
		return fmt.Errorf("no source folder recorded for move")
	}

	sourceServerName, err := resolveFolderServerName(sourceFolderID.Int64, serverSet, serverMailboxes)
	if err != nil {
		return err
	}
	targetServerName, err := resolveFolderServerName(targetFolderID, serverSet, serverMailboxes)
	if err != nil {
		return err
	}

	// Select the source mailbox where the UID is valid.
	if _, err := c.Select(sourceServerName, false); err != nil {
		return fmt.Errorf("select source %s: %w", sourceServerName, err)
	}

	seqSet := new(imap.SeqSet)
	seqSet.AddNum(uint32(uid))

	// Prefer the MOVE extension (single round-trip, server-side optimised).
	if err := c.UidMove(seqSet, targetServerName); err != nil {
		// Fallback: COPY + \Deleted + EXPUNGE (works on all servers).
		if err := c.UidCopy(seqSet, targetServerName); err != nil {
			return fmt.Errorf("copy to %s: %w", targetServerName, err)
		}
		if err := c.UidStore(seqSet, imap.AddFlags, []interface{}{imap.DeletedFlag}, nil); err != nil {
			return fmt.Errorf("store \\Deleted: %w", err)
		}
		if err := c.Expunge(nil); err != nil {
			return fmt.Errorf("expunge: %w", err)
		}
	}

	// The move succeeded on the server. The message now has a new UID in
	// the target folder. Find it by Message-ID so future flag ops work.
	return reconcileMovedUID(c, messageID, targetServerName, messageIDHeader)
}

// reconcileMovedUID searches the target folder for the message by its
// Message-ID header and updates the local uid. If the search fails (no
// Message-ID, or server doesn't support HEADER search) the local row is
// deleted — the next sync will re-fetch it from the target folder with
// the correct UID.
func reconcileMovedUID(c *client.Client, messageID int64, targetServerName, messageIDHeader string) error {
	if messageIDHeader == "" {
		database.DB.Exec("DELETE FROM messages WHERE id = ?", messageID)
		return nil
	}

	if _, err := c.Select(targetServerName, true); err != nil {
		database.DB.Exec("DELETE FROM messages WHERE id = ?", messageID)
		return nil
	}

	criteria := imap.NewSearchCriteria()
	criteria.Header.Set("Message-ID", messageIDHeader)

	uids, err := c.UidSearch(criteria)
	if err != nil || len(uids) == 0 {
		// Can't find it — remove the stale local row and let sync re-fetch.
		database.DB.Exec("DELETE FROM messages WHERE id = ?", messageID)
		return nil
	}

	database.DB.Exec(
		`UPDATE messages SET uid = ?, previous_folder_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		int64(uids[0]), messageID,
	)
	return nil
}

// applyPermanentDelete permanently removes a message from the IMAP server.
func applyPermanentDelete(c *client.Client, messageID, folderID, uid int64, serverSet map[string]bool, serverMailboxes []ServerMailbox) error {
	serverName, err := resolveFolderServerName(folderID, serverSet, serverMailboxes)
	if err != nil {
		return err
	}
	if _, err := c.Select(serverName, false); err != nil {
		return fmt.Errorf("select %s: %w", serverName, err)
	}

	seqSet := new(imap.SeqSet)
	seqSet.AddNum(uint32(uid))

	if err := c.UidStore(seqSet, imap.AddFlags, []interface{}{imap.DeletedFlag}, nil); err != nil {
		return fmt.Errorf("store \\Deleted: %w", err)
	}
	if err := c.Expunge(nil); err != nil {
		return fmt.Errorf("expunge: %w", err)
	}

	// Remove the local row — the message is gone from the server.
	database.DB.Exec("DELETE FROM messages WHERE id = ?", messageID)
	return nil
}

// resolveFolderServerName maps a local folder ID to the actual mailbox
// name on the IMAP server (handling provider naming differences like
// "Sent" vs "Sent Messages").
func resolveFolderServerName(folderID int64, serverSet map[string]bool, serverMailboxes []ServerMailbox) (string, error) {
	var name, role string
	if err := database.DB.QueryRow("SELECT name, role FROM folders WHERE id = ?", folderID).Scan(&name, &role); err != nil {
		return "", fmt.Errorf("load folder %d: %w", folderID, err)
	}
	serverName := resolveServerFolderName(name, role, serverSet, serverMailboxes)
	if serverName == "" {
		return "", fmt.Errorf("folder %q not found on server", name)
	}
	return serverName, nil
}

// ExpireStaleOps marks ops older than maxAge as "failed" so they don't
// block the queue indefinitely. Called periodically by the background loop.
func ExpireStaleOps(maxAge time.Duration) {
	cutoff := time.Now().UTC().Add(-maxAge)
	database.DB.Exec(
		`UPDATE pending_remote_ops SET status = 'failed', updated_at = CURRENT_TIMESTAMP
		 WHERE status = 'pending' AND created_at < ?`,
		cutoff,
	)
}
