package handlers

import (
	"database/sql"
	"fmt"
	"log"
	"mailgo/internal/crypto"
	"mailgo/internal/database"
	"mailgo/internal/models"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
)

func parseIDParam(r *http.Request, key string) (int64, bool) {
	v := mux.Vars(r)[key]
	id, err := strconv.ParseInt(v, 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

// normalizeEncryption maps the encryption string to one of "ssl",
// "starttls", "none". Empty string falls back to a sensible default
// based on the port (993/465 → ssl, otherwise starttls).
func normalizeEncryption(enc string, port int) string {
	switch enc {
	case "ssl", "starttls", "none":
		return enc
	}
	if port == 993 || port == 465 || port == 995 {
		return "ssl"
	}
	return "starttls"
}

// encryptionToBool converts the encryption mode to the legacy boolean
// tls flag for backward compatibility with code that still reads
// imap_tls/smtp_tls. "none" → false, everything else → true.
func encryptionToBool(enc string) bool {
	return enc != "none"
}

const accountSelectCols = `id, name, email, provider, imap_host, imap_port, imap_tls, imap_encryption,
	smtp_host, smtp_port, smtp_tls, smtp_encryption, username, sender_email, avatar_url,
	auto_reply_enabled, auto_reply_subject, auto_reply_body, proxy_enabled, proxy_host, proxy_port,
	is_default, tag_color, sync_days, last_sync_at, created_at, updated_at`

func scanAccount(scanner interface{ Scan(...interface{}) error }) (models.Account, error) {
	var a models.Account
	err := scanner.Scan(&a.ID, &a.Name, &a.Email, &a.Provider, &a.ImapHost, &a.ImapPort,
		&a.ImapTLS, &a.ImapEncryption, &a.SmtpHost, &a.SmtpPort, &a.SmtpTLS, &a.SmtpEncryption,
		&a.Username, &a.SenderEmail, &a.AvatarURL, &a.AutoReplyEnabled, &a.AutoReplySubject, &a.AutoReplyBody,
		&a.ProxyEnabled, &a.ProxyHost, &a.ProxyPort, &a.IsDefault,
		&a.TagColor, &a.SyncDays, &a.LastSyncAt, &a.CreatedAt, &a.UpdatedAt)
	return a, err
}

func ListAccounts(w http.ResponseWriter, r *http.Request) {
	rows, err := database.DB.Query(`SELECT ` + accountSelectCols + ` FROM accounts ORDER BY created_at DESC`)
	if err != nil {
		log.Printf("ListAccounts query error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch accounts")
		return
	}
	defer rows.Close()

	accounts := make([]models.Account, 0)
	for rows.Next() {
		a, err := scanAccount(rows)
		if err != nil {
			log.Printf("ListAccounts scan error: %v", err)
			continue
		}
		accounts = append(accounts, a)
	}
	respondJSON(w, http.StatusOK, accounts)
}

func GetAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid account ID")
		return
	}

	var a models.Account
	err := database.DB.QueryRow(`SELECT `+accountSelectCols+` FROM accounts WHERE id = ?`, id).
		Scan(&a.ID, &a.Name, &a.Email, &a.Provider, &a.ImapHost, &a.ImapPort,
			&a.ImapTLS, &a.ImapEncryption, &a.SmtpHost, &a.SmtpPort, &a.SmtpTLS, &a.SmtpEncryption,
			&a.Username, &a.SenderEmail, &a.AvatarURL, &a.AutoReplyEnabled, &a.AutoReplySubject, &a.AutoReplyBody,
			&a.ProxyEnabled, &a.ProxyHost, &a.ProxyPort, &a.IsDefault,
			&a.TagColor, &a.SyncDays, &a.LastSyncAt, &a.CreatedAt, &a.UpdatedAt)
	if err == sql.ErrNoRows {
		respondError(w, http.StatusNotFound, "Account not found")
		return
	}
	if err != nil {
		log.Printf("GetAccount error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch account")
		return
	}
	respondJSON(w, http.StatusOK, a)
}

