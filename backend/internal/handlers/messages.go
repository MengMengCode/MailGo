package handlers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"mailgo/internal/appclock"
	"mailgo/internal/crypto"
	"mailgo/internal/database"
	"mailgo/internal/imap"
	"mailgo/internal/microsoftauth"
	"mailgo/internal/models"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/mail"
	"net/smtp"
	"strings"
	"time"
)

func ListMessages(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	page := parseIntParam(query.Get("page"), 1)
	pageSize := parseIntParam(query.Get("page_size"), 50)
	if pageSize > 100 {
		pageSize = 100
	}

	folder := query.Get("folder")
	folderID := query.Get("folder_id")
	folderRole := query.Get("folder_role")
	accountID := query.Get("account_id")
	starred := query.Get("starred")
	unread := query.Get("unread")
	search := query.Get("q")
	includeDrafts := query.Get("include_drafts") == "true"
	hasAttachment := query.Get("has_attachment")
	fromFilter := query.Get("from")
	subjectFilter := query.Get("subject")
	afterFilter := query.Get("after")
	beforeFilter := query.Get("before")
	excludeSpamTrash := query.Get("exclude_spam_trash") == "true"

	where := "WHERE m.is_deleted = 0"
	if !includeDrafts {
		where += " AND m.is_draft = 0"
		// Belt-and-suspenders: also exclude synced-back draft copies by
		// message_id pattern, in case the IMAP server stripped the \Draft flag.
		where += " AND m.message_id NOT LIKE '<mailgo-draft-%@mailgo.local>'"
	} else {
		// Locally-authored drafts remain the UI's source of truth. Hide the
		// IMAP copy that MailGo itself appended to the remote Drafts mailbox.
		where += ` AND NOT EXISTS (
			SELECT 1 FROM draft_remote_copies drc
			WHERE drc.account_id = m.account_id AND drc.uid = m.uid
		)`
		where += " AND m.message_id NOT LIKE '<mailgo-draft-%@mailgo.local>'"
	}
	args := make([]interface{}, 0)

	if folder != "" {
		where += " AND f.name = ?"
		args = append(args, folder)
	}
	if folderID != "" {
		where += " AND m.folder_id = ?"
		args = append(args, folderID)
	}
	if folderRole != "" {
		where += " AND f.role = ?"
		args = append(args, folderRole)
	}
	if accountID != "" {
		where += " AND m.account_id = ?"
		args = append(args, accountID)
	}
	if starred == "true" {
		where += " AND m.is_starred = 1"
	}
	if unread == "true" {
		where += " AND m.is_read = 0 AND f.role NOT IN ('spam', 'trash')"
	}
	if hasAttachment == "true" {
		where += " AND m.has_attachments = 1"
	}
	if fromFilter != "" {
		where += " AND (m.from_address LIKE ? OR m.from_name LIKE ?)"
		likeFrom := "%" + fromFilter + "%"
		args = append(args, likeFrom, likeFrom)
	}
	if subjectFilter != "" {
		where += " AND m.subject LIKE ?"
		args = append(args, "%"+subjectFilter+"%")
	}
	if afterFilter != "" {
		where += " AND m.received_at >= ?"
		args = append(args, dateFilterBoundary(afterFilter, false))
	}
	if beforeFilter != "" {
		where += " AND m.received_at <= ?"
		args = append(args, dateFilterBoundary(beforeFilter, true))
	}
	if excludeSpamTrash {
		where += " AND f.role NOT IN ('spam', 'trash')"
	}
	if search != "" {
		where += ` AND (
			m.subject LIKE ? OR m.from_name LIKE ? OR m.from_address LIKE ?
			OR m.to_addresses LIKE ? OR m.cc_addresses LIKE ? OR m.bcc_addresses LIKE ?
			OR m.body_text LIKE ? OR m.body_html LIKE ? OR m.snippet LIKE ?
		)`
		like := "%" + search + "%"
		args = append(args, like, like, like, like, like, like, like, like, like)
	}

	// Count total after de-duplicating provider labels for the same RFC Message-ID.
	total := countDistinctMessages(where, args, "total")

	// Count unread
	unreadCount := countDistinctMessages(where+" AND m.is_read = 0", args, "unread")

	// Fetch messages
	offset := (page - 1) * pageSize
	selectQuery := `SELECT id, account_id, folder_id, uid, message_id, subject,
		from_address, from_name, to_addresses, cc_addresses, bcc_addresses,
		reply_to, body_text, body_html, snippet, received_at, sent_at, size,
		is_read, is_starred, is_answered, is_forwarded, is_draft, is_deleted,
		has_attachments, labels, thread_id, in_reply_to, ref_references,
		created_at, updated_at, folder_name
		FROM (
			SELECT m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.subject,
				m.from_address, m.from_name, m.to_addresses, m.cc_addresses, m.bcc_addresses,
				m.reply_to, m.body_text, m.body_html, m.snippet, m.received_at, m.sent_at, m.size,
				m.is_read, m.is_starred, m.is_answered, m.is_forwarded, m.is_draft, m.is_deleted,
				m.has_attachments, m.labels, m.thread_id, m.in_reply_to, m.ref_references,
				m.created_at, m.updated_at, COALESCE(f.name, '') as folder_name,
				ROW_NUMBER() OVER (
					PARTITION BY CASE
						WHEN TRIM(COALESCE(m.message_id, '')) != '' THEN LOWER(TRIM(m.message_id))
						ELSE CONCAT('id:', m.id)
					END
					ORDER BY
						CASE f.role
							WHEN 'inbox' THEN 0
							WHEN 'archive' THEN 1
							WHEN 'sent' THEN 2
							WHEN 'drafts' THEN 3
							WHEN 'spam' THEN 4
							WHEN 'trash' THEN 5
							ELSE 6
						END,
						COALESCE(m.received_at, m.sent_at, m.created_at) DESC,
						m.id DESC
				) as dedupe_rank
			FROM messages m LEFT JOIN folders f ON m.folder_id = f.id ` +
		where + `) ranked
		WHERE dedupe_rank = 1
		ORDER BY COALESCE(received_at, sent_at, created_at) DESC, id DESC
		LIMIT ? OFFSET ?`
	selectArgs := append(args, pageSize, offset)

	rows, err := database.DB.Query(selectQuery, selectArgs...)
	if err != nil {
		log.Printf("ListMessages query error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch messages")
		return
	}
	defer rows.Close()

	messages := make([]models.Message, 0)
	for rows.Next() {
		var m models.Message
		err := rows.Scan(&m.ID, &m.AccountID, &m.FolderID, &m.UID, &m.MessageID, &m.Subject,
			&m.FromAddress, &m.FromName, &m.ToAddresses, &m.CcAddresses, &m.BccAddresses,
			&m.ReplyTo, &m.BodyText, &m.BodyHTML, &m.Snippet, &m.ReceivedAt, &m.SentAt, &m.Size,
			&m.IsRead, &m.IsStarred, &m.IsAnswered, &m.IsForwarded, &m.IsDraft, &m.IsDeleted,
			&m.HasAttachments, &m.Labels, &m.ThreadID, &m.InReplyTo, &m.References,
			&m.CreatedAt, &m.UpdatedAt, &m.FolderName)
		if err != nil {
			log.Printf("ListMessages scan error: %v", err)
			continue
		}
		m.AfterScan()
		messages = append(messages, m)
	}
	respondJSON(w, http.StatusOK, models.MessageListResponse{
		Messages:    messages,
		Total:       total,
		Page:        page,
		PageSize:    pageSize,
		UnreadCount: unreadCount,
	})
}

