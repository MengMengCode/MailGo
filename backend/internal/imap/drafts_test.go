package imap

import (
	"database/sql"
	"strings"
	"testing"
	"time"
)

func TestRemoteDraftCopyIsStale(t *testing.T) {
	current := remoteDraftCopy{
		DraftID:        sql.NullInt64{Int64: 7, Valid: true},
		AccountID:      sql.NullInt64{Int64: 2, Valid: true},
		IsTrashed:      sql.NullBool{Bool: false, Valid: true},
		Revision:       sql.NullInt64{Int64: 4, Valid: true},
		SyncedRevision: 4,
	}
	if remoteDraftCopyIsStale(current, 2) {
		t.Fatal("current remote copy was marked stale")
	}

	changed := current
	changed.Revision.Int64 = 5
	if !remoteDraftCopyIsStale(changed, 2) {
		t.Fatal("changed draft was not marked stale")
	}

	moved := current
	moved.AccountID.Int64 = 3
	if !remoteDraftCopyIsStale(moved, 2) {
		t.Fatal("account change was not marked stale")
	}

	trashed := current
	trashed.IsTrashed.Bool = true
	if !remoteDraftCopyIsStale(trashed, 2) {
		t.Fatal("trashed draft was not marked stale")
	}
}

func TestBuildRemoteDraftMIME(t *testing.T) {
	draft := localDraftSnapshot{
		ID:           12,
		AccountID:    3,
		ToAddresses:  `["Alice <alice@example.com>"]`,
		CcAddresses:  `[{"name":"Bob","address":"bob@example.com"}]`,
		BccAddresses: `[]`,
		Subject:      "测试草稿",
		BodyHTML:     "<p>Hello</p>",
		InReplyTo:    "<original@example.com>",
		References:   "<original@example.com>",
		Revision:     6,
		UpdatedAt:    time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC),
	}
	raw, err := buildRemoteDraftMIME(
		draft,
		"Sender",
		"sender@example.com",
		"<mailgo-draft-12-r6@mailgo.local>",
	)
	if err != nil {
		t.Fatal(err)
	}
	message := string(raw)
	for _, expected := range []string{
		`From: "Sender" <sender@example.com>`,
		`To: "Alice" <alice@example.com>`,
		`Cc: "Bob" <bob@example.com>`,
		"Message-ID: <mailgo-draft-12-r6@mailgo.local>",
		"X-MailGo-Draft-ID: 12",
		"Content-Type: text/html; charset=utf-8",
	} {
		if !strings.Contains(message, expected) {
			t.Errorf("MIME message missing %q:\n%s", expected, message)
		}
	}
}
