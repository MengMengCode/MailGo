package models

import (
	"database/sql"
	"time"
)

type Account struct {
	ID               int64        `json:"id"`
	Name             string       `json:"name"`
	Email            string       `json:"email"`
	Provider         string       `json:"provider"`
	ImapHost         string       `json:"imap_host"`
	ImapPort         int          `json:"imap_port"`
	ImapTLS          bool         `json:"imap_tls"`
	ImapEncryption   string       `json:"imap_encryption"`
	SmtpHost         string       `json:"smtp_host"`
	SmtpPort         int          `json:"smtp_port"`
	SmtpTLS          bool         `json:"smtp_tls"`
	SmtpEncryption   string       `json:"smtp_encryption"`
	Username         string       `json:"username"`
	SenderEmail      string       `json:"sender_email"`
	AvatarURL        string       `json:"avatar_url"`
	AutoReplyEnabled bool         `json:"auto_reply_enabled"`
	AutoReplySubject string       `json:"auto_reply_subject"`
	AutoReplyBody    string       `json:"auto_reply_body"`
	ProxyEnabled     bool         `json:"proxy_enabled"`
	ProxyHost        string       `json:"proxy_host"`
	ProxyPort        int          `json:"proxy_port"`
	IsDefault        bool         `json:"is_default"`
	TagColor         string       `json:"tag_color"`
	SyncDays         int          `json:"sync_days"`
	LastSyncAt       sql.NullTime `json:"last_sync_at"`
	CreatedAt        time.Time    `json:"created_at"`
	UpdatedAt        time.Time    `json:"updated_at"`
}

type AccountCreateRequest struct {
	Name             string `json:"name"`
	Email            string `json:"email"`
	Provider         string `json:"provider"`
	ImapHost         string `json:"imap_host"`
	ImapPort         int    `json:"imap_port"`
	ImapTLS          bool   `json:"imap_tls"`
	ImapEncryption   string `json:"imap_encryption"`
	SmtpHost         string `json:"smtp_host"`
	SmtpPort         int    `json:"smtp_port"`
	SmtpTLS          bool   `json:"smtp_tls"`
	SmtpEncryption   string `json:"smtp_encryption"`
	Username         string `json:"username"`
	Password         string `json:"password"`
	SenderEmail      string `json:"sender_email"`
	AvatarURL        string `json:"avatar_url"`
	AutoReplyEnabled bool   `json:"auto_reply_enabled"`
	AutoReplySubject string `json:"auto_reply_subject"`
	AutoReplyBody    string `json:"auto_reply_body"`
	ProxyEnabled     bool   `json:"proxy_enabled"`
	ProxyHost        string `json:"proxy_host"`
	ProxyPort        int    `json:"proxy_port"`
	TagColor         string `json:"tag_color"`
	SyncDays         int    `json:"sync_days"`
}