func countDistinctMessages(where string, args []interface{}, label string) int {
	var total int
	err := database.DB.QueryRow(`SELECT COUNT(*) FROM (
		SELECT CASE
			WHEN TRIM(COALESCE(m.message_id, '')) != '' THEN LOWER(TRIM(m.message_id))
			ELSE CONCAT('id:', m.id)
		END AS dedupe_key
		FROM messages m LEFT JOIN folders f ON m.folder_id = f.id `+where+`
		GROUP BY dedupe_key
	) AS dedupe_cnt`, args...).Scan(&total)
	if err != nil {
		log.Printf("ListMessages %s count error: %v", label, err)
	}
	return total
}

func dateFilterBoundary(value string, endOfDay bool) time.Time {
	loc := appclock.CurrentLocation()
	parsed, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(value), loc)
	if err != nil {
		if fallback, fallbackErr := time.Parse(time.RFC3339, strings.TrimSpace(value)); fallbackErr == nil {
			return fallback
		}
		return time.Now().In(loc)
	}
	if endOfDay {
		return parsed.AddDate(0, 0, 1).Add(-time.Nanosecond)
	}
	return parsed
}

func GetMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	var m models.Message
	err := database.DB.QueryRow(`SELECT m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.subject,
		m.from_address, m.from_name, m.to_addresses, m.cc_addresses, m.bcc_addresses,
		m.reply_to, m.body_text, m.body_html, m.snippet, m.received_at, m.sent_at, m.size,
		m.is_read, m.is_starred, m.is_answered, m.is_forwarded, m.is_draft, m.is_deleted,
		m.has_attachments, m.labels, m.thread_id, m.in_reply_to, m.ref_references,
		m.created_at, m.updated_at, COALESCE(f.name, '') as folder_name
		FROM messages m LEFT JOIN folders f ON m.folder_id = f.id WHERE m.id = ?`, id).
		Scan(&m.ID, &m.AccountID, &m.FolderID, &m.UID, &m.MessageID, &m.Subject,
			&m.FromAddress, &m.FromName, &m.ToAddresses, &m.CcAddresses, &m.BccAddresses,
			&m.ReplyTo, &m.BodyText, &m.BodyHTML, &m.Snippet, &m.ReceivedAt, &m.SentAt, &m.Size,
			&m.IsRead, &m.IsStarred, &m.IsAnswered, &m.IsForwarded, &m.IsDraft, &m.IsDeleted,
			&m.HasAttachments, &m.Labels, &m.ThreadID, &m.InReplyTo, &m.References,
			&m.CreatedAt, &m.UpdatedAt, &m.FolderName)
	if err != nil {
		log.Printf("GetMessage error: %v", err)
		respondError(w, http.StatusNotFound, "Message not found")
		return
	}
	m.AfterScan()

	// Mark as read (and enqueue IMAP sync so the server reflects it).
	// For providers such as Gmail the same Message-ID can appear through
	// multiple labels; keep those local copies in the same read state.
	if !m.IsRead {
		_ = setMessageReadState(id, true)
		enqueueRemoteOp(id, "mark_read", "{}")
		m.IsRead = true
	}

	respondJSON(w, http.StatusOK, m)
}

func GetMessageThread(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	var base struct {
		AccountID  int64
		MessageID  sql.NullString
		Subject    string
		ThreadID   sql.NullString
		InReplyTo  sql.NullString
		References sql.NullString
	}
	err := database.DB.QueryRow(`
		SELECT account_id, message_id, subject, thread_id, in_reply_to, ref_references
		FROM messages WHERE id = ? AND is_deleted = 0 AND is_draft = 0`, id).
		Scan(&base.AccountID, &base.MessageID, &base.Subject, &base.ThreadID, &base.InReplyTo, &base.References)
	if err != nil {
		respondError(w, http.StatusNotFound, "Message not found")
		return
	}

	rows, err := database.DB.Query(`SELECT m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.subject,
		m.from_address, m.from_name, m.to_addresses, m.cc_addresses, m.bcc_addresses,
		m.reply_to, m.body_text, m.body_html, m.snippet, m.received_at, m.sent_at, m.size,
		m.is_read, m.is_starred, m.is_answered, m.is_forwarded, m.is_draft, m.is_deleted,
		m.has_attachments, m.labels, m.thread_id, m.in_reply_to, m.ref_references,
		m.created_at, m.updated_at, COALESCE(f.name, '') as folder_name
		FROM messages m LEFT JOIN folders f ON m.folder_id = f.id
		WHERE m.account_id = ? AND m.is_deleted = 0 AND m.is_draft = 0
		ORDER BY m.received_at ASC, m.id ASC
		LIMIT 1000`, base.AccountID)
	if err != nil {
		log.Printf("GetMessageThread query error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch message thread")
		return
	}
	defer rows.Close()

	baseThread := strings.TrimSpace(base.ThreadID.String)
	baseSubject := normalizeThreadSubject(base.Subject)
	baseRefs := messageReferenceSet(base.MessageID.String, base.InReplyTo.String, base.References.String)
	messages := make([]models.Message, 0)
	seenByMessageID := make(map[string]int)

	for rows.Next() {
		var m models.Message
		if err := rows.Scan(&m.ID, &m.AccountID, &m.FolderID, &m.UID, &m.MessageID, &m.Subject,
			&m.FromAddress, &m.FromName, &m.ToAddresses, &m.CcAddresses, &m.BccAddresses,
			&m.ReplyTo, &m.BodyText, &m.BodyHTML, &m.Snippet, &m.ReceivedAt, &m.SentAt, &m.Size,
			&m.IsRead, &m.IsStarred, &m.IsAnswered, &m.IsForwarded, &m.IsDraft, &m.IsDeleted,
			&m.HasAttachments, &m.Labels, &m.ThreadID, &m.InReplyTo, &m.References,
			&m.CreatedAt, &m.UpdatedAt, &m.FolderName); err != nil {
			log.Printf("GetMessageThread scan error: %v", err)
			continue
		}
		m.AfterScan()
		if !matchesThread(m, baseThread, baseSubject, baseRefs) {
			continue
		}
		dedupeKey := strings.ToLower(strings.TrimSpace(m.MessageIDStr))
		if dedupeKey != "" {
			if idx, exists := seenByMessageID[dedupeKey]; exists {
				if m.ID == id {
					messages[idx] = m
				}
				continue
			}
			seenByMessageID[dedupeKey] = len(messages)
		}
		messages = append(messages, m)
	}
	if len(messages) == 0 {
		baseMessage, err := loadMessageByID(id)
		if err == nil {
			messages = append(messages, baseMessage)
		}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"messages": messages,
		"total":    len(messages),
	})
}

