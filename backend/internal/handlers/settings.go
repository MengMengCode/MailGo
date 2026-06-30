package handlers

import (
	"database/sql"
	"log"
	"mailgo/internal/database"
	"mailgo/internal/models"
	"net/http"

	"github.com/gorilla/mux"
)

// allowedSettingKeys is the whitelist of setting keys that can be modified
// via the API. This prevents arbitrary key injection.
var allowedSettingKeys = map[string]bool{
	"language":                 true,
	"theme":                    true,
	"auto_refresh_enabled":     true,
	"check_interval":           true,
	"auto_load_remote_resources": true,
	"prevent_tracking":         true,
	"appearance":               true,
	"ai_base_url":              true,
	"ai_api_key":               true,
	"ai_model":                 true,
	"ai_context_window":        true,
	"ai_translate_use_global":  true,
	"ai_translate_base_url":    true,
	"ai_translate_api_key":     true,
	"ai_translate_model":       true,
	"ai_translate_prompt":      true,
	"ai_target_lang":           true,
	"ai_translate_enabled":     true,
	"ai_summarize_enabled":     true,
	"retention_messages_days":  true,
	"retention_attachments_days": true,
	"retention_images_days":    true,
	"storage_limit_gb":         true,
	"autosave_interval":        true,
	"custom_css":               true,
	"conversation_view":        true,
	"show_unread_counts":       true,
	"custom_folders":           true,
}

// Settings
func ListSettings(w http.ResponseWriter, r *http.Request) {
	rows, err := database.DB.Query("SELECT id, setting_key, setting_value, updated_at FROM settings ORDER BY setting_key")
	if err != nil {
		log.Printf("ListSettings error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch settings")
		return
	}
	defer rows.Close()

	settings := make([]models.Setting, 0)
	for rows.Next() {
		var s models.Setting
		if err := rows.Scan(&s.ID, &s.Key, &s.Value, &s.UpdatedAt); err != nil {
			log.Printf("ListSettings scan error: %v", err)
			continue
		}
		if (s.Key == "ai_api_key" || s.Key == "ai_translate_api_key") && s.Value != "" {
			s.Value = "__configured__"
		}
		if s.Key == "web_password" {
			s.Value = "" // never expose
		}
		settings = append(settings, s)
	}
	respondJSON(w, http.StatusOK, settings)
}

func UpdateSetting(w http.ResponseWriter, r *http.Request) {
	key := mux.Vars(r)["key"]
	if key == "" {
		respondError(w, http.StatusBadRequest, "Setting key is required")
		return
	}

	// Whitelist: only allow known settings keys to be modified.
	if !allowedSettingKeys[key] {
		respondError(w, http.StatusBadRequest, "Unknown setting key")
		return
	}

	var body struct {
		Value string `json:"value"`
	}
	if err := decodeJSON(r, &body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	_, err := database.DB.Exec(`INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = CURRENT_TIMESTAMP`, key, body.Value)
	if err != nil {
		log.Printf("UpdateSetting error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to update setting")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Setting updated"})
}

// ChangePassword returns an HTTP handler that changes the web login password.
// The `updater` callback is called with the new password so the auth middleware
// can update its hash at runtime.
func ChangePassword(updater interface{ UpdatePassword(string) }) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			CurrentPassword string `json:"current_password"`
			NewPassword     string `json:"new_password"`
		}
		if err := decodeJSON(r, &body); err != nil {
			respondError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
		if body.NewPassword == "" || len(body.NewPassword) < 6 {
			respondError(w, http.StatusBadRequest, "New password must be at least 6 characters")
			return
		}

		// Verify current password from DB.
		var stored string
		if err := database.DB.QueryRow(
			"SELECT setting_value FROM settings WHERE setting_key = 'web_password'",
		).Scan(&stored); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to read current password")
			return
		}
		if body.CurrentPassword != stored {
			respondError(w, http.StatusUnauthorized, "Current password is incorrect")
			return
		}

		// Update in database.
		if _, err := database.DB.Exec(
			`UPDATE settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE setting_key = 'web_password'`,
			body.NewPassword,
		); err != nil {
			respondError(w, http.StatusInternalServerError, "Failed to update password")
			return
		}

		// Update auth middleware hash at runtime.
		updater.UpdatePassword(body.NewPassword)

		respondJSON(w, http.StatusOK, map[string]string{"message": "Password changed"})
	}
}

