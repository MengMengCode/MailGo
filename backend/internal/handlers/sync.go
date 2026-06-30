package handlers

import (
	"database/sql"
	"log"
	"mailgo/internal/database"
	"mailgo/internal/imap"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// SyncRequest allows the caller to scope a sync to a specific account.
// When AccountID is zero, every account is synced.
type SyncRequest struct {
	AccountID          int64 `json:"account_id"`
	IncludeHistory     bool  `json:"include_history"`
	IncludeAttachments bool  `json:"include_attachments"`
}

// SyncResult describes the outcome of a sync invocation.
type SyncResult struct {
	OK             bool      `json:"ok"`
	SyncedAccounts int       `json:"synced_accounts"`
	NewMessages    int       `json:"new_messages"`
	LastSyncAt     time.Time `json:"last_sync_at"`
	Message        string    `json:"message"`
}

// TriggerSync kicks off an IMAP sync in the background and returns
// immediately. If a sync is already running, returns 409 Conflict so the
// caller knows to poll status instead of queuing another run.
func TriggerSync(w http.ResponseWriter, r *http.Request) {
	// Single-flight: reject if a sync is already in progress.
	if imap.IsSyncRunning() {
		respondJSON(w, http.StatusConflict, map[string]interface{}{
			"syncing": true,
			"message": "Sync already in progress",
		})
		return
	}

	var req SyncRequest
	if r.ContentLength > 0 {
		if err := decodeJSON(r, &req); err != nil {
			respondError(w, http.StatusBadRequest, "Invalid request body")
			return
		}
	}

	configs, err := imap.LoadAccountConfigs(req.AccountID)
	if err != nil {
		log.Printf("TriggerSync load accounts error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to load accounts")
		return
	}
	log.Printf("TriggerSync: starting sync for %d account(s)", len(configs))

	// Acquire the global sync flag. If someone else grabbed it between
	// our check above and here, treat it as a 409.
	if !imap.TryBeginGlobalSync() {
		respondJSON(w, http.StatusConflict, map[string]interface{}{
			"syncing": true,
			"message": "Sync already in progress",
		})
		return
	}

	// Push pending operations synchronously (fast), then run the actual
	// IMAP sync in a goroutine so the HTTP response returns immediately.
	imap.PushPendingOps()

	go func() {
		defer imap.EndGlobalSync()

		// Reconcile local drafts before pulling mail so their remote Drafts
		// copies are already current during this sync cycle.
		imap.PushLocalDrafts()

		// Sync all accounts concurrently.
		var wg sync.WaitGroup
		var mu sync.Mutex
		synced := 0
		newMsgs := 0

		for _, cfg := range configs {
			wg.Add(1)
			go func(c imap.AccountConfig) {
				defer wg.Done()
				res := imap.SyncAccount(c)
				mu.Lock()
				if res.OK {
					synced++
					newMsgs += res.NewMessages
				} else if res.Error != nil {
					log.Printf("TriggerSync account %d (%s) error: %v", c.ID, c.Username, res.Error)
				}
				mu.Unlock()
			}(cfg)
		}
		wg.Wait()

		imap.RepairGarbledBodies()
		log.Printf("TriggerSync: background sync finished, %d account(s), %d new message(s)", synced, newMsgs)
	}()

	respondJSON(w, http.StatusOK, SyncResult{
		OK:      true,
		Message: "Sync started in background",
	})
}

// RepairBodies triggers a re-fetch and re-parse of messages whose stored
// body text looks like undecoded quoted-printable. This is a one-shot
// repair endpoint — the user can call it from Settings after upgrading.
func RepairBodies(w http.ResponseWriter, r *http.Request) {
	count := imap.RepairGarbledBodies()
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"repaired": count,
		"message":  "Body repair completed",
	})
}

// SyncStatus returns the global sync state: whether a sync is currently
// running and the timestamp of the most recent completed sync. The frontend
// polls this to keep the UI in sync with the backend.
func SyncStatus(w http.ResponseWriter, r *http.Request) {
	var lastSyncAt sql.NullTime
	if err := database.DB.QueryRow(
		"SELECT MAX(last_sync_at) FROM accounts",
	).Scan(&lastSyncAt); err != nil {
		log.Printf("SyncStatus error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to read sync status")
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"syncing":      imap.IsSyncRunning(),
		"last_sync_at": lastSyncAt.Time,
	})
}

// SyncProgress returns real-time sync progress for one or all accounts,
// backed by Redis. Falls back to empty when Redis is unavailable.
func SyncProgress(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("account_id")

	if accountID != "" {
		aid, err := strconv.ParseInt(accountID, 10, 64)
		if err != nil || aid <= 0 {
			respondError(w, http.StatusBadRequest, "Invalid account_id")
			return
		}
		progress := database.SyncProgressGetAll(aid)
		if progress == nil {
			respondJSON(w, http.StatusOK, map[string]interface{}{
				"status": "idle",
			})
			return
		}
		respondJSON(w, http.StatusOK, progress)
		return
	}

	all := database.SyncProgressListAll()
	if all == nil {
		all = []map[string]string{}
	}
	respondJSON(w, http.StatusOK, all)
}