func loadMessageByID(id int64) (models.Message, error) {
	var m models.Message
	err := database.DB.QueryRow(`SELECT m.id, m.account_id, m.folder_id, m.uid, m.message_id, m.subject,
		m.from_address, m.from_name, m.to_addresses, m.cc_addresses, m.bcc_addresses,
		m.reply_to, m.body_text, m.body_html, m.snippet, m.received_at, m.sent_at, m.size,
		m.is_read, m.is_starred, m.is_answered, m.is_forwarded, m.is_draft, m.is_deleted,
		m.has_attachments, m.labels, m.thread_id, m.in_reply_to, m.ref_references,
		m.created_at, m.updated_at, COALESCE(f.name, '') as folder_name
		FROM messages m LEFT JOIN folders f ON m.folder_id = f.id WHERE m.id = ?`, id).
		Scan(&m.ID, &m.AccountID, &m.FolderID, &m.UID, &m.MessageID, &m.Subject,
			&m.FromAddress, &m.FromName, &m.ToAddresses, &m.CcAddresses, &m.BccAddresses,
			&m.ReplyTo, &m.BodyText, &m.BodyHTML, &m.Snippet, &m.ReceivedAt, &m.SentAt, &m.Size,
			&m.IsRead, &m.IsStarred, &m.IsAnswered, &m.IsForwarded, &m.IsDraft, &m.IsDeleted,
			&m.HasAttachments, &m.Labels, &m.ThreadID, &m.InReplyTo, &m.References,
			&m.CreatedAt, &m.UpdatedAt, &m.FolderName)
	if err != nil {
		return m, err
	}
	m.AfterScan()
	return m, nil
}

func matchesThread(m models.Message, baseThread, baseSubject string, baseRefs map[string]bool) bool {
	if baseThread != "" && strings.TrimSpace(m.ThreadIDStr) == baseThread {
		return true
	}
	if baseSubject != "" && normalizeThreadSubject(m.Subject) == baseSubject {
		return true
	}
	if len(baseRefs) > 0 {
		for ref := range messageReferenceSet(m.MessageIDStr, m.InReplyToStr, m.ReferencesStr) {
			if baseRefs[ref] {
				return true
			}
		}
	}
	return false
}

func messageReferenceSet(values ...string) map[string]bool {
	out := make(map[string]bool)
	for _, value := range values {
		for _, token := range strings.Fields(strings.ReplaceAll(value, ",", " ")) {
			ref := normalizeMessageReference(token)
			if ref != "" {
				out[ref] = true
			}
		}
	}
	return out
}

func normalizeMessageReference(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, "<>")
	value = strings.Trim(value, "\"'")
	return strings.ToLower(value)
}

func normalizeThreadSubject(subject string) string {
	next := strings.ToLower(strings.TrimSpace(subject))
	for {
		previous := next
		for _, prefix := range []string{
			"re:", "fw:", "fwd:", "re\uff1a", "fw\uff1a", "fwd\uff1a",
			"\u56de\u590d:", "\u7b54\u590d:", "\u8f6c\u53d1:",
			"\u56de\u590d\uff1a", "\u7b54\u590d\uff1a", "\u8f6c\u53d1\uff1a",
		} {
			next = strings.TrimSpace(strings.TrimPrefix(next, prefix))
		}
		if strings.HasPrefix(next, "[") {
			if end := strings.Index(next, "]"); end >= 0 && end < len(next)-1 {
				next = strings.TrimSpace(next[end+1:])
			}
		}
		if next == previous {
			break
		}
	}
	return strings.Join(strings.Fields(next), " ")
}

// GetMessageRaw returns the full RFC822 source of a message, fetched
// live from the IMAP server. Used by the "view source" button in the
// message detail view. The body is returned as text/plain so the
// browser renders the raw headers + body verbatim.
func GetMessageRaw(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	raw, err := imap.FetchMessageRaw(id)
	if err != nil {
		log.Printf("GetMessageRaw error (id=%d): %v", id, err)
		log.Printf("GetRawMessage error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch raw message")
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(raw))
}

func UpdateMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	var updates map[string]interface{}
	if err := decodeJSON(r, &updates); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	for key, val := range updates {
		switch key {
		case "is_read":
			if v, ok := toBool(val); ok {
				_ = setMessageReadState(id, v)
				if v {
					enqueueRemoteOp(id, "mark_read", "{}")
				} else {
					enqueueRemoteOp(id, "mark_unread", "{}")
				}
			}
		case "is_starred":
			if v, ok := toBool(val); ok {
				_ = setMessageStarredState(id, v)
				if v {
					enqueueRemoteOp(id, "star", "{}")
				} else {
					enqueueRemoteOp(id, "unstar", "{}")
				}
			}
		case "labels":
			if v, ok := val.(string); ok {
				database.DB.Exec("UPDATE messages SET labels = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", v, id)
			}
		}
	}

	respondJSON(w, http.StatusOK, map[string]string{"message": "Message updated"})
}

func DeleteMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	_, err := database.DB.Exec(`UPDATE messages SET
		previous_folder_id = folder_id,
		folder_id = (
			SELECT f.id FROM folders f
			WHERE f.account_id = messages.account_id AND f.role = 'trash'
			LIMIT 1
		), updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`, id)
	if err != nil {
		log.Printf("DeleteMessage error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete message")
		return
	}
	enqueueRemoteOp(id, "move_to_trash", "{}")
	respondJSON(w, http.StatusOK, map[string]string{"message": "Message deleted"})
}

func RestoreMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}
	// Restore to the original folder (previous_folder_id). Fall back to
	// inbox when the original folder is unknown. The SET clause is safe
	// because SQL evaluates all RHS against the pre-UPDATE row, so
	// folder_id gets the old previous_folder_id while previous_folder_id
	// captures the old folder_id (trash) — exactly what the IMAP push
	// processor needs to know the source mailbox.
	_, err := database.DB.Exec(`UPDATE messages SET
		folder_id = COALESCE(
			previous_folder_id,
			(SELECT f.id FROM folders f
			 WHERE f.account_id = messages.account_id AND f.role = 'inbox'
			 LIMIT 1)
		),
		previous_folder_id = folder_id,
		is_deleted = 0,
		updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`, id)
	if err != nil {
		log.Printf("RestoreMessage error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to restore message")
		return
	}
	enqueueRemoteOp(id, "restore", "{}")
	respondJSON(w, http.StatusOK, map[string]string{"message": "Message restored"})
}

func PermanentDeleteMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}
	_, err := database.DB.Exec("UPDATE messages SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", id)
	if err != nil {
		log.Printf("PermanentDeleteMessage error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to permanently delete message")
		return
	}
	enqueueRemoteOp(id, "permanent_delete", "{}")
	respondJSON(w, http.StatusOK, map[string]string{"message": "Message permanently deleted"})
}

func StarMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	var current bool
	_ = database.DB.QueryRow("SELECT is_starred FROM messages WHERE id = ?", id).Scan(&current)
	next := !current
	if err := setMessageStarredState(id, next); err != nil {
		log.Printf("StarMessage: setMessageStarredState(%d, %v): %v", id, next, err)
	}
	if next {
		enqueueRemoteOp(id, "star", "{}")
	} else {
		enqueueRemoteOp(id, "unstar", "{}")
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Star toggled"})
}