// Drafts
func ListDrafts(w http.ResponseWriter, r *http.Request) {
	trashed := r.URL.Query().Get("trashed") == "true"
	rows, err := database.DB.Query(`SELECT id, account_id, to_addresses, cc_addresses, bcc_addresses,
		subject, body_html, body_text, in_reply_to, ref_references, is_trashed, created_at, updated_at
		FROM drafts WHERE is_trashed = ? ORDER BY updated_at DESC`, trashed)
	if err != nil {
		log.Printf("ListDrafts error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch drafts")
		return
	}
	defer rows.Close()

	drafts := make([]models.Draft, 0)
	for rows.Next() {
		var d models.Draft
		var accountID sql.NullInt64
		if err := rows.Scan(&d.ID, &accountID, &d.ToAddresses, &d.CcAddresses, &d.BccAddresses,
			&d.Subject, &d.BodyHTML, &d.BodyText, &d.InReplyTo, &d.References, &d.IsTrashed, &d.CreatedAt, &d.UpdatedAt); err != nil {
			log.Printf("ListDrafts scan error: %v", err)
			continue
		}
		if accountID.Valid {
			v := accountID.Int64
			d.AccountID = &v
		}
		d.AfterScan()
		drafts = append(drafts, d)
	}
	respondJSON(w, http.StatusOK, drafts)
}

func SaveDraft(w http.ResponseWriter, r *http.Request) {
	var draft models.Draft
	if err := decodeJSON(r, &draft); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	result, err := database.DB.Exec(`INSERT INTO drafts (account_id, to_addresses, cc_addresses, bcc_addresses,
		subject, body_html, body_text, in_reply_to, ref_references)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		draft.AccountID, draft.ToAddresses, draft.CcAddresses, draft.BccAddresses,
		draft.Subject, draft.BodyHTML, draft.BodyText, draft.InReplyTo, draft.References)
	if err != nil {
		log.Printf("SaveDraft error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to save draft")
		return
	}

	id, _ := result.LastInsertId()
	respondJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

// GetDraft fetches a single draft by id. Used by the composer to resume
// editing a saved draft without a full refetch of the list.
func GetDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid draft ID")
		return
	}

	var d models.Draft
	var accountID sql.NullInt64
	err := database.DB.QueryRow(`SELECT id, account_id, to_addresses, cc_addresses, bcc_addresses,
		subject, body_html, body_text, in_reply_to, ref_references, is_trashed, created_at, updated_at
		FROM drafts WHERE id = ?`, id).
		Scan(&d.ID, &accountID, &d.ToAddresses, &d.CcAddresses, &d.BccAddresses,
			&d.Subject, &d.BodyHTML, &d.BodyText, &d.InReplyTo, &d.References, &d.IsTrashed, &d.CreatedAt, &d.UpdatedAt)
	if err == sql.ErrNoRows {
		respondError(w, http.StatusNotFound, "Draft not found")
		return
	}
	if err != nil {
		log.Printf("GetDraft error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch draft")
		return
	}
	if accountID.Valid {
		v := accountID.Int64
		d.AccountID = &v
	}
	d.AfterScan()
	respondJSON(w, http.StatusOK, d)
}

func UpdateDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid draft ID")
		return
	}

	var draft models.Draft
	if err := decodeJSON(r, &draft); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	_, err := database.DB.Exec(`UPDATE drafts SET account_id=?, to_addresses=?, cc_addresses=?, bcc_addresses=?,
		subject=?, body_html=?, body_text=?, in_reply_to=?, ref_references=?,
		sync_revision=sync_revision+1, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		draft.AccountID, draft.ToAddresses, draft.CcAddresses, draft.BccAddresses,
		draft.Subject, draft.BodyHTML, draft.BodyText, draft.InReplyTo, draft.References, id)
	if err != nil {
		log.Printf("UpdateDraft error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to update draft")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Draft updated"})
}

func DeleteDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid draft ID")
		return
	}

	_, err := database.DB.Exec("UPDATE drafts SET is_trashed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
	if err != nil {
		log.Printf("DeleteDraft error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete draft")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Draft deleted"})
}

func RestoreDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid draft ID")
		return
	}
	if _, err := database.DB.Exec("UPDATE drafts SET is_trashed = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id); err != nil {
		log.Printf("RestoreDraft error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to restore draft")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Draft restored"})
}

func PermanentDeleteDraft(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid draft ID")
		return
	}
	if _, err := database.DB.Exec("DELETE FROM drafts WHERE id = ?", id); err != nil {
		log.Printf("PermanentDeleteDraft error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to permanently delete draft")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Draft permanently deleted"})
}
