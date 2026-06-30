package models

import (
	"database/sql"
	"time"
)

type Message struct {
	ID             int64          `json:"id"`
	AccountID      int64          `json:"account_id"`
	FolderID       int64          `json:"folder_id"`
	UID            int64          `json:"uid"`
	MessageID      sql.NullString `json:"-"`
	MessageIDStr   string         `json:"message_id"`
	Subject        string         `json:"subject"`
	FromAddress    string         `json:"from_address"`
	FromName       string         `json:"from_name"`
	ToAddresses    string         `json:"to_addresses"`
	CcAddresses    string         `json:"cc_addresses"`
	BccAddresses   string         `json:"bcc_addresses"`
	ReplyTo        sql.NullString `json:"-"`
	ReplyToStr     string         `json:"reply_to"`
	BodyText       sql.NullString `json:"-"`
	BodyTextStr    string         `json:"body_text"`
	BodyHTML       sql.NullString `json:"-"`
	BodyHTMLStr    string         `json:"body_html"`
	Snippet        string         `json:"snippet"`
	ReceivedAt     time.Time      `json:"received_at"`
	SentAt         sql.NullString `json:"-"`
	SentAtStr      string         `json:"sent_at"`
	Size           int64          `json:"size"`
	IsRead         bool           `json:"is_read"`
	IsStarred      bool           `json:"is_starred"`
	IsAnswered     bool           `json:"is_answered"`
	IsForwarded    bool           `json:"is_forwarded"`
	IsDraft        bool           `json:"is_draft"`
	IsDeleted      bool           `json:"is_deleted"`
	HasAttachments bool           `json:"has_attachments"`
	Labels         string         `json:"labels"`
	ThreadID       sql.NullString `json:"-"`
	ThreadIDStr    string         `json:"thread_id"`
	InReplyTo      sql.NullString `json:"-"`
	InReplyToStr   string         `json:"in_reply_to"`
	References     sql.NullString `json:"-"`
	ReferencesStr  string         `json:"references"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`

	// Joined fields
	FolderName string `json:"folder_name,omitempty"`
}

// AfterScan normalizes nullable fields for JSON output
func (m *Message) AfterScan() {
	m.MessageIDStr = m.MessageID.String
	m.ReplyToStr = m.ReplyTo.String
	m.BodyTextStr = m.BodyText.String
	m.BodyHTMLStr = m.BodyHTML.String
	m.SentAtStr = m.SentAt.String
	m.ThreadIDStr = m.ThreadID.String
	m.InReplyToStr = m.InReplyTo.String
	m.ReferencesStr = m.References.String
}

type MessageListResponse struct {
	Messages    []Message `json:"messages"`
	Total       int       `json:"total"`
	Page        int       `json:"page"`
	PageSize    int       `json:"page_size"`
	UnreadCount int       `json:"unread_count"`
}

type SendMessageRequest struct {
	AccountID    int64    `json:"account_id"`
	ToAddresses  []string `json:"to_addresses"`
	CcAddresses  []string `json:"cc_addresses"`
	BccAddresses []string `json:"bcc_addresses"`
	Subject      string   `json:"subject"`
	BodyHTML     string   `json:"body_html"`
	BodyText     string   `json:"body_text"`
	InReplyTo    string   `json:"in_reply_to"`
	References   string   `json:"references"`
}
