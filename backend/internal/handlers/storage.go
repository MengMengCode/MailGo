package handlers

import (
	"log"
	"mailgo/internal/database"
	"net/http"
	"strconv"
)

type StorageStats struct {
	MessagesBytes    int64 `json:"messages_bytes"`
	AttachmentsBytes int64 `json:"attachments_bytes"`
	ImagesBytes      int64 `json:"images_bytes"`
	TotalBytes       int64 `json:"total_bytes"`
	LimitBytes       int64 `json:"limit_bytes"`
}

func StorageStatsHandler(w http.ResponseWriter, r *http.Request) {
	var msgBytes int64
	err := database.DB.QueryRow(
		`SELECT COALESCE(SUM(LENGTH(COALESCE(body_text,'')) + LENGTH(COALESCE(body_html,''))), 0)
		 FROM messages WHERE is_deleted = 0`,
	).Scan(&msgBytes)
	if err != nil {
		log.Printf("StorageStats messages error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to compute storage stats")
		return
	}

	var attachBytes int64
	err = database.DB.QueryRow(
		`SELECT COALESCE(SUM(LENGTH(content)), 0)
		 FROM attachments WHERE content IS NOT NULL AND mime_type NOT LIKE 'image/%'`,
	).Scan(&attachBytes)
	if err != nil {
		log.Printf("StorageStats attachments error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to compute storage stats")
		return
	}

	var imgBytes int64
	err = database.DB.QueryRow(
		`SELECT COALESCE(SUM(LENGTH(content)), 0)
		 FROM attachments WHERE content IS NOT NULL AND mime_type LIKE 'image/%'`,
	).Scan(&imgBytes)
	if err != nil {
		log.Printf("StorageStats images error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to compute storage stats")
		return
	}

	limitGB := readSettingFloat("storage_limit_gb")

	respondJSON(w, http.StatusOK, StorageStats{
		MessagesBytes:    msgBytes,
		AttachmentsBytes: attachBytes,
		ImagesBytes:      imgBytes,
		TotalBytes:       msgBytes + attachBytes + imgBytes,
		LimitBytes:       int64(limitGB * 1024 * 1024 * 1024),
	})
}

func readSettingInt(key string) int {
	var val string
	err := database.DB.QueryRow("SELECT setting_value FROM settings WHERE setting_key = ?", key).Scan(&val)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(val)
	return n
}

func readSettingFloat(key string) float64 {
	var val string
	err := database.DB.QueryRow("SELECT setting_value FROM settings WHERE setting_key = ?", key).Scan(&val)
	if err != nil {
		return 0
	}
	n, _ := strconv.ParseFloat(val, 64)
	return n
}

// ClearStorageHandler clears local cached data by category.
// POST /api/v1/storage/clear  { "type": "messages" | "attachments" | "images" | "all" }
func ClearStorageHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Type string `json:"type"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	var affected int64
	switch req.Type {
	case "messages":
		// Clear body content only — keep metadata (subject, sender, flags, etc.)
		res, err := database.DB.Exec(
			`UPDATE messages SET body_text = NULL, body_html = NULL, snippet = '',
			 updated_at = CURRENT_TIMESTAMP WHERE is_deleted = 0 AND (body_text IS NOT NULL OR body_html IS NOT NULL)`)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to clear messages")
			return
		}
		affected, _ = res.RowsAffected()

	case "attachments":
		res, err := database.DB.Exec(
			`UPDATE attachments SET content = NULL, content_expires_at = NULL
			 WHERE content IS NOT NULL AND mime_type NOT LIKE 'image/%'`)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to clear attachments")
			return
		}
		affected, _ = res.RowsAffected()

	case "images":
		res, err := database.DB.Exec(
			`UPDATE attachments SET content = NULL, content_expires_at = NULL
			 WHERE content IS NOT NULL AND mime_type LIKE 'image/%'`)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to clear images")
			return
		}
		affected, _ = res.RowsAffected()

	case "all":
		// Delete all messages (CASCADE removes attachments too), reset sync state.
		res, err := database.DB.Exec(`DELETE FROM messages`)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to clear all data")
			return
		}
		affected, _ = res.RowsAffected()
		// Reset folder sync pointers so the next sync does a full re-fetch.
		database.DB.Exec(`UPDATE folders SET uid_next = 0, last_synced_at = NULL`)
		// Also clear local drafts and pending ops.
		database.DB.Exec(`DELETE FROM drafts`)
		database.DB.Exec(`DELETE FROM pending_remote_ops`)

	default:
		respondError(w, http.StatusBadRequest, "type must be messages, attachments, images, or all")
		return
	}

	log.Printf("Storage clear type=%s affected=%d rows", req.Type, affected)
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"cleared":  req.Type,
		"affected": affected,
	})
}
