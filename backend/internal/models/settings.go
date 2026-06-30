package models

import (
	"time"
)

type Setting struct {
	ID        int64     `json:"id"`
	Key       string    `json:"key"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Draft struct {
	ID int64 `json:"id"`
	// AccountID is nullable in the database (drafts without an account)
	// so we use a pointer to keep the JSON shape flat: `null` instead of
	// `{"Int64":0,"Valid":false}`.
	AccountID    *int64    `json:"account_id"`
	ToAddresses  string    `json:"to_addresses"`
	CcAddresses  string    `json:"cc_addresses"`
	BccAddresses string    `json:"bcc_addresses"`
	Subject      string    `json:"subject"`
	BodyHTML     string    `json:"body_html"`
	BodyText     string    `json:"body_text"`
	InReplyTo    string    `json:"in_reply_to"`
	References   string    `json:"references"`
	IsTrashed    bool      `json:"is_trashed"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (d *Draft) AfterScan() {
	// Backwards compat — kept as a no-op so existing callers don't break.
}
