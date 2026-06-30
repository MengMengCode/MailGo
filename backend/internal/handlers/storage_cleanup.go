package handlers

import (
	"log"
	"mailgo/internal/database"
)

const (
	// Emergency thresholds when no explicit retention is configured.
	emergencyFreeBytes = 5 * 1024 * 1024    // 5 MB — trigger cleanup
	targetFreeBytes    = 100 * 1024 * 1024  // 100 MB — clean until this free
)

// RunStorageCleanup enforces retention policies and storage limits.
// It is called periodically from the background sync loop.
// Only local cached data (body_text, body_html, attachment content) is
// removed — message rows are kept so they can still be re-fetched from
// the remote IMAP server on demand.
func RunStorageCleanup() {
	retentionMessages := readSettingInt("retention_messages_days")
	retentionAttachments := readSettingInt("retention_attachments_days")
	retentionImages := readSettingInt("retention_images_days")
	limitGB := readSettingFloat("storage_limit_gb")
	if limitGB <= 0 {
		limitGB = 5 // default 5 GB
	}
	limitBytes := int64(limitGB * 1024 * 1024 * 1024)

	// --- 1. Retention cleanup (always runs when days > 0) ---
	if retentionMessages > 0 {
		res, err := database.DB.Exec(
			`UPDATE messages SET body_text = NULL, body_html = NULL
			 WHERE is_deleted = 0
			   AND received_at IS NOT NULL
			   AND received_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
			retentionMessages,
		)
		if err != nil {
			log.Printf("cleanup: retention messages error: %v", err)
		} else if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("cleanup: cleared body for %d expired message(s)", n)
		}
	}

	if retentionAttachments > 0 {
		res, err := database.DB.Exec(
			`UPDATE attachments SET content = NULL, content_expires_at = NULL
			 WHERE mime_type NOT LIKE 'image/%'
			   AND content IS NOT NULL
			   AND message_id IN (
			     SELECT id FROM messages
			     WHERE received_at IS NOT NULL
			       AND received_at < DATE_SUB(NOW(), INTERVAL ? DAY)
			   )`,
			retentionAttachments,
		)
		if err != nil {
			log.Printf("cleanup: retention attachments error: %v", err)
		} else if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("cleanup: cleared %d expired attachment(s)", n)
		}
	}

	if retentionImages > 0 {
		res, err := database.DB.Exec(
			`UPDATE attachments SET content = NULL, content_expires_at = NULL
			 WHERE mime_type LIKE 'image/%'
			   AND content IS NOT NULL
			   AND message_id IN (
			     SELECT id FROM messages
			     WHERE received_at IS NOT NULL
			       AND received_at < DATE_SUB(NOW(), INTERVAL ? DAY)
			   )`,
			retentionImages,
		)
		if err != nil {
			log.Printf("cleanup: retention images error: %v", err)
		} else if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("cleanup: cleared %d expired image(s)", n)
		}
	}

	// --- 2. Storage limit enforcement ---
	totalBytes := calcTotalBytes()

	// Determine target: when no explicit retention is configured, use the
	// emergency threshold so the DB never fills the disk.  Otherwise just
	// enforce the configured limit.
	noRetention := retentionMessages == 0 && retentionAttachments == 0 && retentionImages == 0

	needPrune := false
	var pruneTarget int64

	if totalBytes > limitBytes {
		// Over the hard limit — prune to the limit.
		needPrune = true
		pruneTarget = limitBytes
		log.Printf("cleanup: storage %d MB exceeds limit %d MB, pruning…",
			totalBytes/(1024*1024), limitBytes/(1024*1024))
	} else if noRetention {
		free := limitBytes - totalBytes
		if free < emergencyFreeBytes {
			// Emergency: less than 5 MB headroom — prune until 100 MB free.
			needPrune = true
			pruneTarget = limitBytes - targetFreeBytes
			if pruneTarget < 0 {
				pruneTarget = 0
			}
			log.Printf("cleanup: only %d MB free (< 5 MB), pruning until 100 MB free…",
				free/(1024*1024))
		}
	}

	if !needPrune {
		return
	}

	pruneOldestUntil(pruneTarget)
}

// calcTotalBytes returns the sum of all locally stored content.
func calcTotalBytes() int64 {
	var msgBytes int64
	database.DB.QueryRow(
		`SELECT COALESCE(SUM(LENGTH(COALESCE(body_text,'')) + LENGTH(COALESCE(body_html,''))), 0)
		 FROM messages WHERE is_deleted = 0`,
	).Scan(&msgBytes)
	var attachBytes int64
	database.DB.QueryRow(
		`SELECT COALESCE(SUM(LENGTH(content)), 0) FROM attachments WHERE content IS NOT NULL`,
	).Scan(&attachBytes)
	return msgBytes + attachBytes
}

// pruneOldestUntil removes local content from oldest messages first
// until totalBytes <= target or nothing remains to prune.
func pruneOldestUntil(target int64) {
	const maxIterations = 10000 // safety cap
	for i := 0; i < maxIterations; i++ {
		total := calcTotalBytes()
		if total <= target {
			return
		}

		// Clear body of the oldest message that still has content.
		res, err := database.DB.Exec(
			`UPDATE messages SET body_text = NULL, body_html = NULL
			 WHERE id = (
			   SELECT id FROM messages
			   WHERE is_deleted = 0
			     AND (body_text IS NOT NULL OR body_html IS NOT NULL)
			   ORDER BY COALESCE(received_at, created_at) ASC
			   LIMIT 1
			 )`,
		)
		if err != nil {
			log.Printf("cleanup: prune message body error: %v", err)
			return
		}
		bodyCleared, _ := res.RowsAffected()

		// Clear attachment content of the oldest message that still has content.
		res, err = database.DB.Exec(
			`UPDATE attachments SET content = NULL, content_expires_at = NULL
			 WHERE message_id = (
			   SELECT a.message_id FROM attachments a
			   JOIN messages m ON m.id = a.message_id
			   WHERE a.content IS NOT NULL AND m.is_deleted = 0
			   ORDER BY COALESCE(m.received_at, m.created_at) ASC
			   LIMIT 1
			 )`,
		)
		if err != nil {
			log.Printf("cleanup: prune attachment error: %v", err)
			return
		}
		attachCleared, _ := res.RowsAffected()

		if bodyCleared == 0 && attachCleared == 0 {
			log.Printf("cleanup: nothing left to prune, total still %d bytes", total)
			return
		}
	}
	// Safety: recalculate once more after hitting the cap.
	remaining := calcTotalBytes()
	if remaining > target {
		log.Printf("cleanup: hit iteration cap, remaining %d bytes (target %d)", remaining, target)
	}
}