func CreateAccount(w http.ResponseWriter, r *http.Request) {
	var req models.AccountCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Name == "" || req.Email == "" || req.ImapHost == "" || req.SmtpHost == "" || req.Username == "" {
		respondError(w, http.StatusBadRequest, "Missing required fields: name, email, imap_host, smtp_host, username")
		return
	}
	if req.Provider == "" {
		req.Provider = "imap"
	}
	if req.ImapPort == 0 {
		req.ImapPort = 993
	}
	if req.SmtpPort == 0 {
		req.SmtpPort = 587
	}
	if req.SenderEmail == "" {
		req.SenderEmail = req.Email
	}
	// Normalize encryption modes and sync the legacy boolean columns.
	req.ImapEncryption = normalizeEncryption(req.ImapEncryption, req.ImapPort)
	req.SmtpEncryption = normalizeEncryption(req.SmtpEncryption, req.SmtpPort)
	req.ImapTLS = encryptionToBool(req.ImapEncryption)
	req.SmtpTLS = encryptionToBool(req.SmtpEncryption)

	encPassword, encErr := encryptPassword(req.Password)
	if encErr != nil {
		respondError(w, http.StatusInternalServerError, "Failed to secure password")
		return
	}

	result, err := database.DB.Exec(`INSERT INTO accounts (name, email, provider, imap_host, imap_port, imap_tls, imap_encryption,
		smtp_host, smtp_port, smtp_tls, smtp_encryption, username, password_encrypted, sender_email, avatar_url,
		auto_reply_enabled, auto_reply_subject, auto_reply_body, proxy_enabled, proxy_host, proxy_port, tag_color, sync_days)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		req.Name, req.Email, req.Provider, req.ImapHost, req.ImapPort, req.ImapTLS, req.ImapEncryption,
		req.SmtpHost, req.SmtpPort, req.SmtpTLS, req.SmtpEncryption, req.Username, encPassword,
		req.SenderEmail, req.AvatarURL, req.AutoReplyEnabled, req.AutoReplySubject, req.AutoReplyBody,
		req.ProxyEnabled, req.ProxyHost, req.ProxyPort, req.TagColor, req.SyncDays)
	if err != nil {
		log.Printf("CreateAccount error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to create account")
		return
	}

	id, _ := result.LastInsertId()

	// Create default folders with role tags
	defaultFolders := []struct {
		name string
		role string
	}{
		{"INBOX", "inbox"},
		{"Sent", "sent"},
		{"Drafts", "drafts"},
		{"Trash", "trash"},
		{"Archive", "archive"},
		{"Spam", "spam"},
	}
	for _, f := range defaultFolders {
		database.DB.Exec(
			"INSERT IGNORE INTO folders (account_id, name, role) VALUES (?, ?, ?)",
			id, f.name, f.role,
		)
	}

	respondJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

func UpdateAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid account ID")
		return
	}

	var req models.AccountCreateRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.SenderEmail == "" {
		req.SenderEmail = req.Email
	}
	req.ImapEncryption = normalizeEncryption(req.ImapEncryption, req.ImapPort)
	req.SmtpEncryption = normalizeEncryption(req.SmtpEncryption, req.SmtpPort)
	req.ImapTLS = encryptionToBool(req.ImapEncryption)
	req.SmtpTLS = encryptionToBool(req.SmtpEncryption)

	_, err := database.DB.Exec(`UPDATE accounts SET name=?, email=?, provider=?, imap_host=?, imap_port=?, imap_tls=?, imap_encryption=?,
		smtp_host=?, smtp_port=?, smtp_tls=?, smtp_encryption=?, username=?, sender_email=?, avatar_url=?,
		auto_reply_enabled=?, auto_reply_subject=?, auto_reply_body=?, proxy_enabled=?, proxy_host=?, proxy_port=?,
		tag_color=?, sync_days=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
		req.Name, req.Email, req.Provider, req.ImapHost, req.ImapPort, req.ImapTLS, req.ImapEncryption,
		req.SmtpHost, req.SmtpPort, req.SmtpTLS, req.SmtpEncryption, req.Username,
		req.SenderEmail, req.AvatarURL, req.AutoReplyEnabled, req.AutoReplySubject, req.AutoReplyBody,
		req.ProxyEnabled, req.ProxyHost, req.ProxyPort, req.TagColor, req.SyncDays, id)
	if err != nil {
		log.Printf("UpdateAccount error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to update account")
		return
	}

	// Update password only if provided
	if req.Password != "" {
		enc, encErr := encryptPassword(req.Password)
		if encErr != nil {
			respondError(w, http.StatusInternalServerError, "Failed to secure password")
			return
		}
		database.DB.Exec("UPDATE accounts SET password_encrypted=? WHERE id=?", enc, id)
	}

	respondJSON(w, http.StatusOK, map[string]string{"message": "Account updated"})
}

func DeleteAccount(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid account ID")
		return
	}

	// Delete drafts for this account first (drafts use ON DELETE SET NULL,
	// not CASCADE, so they would be orphaned otherwise).
	database.DB.Exec("DELETE FROM drafts WHERE account_id = ?", id)

	_, err := database.DB.Exec("DELETE FROM accounts WHERE id = ?", id)
	if err != nil {
		log.Printf("DeleteAccount error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete account")
		return
	}
	log.Printf("Account %d deleted (with all related data)", id)
	respondJSON(w, http.StatusOK, map[string]string{"message": "Account deleted"})
}

// encryptPassword encrypts a plaintext password for database storage.
// Returns empty string unchanged. Returns error if encryption fails —
// never stores plaintext passwords.
func encryptPassword(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	enc, err := crypto.Encrypt(plaintext)
	if err != nil {
		log.Printf("encryptPassword error: password NOT stored (encryption unavailable)")
		return "", fmt.Errorf("encryption unavailable")
	}
	return enc, nil
}