func ToggleRead(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	var current bool
	_ = database.DB.QueryRow("SELECT is_read FROM messages WHERE id = ?", id).Scan(&current)
	next := !current
	if err := setMessageReadState(id, next); err != nil {
		log.Printf("ToggleRead: setMessageReadState(%d, %v): %v", id, next, err)
	}
	if next {
		enqueueRemoteOp(id, "mark_read", "{}")
	} else {
		enqueueRemoteOp(id, "mark_unread", "{}")
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Read status toggled"})
}

func MoveMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	var body struct {
		FolderID int64 `json:"folder_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if body.FolderID == 0 {
		respondError(w, http.StatusBadRequest, "folder_id is required")
		return
	}

	_, err := database.DB.Exec(`UPDATE messages SET
		previous_folder_id = folder_id,
		folder_id = ?,
		updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`,
		body.FolderID, id)
	if err != nil {
		log.Printf("MoveMessage error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to move message")
		return
	}
	enqueueRemoteOp(id, "move", fmt.Sprintf(`{"folder_id":%d}`, body.FolderID))
	respondJSON(w, http.StatusOK, map[string]string{"message": "Message moved"})
}

type BatchRequest struct {
	Action string  `json:"action"`
	IDs    []int64 `json:"ids"`
}

func BatchMessages(w http.ResponseWriter, r *http.Request) {
	var req BatchRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if len(req.IDs) == 0 {
		respondJSON(w, http.StatusOK, map[string]int{"count": 0})
		return
	}

	count := int64(0)
	remoteAction := req.Action
	remotePayload := "{}"
	switch req.Action {
	case "archive":
		// Move to archive folder for the corresponding account(s)
		count = batchMoveToRole(req.IDs, "archive")
		remoteAction = "move_archive"
	case "delete":
		count = batchMoveToRole(req.IDs, "trash")
		remoteAction = "move_to_trash"
	case "restore":
		count = batchRestore(req.IDs)
		remoteAction = "restore"
	case "permanent_delete":
		count = batchPermanentDelete(req.IDs)
		remoteAction = "permanent_delete"
	case "mark_read":
		count = batchSetRead(req.IDs, true)
	case "mark_unread":
		count = batchSetRead(req.IDs, false)
	case "star":
		count = batchSetStarred(req.IDs, true)
	case "unstar":
		count = batchSetStarred(req.IDs, false)
	default:
		respondError(w, http.StatusBadRequest, "Unknown action")
		return
	}
	for _, id := range req.IDs {
		enqueueRemoteOp(id, remoteAction, remotePayload)
	}

	respondJSON(w, http.StatusOK, map[string]int64{"count": count})
}

func batchMoveToRole(ids []int64, role string) int64 {
	stmt, _ := database.DB.Prepare(`UPDATE messages SET
		previous_folder_id = folder_id,
		folder_id = (
			SELECT f2.id FROM folders f2
			WHERE f2.account_id = messages.account_id AND f2.role = ?
			LIMIT 1
		), updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`)
	defer stmt.Close()
	var n int64
	for _, id := range ids {
		r, _ := stmt.Exec(role, id)
		if r != nil {
			x, _ := r.RowsAffected()
			n += x
		}
	}
	return n
}

func batchMarkDeleted(ids []int64) int64 {
	stmt, _ := database.DB.Prepare(`UPDATE messages SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
	defer stmt.Close()
	var n int64
	for _, id := range ids {
		r, _ := stmt.Exec(id)
		if r != nil {
			x, _ := r.RowsAffected()
			n += x
		}
	}
	return n
}

func batchSetRead(ids []int64, read bool) int64 {
	var n int64
	for _, id := range ids {
		if err := setMessageReadState(id, read); err == nil {
			n++
		}
	}
	return n
}

func batchSetStarred(ids []int64, starred bool) int64 {
	var n int64
	for _, id := range ids {
		if err := setMessageStarredState(id, starred); err == nil {
			n++
		}
	}
	return n
}

func setMessageReadState(id int64, read bool) error {
	return setRelatedMessageBool(id, "is_read", read)
}

func setMessageStarredState(id int64, starred bool) error {
	return setRelatedMessageBool(id, "is_starred", starred)
}

func setRelatedMessageBool(id int64, column string, value bool) error {
	if column != "is_read" && column != "is_starred" {
		return fmt.Errorf("unsupported message bool column %s", column)
	}
	var accountID int64
	var messageID string
	if err := database.DB.QueryRow(
		"SELECT account_id, COALESCE(message_id, '') FROM messages WHERE id = ?",
		id,
	).Scan(&accountID, &messageID); err != nil {
		return err
	}
	messageID = strings.ToLower(strings.TrimSpace(messageID))
	if messageID == "" {
		_, err := database.DB.Exec(
			"UPDATE messages SET "+column+" = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			value, id,
		)
		return err
	}
	_, err := database.DB.Exec(
		"UPDATE messages SET "+column+" = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ? AND LOWER(TRIM(COALESCE(message_id, ''))) = ?",
		value, accountID, messageID,
	)
	return err
}

// batchRestore moves messages back to their original folder (stored in
// previous_folder_id, falling back to inbox). Mirrors the single-message
// RestoreMessage logic.
func batchRestore(ids []int64) int64 {
	stmt, _ := database.DB.Prepare(`UPDATE messages SET
		folder_id = COALESCE(
			previous_folder_id,
			(SELECT f.id FROM folders f
			 WHERE f.account_id = messages.account_id AND f.role = 'inbox'
			 LIMIT 1)
		),
		previous_folder_id = folder_id,
		is_deleted = 0,
		updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`)
	defer stmt.Close()
	var n int64
	for _, id := range ids {
		r, _ := stmt.Exec(id)
		if r != nil {
			x, _ := r.RowsAffected()
			n += x
		}
	}
	return n
}

// batchPermanentDelete marks messages as permanently deleted locally.
// The IMAP push processor will expunge them from the server.
func batchPermanentDelete(ids []int64) int64 {
	stmt, _ := database.DB.Prepare(`UPDATE messages SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
	defer stmt.Close()
	var n int64
	for _, id := range ids {
		r, _ := stmt.Exec(id)
		if r != nil {
			x, _ := r.RowsAffected()
			n += x
		}
	}
	return n
}

func enqueueRemoteOp(messageID int64, action string, payload string) {
	var accountID int64
	if err := database.DB.QueryRow("SELECT account_id FROM messages WHERE id = ?", messageID).Scan(&accountID); err != nil {
		log.Printf("enqueueRemoteOp account lookup failed for message %d: %v", messageID, err)
		return
	}
	if payload == "" {
		payload = "{}"
	}
	switch action {
	case "toggle_read", "mark_read", "mark_unread":
		database.DB.Exec(
			`UPDATE pending_remote_ops SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
			 WHERE message_id = ? AND status = 'pending'
			 AND action IN ('toggle_read', 'mark_read', 'mark_unread')`,
			messageID,
		)
	case "toggle_star", "star", "unstar":
		database.DB.Exec(
			`UPDATE pending_remote_ops SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
			 WHERE message_id = ? AND status = 'pending'
			 AND action IN ('toggle_star', 'star', 'unstar')`,
			messageID,
		)
	}
	if _, err := database.DB.Exec(
		`INSERT INTO pending_remote_ops (account_id, message_id, action, payload)
		 VALUES (?, ?, ?, ?)`,
		accountID, messageID, action, payload,
	); err != nil {
		log.Printf("enqueueRemoteOp insert failed for message %d action %s: %v", messageID, action, err)
		return
	}

	// Push the op to the IMAP server in the background so flag changes
	// are reflected on the server promptly instead of waiting for the
	// next scheduled sync cycle.
	go func() {
		time.Sleep(500 * time.Millisecond) // small delay to batch rapid ops
		imap.PushPendingOps()
	}()
}

func SendMessage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID    int64             `json:"account_id"`
		ToAddresses  []string          `json:"to_addresses"`
		CcAddresses  []string          `json:"cc_addresses"`
		BccAddresses []string          `json:"bcc_addresses"`
		Subject      string            `json:"subject"`
		BodyHTML     string            `json:"body_html"`
		BodyText     string            `json:"body_text"`
		InReplyTo    string            `json:"in_reply_to"`
		References   string            `json:"references"`
		Attachments  []attachmentInput `json:"attachments"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.AccountID == 0 {
		respondError(w, http.StatusBadRequest, "account_id is required")
		return
	}
	if len(req.ToAddresses) == 0 {
		respondError(w, http.StatusBadRequest, "to_addresses is required")
		return
	}

	toJSON := strings.Join(stringListToJSON(req.ToAddresses), "")
	ccJSON := strings.Join(stringListToJSON(req.CcAddresses), "")
	bccJSON := strings.Join(stringListToJSON(req.BccAddresses), "")

	// Locate the "Sent" folder for the account, or fall back to the first folder
	var folderID int64
	err := database.DB.QueryRow(
		`SELECT id FROM folders WHERE account_id = ? AND role = 'sent' LIMIT 1`,
		req.AccountID,
	).Scan(&folderID)
	if err != nil {
		// fall back to the first folder
		err = database.DB.QueryRow(
			`SELECT id FROM folders WHERE account_id = ? ORDER BY id LIMIT 1`,
			req.AccountID,
		).Scan(&folderID)
		if err != nil {
			if err == sql.ErrNoRows {
				respondError(w, http.StatusBadRequest, "No folder configured for account; please create folders first")
				return
			}
			respondError(w, http.StatusInternalServerError, "Failed to find folder")
			return
		}
	}

	fromAddress, fromName, _ := lookupFromAddress(req.AccountID)
	snippet := buildSnippet(req.BodyText)

	if err := deliverSMTP(req.AccountID, outboundMessage{
		FromName:     fromName,
		FromAddress:  fromAddress,
		ToAddresses:  req.ToAddresses,
		CcAddresses:  req.CcAddresses,
		BccAddresses: req.BccAddresses,
		Subject:      req.Subject,
		BodyHTML:     req.BodyHTML,
		BodyText:     req.BodyText,
		Attachments:  req.Attachments,
	}); err != nil {
		log.Printf("SendMessage SMTP error: %v", err)
		respondError(w, http.StatusBadGateway, "Failed to send message")
		return
	}

	uid := time.Now().Unix()
	res, err := database.DB.Exec(`INSERT INTO messages (
		account_id, folder_id, uid, message_id,
		subject, from_address, from_name,
		to_addresses, cc_addresses, bcc_addresses,
		reply_to, body_text, body_html, snippet,
		received_at, sent_at, size,
		is_read, is_starred, is_answered, is_forwarded, is_draft, is_deleted,
		has_attachments, labels, thread_id, in_reply_to, ref_references
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, 1, 0, 0, 0, 0, 0, 0, '[]', ?, ?, ?)`,
		req.AccountID, folderID, uid, generateMessageID(),
		req.Subject, fromAddress, fromName,
		toJSON, ccJSON, bccJSON,
		"",
		req.BodyText, req.BodyHTML, snippet,
		int64(len(req.BodyText)),
		"", req.InReplyTo, req.References,
	)
	if err != nil {
		log.Printf("SendMessage insert error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to send message")
		return
	}
	id, _ := res.LastInsertId()

	// Store any attachments that were uploaded with the message.
	if len(req.Attachments) > 0 {
		storeAttachments(id, req.Attachments)
		// Mark the message as having attachments so the list/detail UI can
		// show the paperclip icon.
		database.DB.Exec("UPDATE messages SET has_attachments = 1 WHERE id = ?", id)
	}

	respondJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

func stringListToJSON(items []string) []string {
	if len(items) == 0 {
		return []string{"[]"}
	}
	out := "["
	for i, it := range items {
		if i > 0 {
			out += ","
		}
		b, _ := json.Marshal(it)
		out += string(b)
	}
	out += "]"
	return []string{out}
}

func buildSnippet(body string) string {
	body = strings.TrimSpace(body)
	if len(body) > 200 {
		return body[:200]
	}
	return body
}

func lookupFromAddress(accountID int64) (string, string, error) {
	var name, email string
	err := database.DB.QueryRow(
		`SELECT name, COALESCE(NULLIF(sender_email, ''), email) FROM accounts WHERE id = ?`, accountID,
	).Scan(&name, &email)
	if err != nil {
		return "", "", err
	}
	return email, name, nil
}

func generateMessageID() string {
	// Random suffix keeps the local message-id unique per send.
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "mailgo-" + time.Now().UTC().Format("20060102T150405Z") + "-" + hex.EncodeToString(b)
}

type outboundMessage struct {
	FromName     string
	FromAddress  string
	ToAddresses  []string
	CcAddresses  []string
	BccAddresses []string
	Subject      string
	BodyHTML     string
	BodyText     string
	Attachments  []attachmentInput
}

type smtpAccount struct {
	Host       string
	Port       int
	UseTLS     bool
	Encryption string // "ssl", "starttls", "none"
	Username   string
	Password   string
	OAuthToken string
}

func deliverSMTP(accountID int64, msg outboundMessage) error {
	var account smtpAccount
	var provider string
	err := database.DB.QueryRow(
		`SELECT smtp_host, smtp_port, smtp_tls, COALESCE(smtp_encryption, ''), username,
		 COALESCE(password_encrypted, ''), COALESCE(provider, '')
		 FROM accounts WHERE id = ?`,
		accountID,
	).Scan(&account.Host, &account.Port, &account.UseTLS, &account.Encryption, &account.Username, &account.Password, &provider)
	if err != nil {
		return fmt.Errorf("account lookup failed: %w", err)
	}
	if dec, decErr := crypto.Decrypt(account.Password); decErr == nil {
		account.Password = dec
	}
	if provider == "microsoft" {
		token, tokenErr := microsoftauth.AccessTokenForAccount(context.Background(), accountID)
		if tokenErr != nil {
			return fmt.Errorf("Microsoft OAuth token: %w", tokenErr)
		}
		account.OAuthToken = token
	}
	if account.Host == "" || account.Username == "" {
		return fmt.Errorf("SMTP account is not configured")
	}
	if account.Port == 0 {
		account.Port = 587
	}
	if err := validateOutboundMessage(msg); err != nil {
		return err
	}
	// Fall back to the legacy boolean when encryption is empty.
	if account.Encryption == "" {
		if account.UseTLS && account.Port == 465 {
			account.Encryption = "ssl"
		} else if account.UseTLS {
			account.Encryption = "starttls"
		} else {
			account.Encryption = "none"
		}
	}

	recipients := normalizeRecipients(append(append([]string{}, msg.ToAddresses...), append(msg.CcAddresses, msg.BccAddresses...)...))
	if len(recipients) == 0 {
		return fmt.Errorf("no recipients")
	}
	raw, err := buildMIMEMessage(msg)
	if err != nil {
		return err
	}
	return sendSMTP(account, msg.FromAddress, recipients, raw)
}

func buildMIMEMessage(msg outboundMessage) ([]byte, error) {
	messageID := "<" + generateMessageID() + "@mailgo.local>"
	date := time.Now().Format(time.RFC1123Z)
	headers := []string{
		"From: " + formatAddressHeader(msg.FromName, msg.FromAddress),
		"To: " + strings.Join(sanitizeAddressHeaders(msg.ToAddresses), ", "),
		"Subject: " + mime.QEncoding.Encode("utf-8", sanitizeHeader(msg.Subject)),
		"Date: " + date,
		"Message-ID: " + messageID,
		"MIME-Version: 1.0",
	}
	if len(msg.CcAddresses) > 0 {
		headers = append(headers, "Cc: "+strings.Join(sanitizeAddressHeaders(msg.CcAddresses), ", "))
	}

	inline, regular := splitAttachments(msg.Attachments)
	bodyHTML := msg.BodyHTML
	if bodyHTML == "" {
		bodyHTML = strings.ReplaceAll(escapeHTML(msg.BodyText), "\n", "<br/>")
	}
	bodyText := msg.BodyText
	if bodyText == "" {
		bodyText = stripSimpleHTML(bodyHTML)
	}

	var out bytes.Buffer
	if len(regular) == 0 && len(inline) == 0 {
		for _, h := range headers {
			out.WriteString(h + "\r\n")
		}
		out.WriteString("Content-Type: text/html; charset=utf-8\r\n")
		out.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
		out.WriteString(toQuotedPrintable(bodyHTML))
		return out.Bytes(), nil
	}

	mixedBoundary := "mailgo-mixed-" + randomHex(8)
	relatedBoundary := "mailgo-related-" + randomHex(8)
	for _, h := range headers {
		out.WriteString(h + "\r\n")
	}
	out.WriteString(`Content-Type: multipart/mixed; boundary="` + mixedBoundary + "\"\r\n\r\n")
	out.WriteString("--" + mixedBoundary + "\r\n")

	if len(inline) > 0 {
		out.WriteString(`Content-Type: multipart/related; boundary="` + relatedBoundary + "\"\r\n\r\n")
		writeHTMLPart(&out, relatedBoundary, bodyHTML, bodyText)
		for _, att := range inline {
			writeAttachmentPart(&out, relatedBoundary, att, true)
		}
		out.WriteString("--" + relatedBoundary + "--\r\n")
	} else {
		writeHTMLBodyOnly(&out, bodyHTML)
	}

	for _, att := range regular {
		writeAttachmentPart(&out, mixedBoundary, att, false)
	}
	out.WriteString("--" + mixedBoundary + "--\r\n")
	return out.Bytes(), nil
}

func sendSMTP(account smtpAccount, from string, recipients []string, data []byte) error {
	addr := fmt.Sprintf("%s:%d", account.Host, account.Port)
	fromAddr := extractEmail(from)
	if fromAddr == "" {
		return fmt.Errorf("empty from address")
	}

	// Choose the authentication strategy. We use smtp.PlainAuth which
	// works with the vast majority of servers (QQ, 163, Gmail app
	// passwords, Outlook, etc). When connecting over a plaintext socket
	// PlainAuth would normally refuse to send the password, but since we
	// always upgrade to TLS (implicit on 465, STARTTLS on 587/25) the
	// connection is encrypted before auth happens.
	var auth smtp.Auth
	if account.OAuthToken != "" {
		auth = microsoftauth.NewSMTPAuth(account.Username, account.OAuthToken)
	} else if account.Password != "" {
		auth = smtp.PlainAuth("", account.Username, account.Password, account.Host)
	}

	tlsConfig := &tls.Config{ServerName: account.Host, MinVersion: tls.VersionTLS12}

	switch account.Encryption {
	case "ssl":
		// Implicit TLS (SMTPS, typically port 465). The standard library's
		// smtp.SendMail does not support implicit TLS, so we dial a TLS
		// connection ourselves and run the SMTP client on top of it.
		conn, err := tls.Dial("tcp", addr, tlsConfig)
		if err != nil {
			return fmt.Errorf("SMTPS connect %s: %w", addr, err)
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(60 * time.Second))

		c, err := smtp.NewClient(conn, account.Host)
		if err != nil {
			return fmt.Errorf("SMTPS hello: %w", err)
		}
		defer c.Quit()

		return runSMTPClient(c, auth, fromAddr, recipients, data)

	case "none":
		// Plain text, no encryption (not recommended, port 25).
		// smtp.PlainAuth refuses to send passwords over plaintext, so we
		// only use auth when the password is empty (local relay).
		var plainAuth smtp.Auth
		if account.OAuthToken != "" {
			return fmt.Errorf("Microsoft XOAUTH2 requires TLS")
		}
		if account.Password != "" {
			plainAuth = smtp.PlainAuth("", account.Username, account.Password, account.Host)
		}
		// The MIME payload has passed validateOutboundMessage; all user-controlled
		// headers are parsed as RFC 5322 addresses or rejected, and bodies are
		// quoted-printable encoded by buildMIMEMessage.
		// codeql[go/email-injection]
		return smtp.SendMail(addr, plainAuth, fromAddr, recipients, data)

	default:
		// "starttls" or empty — smtp.SendMail handles STARTTLS upgrade
		// and authentication automatically. When the server advertises
		// STARTTLS, smtp.SendMail will upgrade the connection before
		// authenticating.
		// codeql[go/email-injection]
		return smtp.SendMail(addr, auth, fromAddr, recipients, data)
	}
}

// runSMTPClient drives an existing *smtp.Client (already connected) through
// auth, MAIL FROM, RCPT TO, DATA and QUIT. Used by the implicit-TLS path.
func runSMTPClient(c *smtp.Client, auth smtp.Auth, from string, recipients []string, data []byte) error {
	if err := c.Hello("mailgo.local"); err != nil {
		return fmt.Errorf("EHLO: %w", err)
	}
	if auth != nil {
		if ok, _ := c.Extension("AUTH"); ok {
			if err := c.Auth(auth); err != nil {
				return fmt.Errorf("AUTH: %w", err)
			}
		}
	}
	if err := c.Mail(from); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	for _, rcpt := range recipients {
		if err := c.Rcpt(rcpt); err != nil {
			return fmt.Errorf("RCPT TO %s: %w", rcpt, err)
		}
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	// codeql[go/email-injection]
	if _, err := w.Write(data); err != nil {
		return fmt.Errorf("DATA write: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("DATA close: %w", err)
	}
	return nil
}

func smtpCommand(conn net.Conn, cmd string, okCodes ...string) error {
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return fmt.Errorf("SMTP write failed: %w", err)
	}
	resp, err := readSMTPResponse(conn)
	if err != nil {
		return fmt.Errorf("SMTP response failed: %w", err)
	}
	for _, code := range okCodes {
		if strings.HasPrefix(resp, code) {
			return nil
		}
	}
	return fmt.Errorf("SMTP rejected command: %s", firstLine(resp))
}

func writeHTMLPart(out *bytes.Buffer, boundary, html, text string) {
	altBoundary := "mailgo-alt-" + randomHex(8)
	out.WriteString("--" + boundary + "\r\n")
	out.WriteString("Content-Type: multipart/alternative; boundary=\"" + altBoundary + "\"\r\n\r\n")
	out.WriteString("--" + altBoundary + "\r\n")
	out.WriteString("Content-Type: text/plain; charset=utf-8\r\n")
	out.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	out.WriteString(toQuotedPrintable(text) + "\r\n")
	out.WriteString("--" + altBoundary + "\r\n")
	out.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	out.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	out.WriteString(toQuotedPrintable(html) + "\r\n")
	out.WriteString("--" + altBoundary + "--\r\n")
}

func writeHTMLBodyOnly(out *bytes.Buffer, html string) {
	out.WriteString("Content-Type: text/html; charset=utf-8\r\n")
	out.WriteString("Content-Transfer-Encoding: quoted-printable\r\n\r\n")
	out.WriteString(toQuotedPrintable(html) + "\r\n")
}

func writeAttachmentPart(out *bytes.Buffer, boundary string, att attachmentInput, inline bool) {
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	mimeType := safeMIMEType(att.MimeType)
	filename := sanitizeHeader(att.Filename)
	out.WriteString("--" + boundary + "\r\n")
	out.WriteString("Content-Type: " + mimeType + "; name=\"" + escapeHeaderParam(filename) + "\"\r\n")
	out.WriteString("Content-Transfer-Encoding: base64\r\n")
	out.WriteString("Content-Disposition: " + disposition + "; filename=\"" + escapeHeaderParam(filename) + "\"\r\n")
	if inline && att.ContentID != "" {
		out.WriteString("Content-ID: <" + sanitizeContentID(att.ContentID) + ">\r\n")
	}
	out.WriteString("\r\n")
	out.WriteString(wrapBase64(att.DataBase64))
	out.WriteString("\r\n")
}

func splitAttachments(atts []attachmentInput) ([]attachmentInput, []attachmentInput) {
	inline := make([]attachmentInput, 0)
	regular := make([]attachmentInput, 0)
	for _, att := range atts {
		if att.ContentID != "" {
			inline = append(inline, att)
		} else {
			regular = append(regular, att)
		}
	}
	return inline, regular
}

func normalizeRecipients(raw []string) []string {
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, item := range raw {
		email := extractEmail(item)
		if email == "" || seen[email] {
			continue
		}
		seen[email] = true
		out = append(out, email)
	}
	return out
}

func extractEmail(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if addr, err := mail.ParseAddress(raw); err == nil {
		return sanitizeEmail(addr.Address)
	}
	return sanitizeEmail(raw)
}

func sanitizeAddressHeaders(items []string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if strings.ContainsAny(item, "\r\n") {
			continue
		}
		if address, err := mail.ParseAddress(item); err == nil {
			email := sanitizeEmail(address.Address)
			if email != "" {
				out = append(out, (&mail.Address{
					Name:    sanitizeHeader(address.Name),
					Address: email,
				}).String())
			}
		}
	}
	return out
}

func formatAddressHeader(name, address string) string {
	address = extractEmail(address)
	name = sanitizeHeader(name)
	if name == "" {
		return address
	}
	return mime.QEncoding.Encode("utf-8", name) + " <" + address + ">"
}

func sanitizeHeader(value string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", "", "\n", "").Replace(value))
}

func sanitizeEmail(value string) string {
	if strings.ContainsAny(value, "\r\n") {
		return ""
	}
	value = sanitizeHeader(value)
	value = strings.Trim(value, "<>")
	if strings.ContainsAny(value, " \t") || strings.Count(value, "@") != 1 {
		return ""
	}
	parsed, err := mail.ParseAddress(value)
	if err != nil || !strings.EqualFold(parsed.Address, value) {
		return ""
	}
	return value
}

func validateOutboundMessage(msg outboundMessage) error {
	if strings.ContainsAny(msg.FromName+msg.FromAddress+msg.Subject, "\r\n") {
		return fmt.Errorf("message headers contain forbidden line breaks")
	}
	if extractEmail(msg.FromAddress) == "" {
		return fmt.Errorf("invalid sender address")
	}
	for _, group := range [][]string{msg.ToAddresses, msg.CcAddresses, msg.BccAddresses} {
		for _, raw := range group {
			if strings.ContainsAny(raw, "\r\n") || extractEmail(raw) == "" {
				return fmt.Errorf("invalid recipient address")
			}
		}
	}
	for _, att := range msg.Attachments {
		if strings.ContainsAny(att.Filename+att.MimeType+att.ContentID, "\r\n") {
			return fmt.Errorf("attachment headers contain forbidden line breaks")
		}
	}
	return nil
}

func safeMIMEType(value string) string {
	mediaType, _, err := mime.ParseMediaType(sanitizeHeader(value))
	if err != nil || !strings.Contains(mediaType, "/") {
		return "application/octet-stream"
	}
	return mediaType
}

func sanitizeContentID(value string) string {
	value = strings.Trim(sanitizeHeader(value), "<>")
	var out strings.Builder
	for _, r := range value {
		if r == '@' || r == '.' || r == '-' || r == '_' ||
			(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func escapeHeaderParam(value string) string {
	return strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(value)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func wrapBase64(value string) string {
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.ReplaceAll(value, "\n", "")
	var out strings.Builder
	for len(value) > 76 {
		out.WriteString(value[:76] + "\r\n")
		value = value[76:]
	}
	out.WriteString(value)
	return out.String()
}

func toQuotedPrintable(value string) string {
	var out bytes.Buffer
	w := quotedprintable.NewWriter(&out)
	_, _ = w.Write([]byte(value))
	_ = w.Close()
	return out.String()
}

func escapeHTML(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;")
	return replacer.Replace(value)
}

func stripSimpleHTML(value string) string {
	value = strings.ReplaceAll(value, "<br/>", "\n")
	value = strings.ReplaceAll(value, "<br>", "\n")
	value = strings.ReplaceAll(value, "<br />", "\n")
	var out strings.Builder
	inTag := false
	for _, r := range value {
		switch r {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				out.WriteRune(r)
			}
		}
	}
	return out.String()
}

func dotStuff(data []byte) []byte {
	normalized := strings.ReplaceAll(string(data), "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	var out strings.Builder
	for _, line := range lines {
		if strings.HasPrefix(line, ".") {
			out.WriteString(".")
		}
		out.WriteString(line + "\r\n")
	}
	out.WriteString(".\r\n")
	return []byte(out.String())
}

// Helper functions

func parseIntParam(s string, defaultVal int) int {
	if s == "" {
		return defaultVal
	}
	v := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return defaultVal
		}
		v = v*10 + int(c-'0')
	}
	if v < 1 {
		return defaultVal
	}
	return v
}

func toBool(v interface{}) (bool, bool) {
	switch val := v.(type) {
	case bool:
		return val, true
	case float64:
		return val != 0, true
	case string:
		return val == "true" || val == "1", true
	default:
		return false, false
	}
}
