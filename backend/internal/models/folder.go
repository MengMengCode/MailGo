package models

import (
	"database/sql"
	"time"
)

type Folder struct {
	ID           int64        `json:"id"`
	AccountID    int64        `json:"account_id"`
	Name         string       `json:"name"`
	Role         string       `json:"role"`
	UIDValidity  sql.NullInt64 `json:"uid_validity"`
	UIDNext      sql.NullInt64 `json:"uid_next"`
	LastSyncedAt sql.NullTime  `json:"last_synced_at"`
	CreatedAt    time.Time    `json:"created_at"`
	UnreadCount  int          `json:"unread_count"`
	TotalCount   int          `json:"total_count"`
}

func (f *Folder) AfterScan() {
	// noop
}
