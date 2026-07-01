package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"mailgo/internal/crypto"
	"mailgo/internal/database"
	"mailgo/internal/handlers"
	"mailgo/internal/imap"
	"mailgo/internal/middleware"

	"github.com/gorilla/mux"
	"github.com/joho/godotenv"
)

// serveSPAIndex serves index.html for SPA fallback
type spaHandler struct {
	fs      fs.FS
	index   []byte
	modTime fs.FileInfo
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	f, err := h.fs.Open(path)
	if err != nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write(h.index)
		return
	}
	defer f.Close()

	stat, _ := f.Stat()
	if stat.IsDir() {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write(h.index)
		return
	}

	http.FileServer(http.FS(h.fs)).ServeHTTP(w, r)
}

//go:embed frontend-dist/*
var frontendFS embed.FS

func main() {
	// Load .env file (from current directory or parent).
	_ = godotenv.Load()
	_ = godotenv.Load("../.env")

	// ── CLI: reset password ──
	if len(os.Args) > 1 && os.Args[1] == "-reset-password" {
		resetPasswordCLI()
		return
	}

	// ── Encryption key ──
	// Generate a random key if not provided. Persisted in .env by install.sh.
	encKey := os.Getenv("ENCRYPTION_KEY")
	if encKey == "" {
		encKey = generateRandomKey(32)
		log.Printf("[init] ENCRYPTION_KEY not set — generated random key (%s...)", encKey[:8])
		log.Printf("[init] IMPORTANT: Add this to your .env file to persist across restarts:")
		log.Printf("[init]   ENCRYPTION_KEY=%s", encKey)
	}
	if err := crypto.Init(encKey); err != nil {
		log.Fatalf("Failed to initialize encryption: %v", err)
	}

	// ── Database ──
	if err := waitForDatabase(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	// Encrypt any existing plaintext sensitive data.
	if err := crypto.MigratePlaintext(database.DB); err != nil {
		log.Printf("Warning: plaintext migration encountered errors: %v", err)
	}

	// ── Web password ──
	// Read from database settings table. On first install, generate a random
	// password and print it to stdout for the admin to note.
	webPassword := loadOrGenerateWebPassword()

	// ── Redis ──
	if err := waitForRedis(); err != nil {
		log.Fatalf("Redis is required for login protection: %v", err)
	}
	database.SyncProgressResetStale()

	tokenAuth := middleware.NewTokenAuth(webPassword)

	port := os.Getenv("SERVER_PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("MailGo server starting on :%s", port)
	startBackgroundSync()

	// Setup router
	r := mux.NewRouter()
	r.Use(middleware.CORS)
	r.Use(middleware.SecurityHeaders)
	r.Use(middleware.Logger)

	// Login is the only public API. Every other API route, including health
	// checks and static resources served through the API, requires a token.
	r.HandleFunc("/healthz", handlers.HealthCheck).Methods("GET")
	r.HandleFunc("/api/v1/auth/login", tokenAuth.Login).Methods("POST", "OPTIONS")

	// API routes
	api := r.PathPrefix("/api/v1").Subrouter()
	api.Use(tokenAuth.RequireToken)
	api.HandleFunc("/auth/session", tokenAuth.Session).Methods("GET")
	api.HandleFunc("/auth/logout", tokenAuth.Logout).Methods("POST")
	api.HandleFunc("/auth/change-password", handlers.ChangePassword(tokenAuth)).Methods("POST")

	// Health
	api.HandleFunc("/health", handlers.HealthCheck).Methods("GET")

	// Sync
	api.HandleFunc("/sync", handlers.TriggerSync).Methods("POST")
	api.HandleFunc("/sync/status", handlers.SyncStatus).Methods("GET")
	api.HandleFunc("/sync/progress", handlers.SyncProgress).Methods("GET")
	api.HandleFunc("/sync/repair-bodies", handlers.RepairBodies).Methods("POST")

	// Accounts
	api.HandleFunc("/accounts", handlers.ListAccounts).Methods("GET")
	api.HandleFunc("/accounts", handlers.CreateAccount).Methods("POST")
	api.HandleFunc("/accounts/detect", handlers.DetectAccount).Methods("POST")
	api.HandleFunc("/accounts/probe", handlers.ProbeAccount).Methods("POST")
	api.HandleFunc("/accounts/verify", handlers.VerifyAccount).Methods("POST")
	api.HandleFunc("/accounts/microsoft/device/start", handlers.StartMicrosoftDeviceAuthorization).Methods("POST")
	api.HandleFunc("/accounts/microsoft/device/poll", handlers.PollMicrosoftDeviceAuthorization).Methods("POST")
	api.HandleFunc("/accounts/{id}", handlers.GetAccount).Methods("GET")
	api.HandleFunc("/accounts/{id}", handlers.UpdateAccount).Methods("PUT")
	api.HandleFunc("/accounts/{id}", handlers.DeleteAccount).Methods("DELETE")

	// Messages
	api.HandleFunc("/messages", handlers.ListMessages).Methods("GET")
	api.HandleFunc("/messages", handlers.BatchMessages).Methods("POST")
	api.HandleFunc("/messages/batch", handlers.BatchMessages).Methods("POST")
	api.HandleFunc("/messages/send", handlers.SendMessage).Methods("POST")
	api.HandleFunc("/messages/{id}", handlers.GetMessage).Methods("GET")
	api.HandleFunc("/messages/{id}/thread", handlers.GetMessageThread).Methods("GET")
	api.HandleFunc("/messages/{id}/raw", handlers.GetMessageRaw).Methods("GET")
	api.HandleFunc("/messages/{id}", handlers.UpdateMessage).Methods("PATCH")
	api.HandleFunc("/messages/{id}", handlers.DeleteMessage).Methods("DELETE")
	api.HandleFunc("/messages/{id}/restore", handlers.RestoreMessage).Methods("POST")
	api.HandleFunc("/messages/{id}/permanent-delete", handlers.PermanentDeleteMessage).Methods("POST")
	api.HandleFunc("/messages/{id}/star", handlers.StarMessage).Methods("POST")
	api.HandleFunc("/messages/{id}/toggle-read", handlers.ToggleRead).Methods("POST")
	api.HandleFunc("/messages/{id}/move", handlers.MoveMessage).Methods("POST")

	// Attachments
	api.HandleFunc("/messages/{id}/attachments", handlers.ListAttachments).Methods("GET")
	api.HandleFunc("/attachments/{id}", handlers.GetAttachment).Methods("GET")
	api.HandleFunc("/attachments/{id}/preview-data", handlers.GetAttachmentPreviewData).Methods("GET")
	api.HandleFunc("/avatars/favicon", handlers.GetFaviconAvatar).Methods("GET")
	api.HandleFunc("/avatars/gravatar", handlers.GetGravatarAvatar).Methods("GET")
	api.HandleFunc("/avatars/fetch", handlers.FetchAvatar).Methods("GET")
	api.HandleFunc("/avatars/serve/{file}", handlers.ServeAvatar).Methods("GET")

	// Folders
	api.HandleFunc("/folders", handlers.ListFolders).Methods("GET")
	api.HandleFunc("/folders/{id}", handlers.GetFolder).Methods("GET")

	// Settings
	api.HandleFunc("/settings", handlers.ListSettings).Methods("GET")
	api.HandleFunc("/settings/{key}", handlers.UpdateSetting).Methods("PUT")

	// Storage
	api.HandleFunc("/storage/stats", handlers.StorageStatsHandler).Methods("GET")
	api.HandleFunc("/storage/clear", handlers.ClearStorageHandler).Methods("POST")

	// PGP Keys
	api.HandleFunc("/pgp-keys", handlers.ListPGPKeys).Methods("GET")
	api.HandleFunc("/pgp-keys", handlers.CreatePGPKey).Methods("POST")
	api.HandleFunc("/pgp-keys/{id}", handlers.DeletePGPKey).Methods("DELETE")
	api.HandleFunc("/pgp-keys/{id}/private", handlers.GetPGPPrivateKey).Methods("GET")

	// AI
	api.HandleFunc("/ai/chat", handlers.AIChat).Methods("POST")
	api.HandleFunc("/ai/agent", handlers.AIAgent).Methods("POST")
	api.HandleFunc("/ai/title", handlers.AITitle).Methods("POST")
	api.HandleFunc("/ai/translate", handlers.AITranslate).Methods("POST")

	// Drafts
	api.HandleFunc("/drafts", handlers.ListDrafts).Methods("GET")
	api.HandleFunc("/drafts", handlers.SaveDraft).Methods("POST")
	api.HandleFunc("/drafts/{id}", handlers.GetDraft).Methods("GET")
	api.HandleFunc("/drafts/{id}", handlers.UpdateDraft).Methods("PUT")
	api.HandleFunc("/drafts/{id}", handlers.DeleteDraft).Methods("DELETE")
	api.HandleFunc("/drafts/{id}/restore", handlers.RestoreDraft).Methods("POST")
	api.HandleFunc("/drafts/{id}/permanent-delete", handlers.PermanentDeleteDraft).Methods("POST")

	// Serve embedded frontend
	serveFrontend(r)

	log.Fatal(http.ListenAndServe(":"+port, r))
}

func serveFrontend(r *mux.Router) {
	distFS, err := fs.Sub(frontendFS, "frontend-dist")
	if err != nil {
		log.Println("Warning: Embedded frontend not found, running in API-only mode")
		return
	}

	indexBytes, err := fs.ReadFile(distFS, "index.html")
	if err != nil {
		log.Println("Warning: index.html not found in embedded frontend")
		return
	}

	handler := &spaHandler{fs: distFS, index: indexBytes}

	r.PathPrefix("/").Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	}))
}

func waitForDatabase() error {
	return retryStartup("database", 120*time.Second, func() error {
		return database.Initialize()
	})
}

func waitForRedis() error {
	return retryStartup("redis", 60*time.Second, func() error {
		if err := database.InitializeRedis(); err != nil {
			return err
		}
		if database.RDB == nil {
			return fmt.Errorf("redis connection unavailable")
		}
		return nil
	})
}

func retryStartup(name string, timeout time.Duration, fn func() error) error {
	deadline := time.Now().Add(timeout)
	delay := time.Second
	var lastErr error
	for attempt := 1; ; attempt++ {
		if err := fn(); err != nil {
			lastErr = err
			if time.Now().Add(delay).After(deadline) {
				break
			}
			log.Printf("[init] waiting for %s (attempt %d): %v", name, attempt, err)
			time.Sleep(delay)
			if delay < 5*time.Second {
				delay *= 2
			}
			continue
		}
		if attempt > 1 {
			log.Printf("[init] %s connected after %d attempt(s)", name, attempt)
		}
		return nil
	}
	return fmt.Errorf("%s did not become ready within %s: %w", name, timeout, lastErr)
}

// startBackgroundSync runs a goroutine that periodically pulls new mail
// from every configured IMAP account. The interval is read from the
// settings table (key "check_interval", in seconds) and re-evaluated
// after every cycle so the user can change it from the Settings page
// without restarting the server.
func startBackgroundSync() {
	go func() {
		// Kick off the first sync shortly after startup so the user
		// doesn't have to wait a full interval to see fresh mail.
		timer := time.NewTimer(10 * time.Second)
		defer timer.Stop()
		for {
			<-timer.C
			if backgroundSyncEnabled() {
				runBackgroundSync()
			}
			timer.Reset(readSyncInterval())
		}
	}()
}

// runBackgroundSync connects to every account and pulls new messages.
// It also pushes any pending local operations (flag changes, moves,
// deletes) to the IMAP server before pulling, so the server reflects
// the user's actions. Errors for individual accounts are logged but
// never abort the whole run, so one misconfigured account can't block
// the others.
//
// Uses the same global sync flag as TriggerSync to ensure a single
// flight: if a manual or scheduled sync is already running, this
// cycle is skipped entirely rather than overlapping.
func runBackgroundSync() {
	if !imap.TryBeginGlobalSync() {
		log.Println("background sync: skipped — another sync is already running")
		return
	}
	defer imap.EndGlobalSync()

	// Push local changes first, then pull new mail.
	imap.PushPendingOps()
	imap.PushLocalDrafts()

	configs, err := imap.LoadAccountConfigs(0)
	if err != nil {
		log.Printf("background sync load accounts error: %v", err)
		return
	}
	if len(configs) == 0 {
		return
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, cfg := range configs {
		wg.Add(1)
		go func(c imap.AccountConfig) {
			defer wg.Done()
			res := imap.SyncAccount(c)
			mu.Lock()
			if !res.OK && res.Error != nil {
				log.Printf("background sync account %d (%s): %v", c.ID, c.Username, res.Error)
			} else if res.OK && res.NewMessages > 0 {
				log.Printf("background sync account %d: %d new message(s)", c.ID, res.NewMessages)
			}
			mu.Unlock()
		}(cfg)
	}
	wg.Wait()

	// Repair any messages whose bodies were stored as undecoded QP by an
	// older parser version. This is cheap when there's nothing to fix
	// (just one SQL query) and self-heals over time.
	imap.RepairGarbledBodies()

	// Enforce storage retention policies and size limits.
	handlers.RunStorageCleanup()
}

func backgroundSyncEnabled() bool {
	var value string
	err := database.DB.QueryRow("SELECT value FROM settings WHERE key = 'auto_refresh_enabled'").Scan(&value)
	if err != nil {
		return true
	}
	return value != "false"
}

func readSyncInterval() time.Duration {
	var value string
	if err := database.DB.QueryRow("SELECT value FROM settings WHERE key = 'check_interval'").Scan(&value); err != nil {
		return 5 * time.Minute
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 30 {
		seconds = 300
	}
	return time.Duration(seconds) * time.Second
}

// generateRandomKey creates a hex-encoded random string of the given byte length.
func generateRandomKey(byteLen int) string {
	b := make([]byte, byteLen)
	if _, err := rand.Read(b); err != nil {
		log.Fatalf("Failed to generate random key: %v", err)
	}
	return hex.EncodeToString(b)
}

// loadOrGenerateWebPassword reads the web login password from the settings
// table. On first install (key missing), generates a random 16-char password,
// stores it, and prints it to stdout.
func loadOrGenerateWebPassword() string {
	var pw string
	err := database.DB.QueryRow(
		"SELECT setting_value FROM settings WHERE setting_key = 'web_password'",
	).Scan(&pw)

	if err == nil && pw != "" {
		return pw
	}

	// First install — generate a random password.
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		log.Fatalf("Failed to generate web password: %v", err)
	}
	pw = hex.EncodeToString(raw)[:16]

	if _, err := database.DB.Exec(
		`INSERT INTO settings (setting_key, setting_value, updated_at)
		 VALUES ('web_password', ?, CURRENT_TIMESTAMP)
		 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
		pw,
	); err != nil {
		log.Fatalf("Failed to store web password: %v", err)
	}

	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║                   MailGo First Install                      ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════╣")
	fmt.Printf("║  Web Login Password:  %-36s  ║\n", pw)
	fmt.Println("║                                                              ║")
	fmt.Println("║  You can change this in Settings > Security.                 ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")

	return pw
}

// resetPasswordCLI connects to the database, generates a new random password,
// stores it, and prints it. Used via: docker exec mailgo /app/mailgo -reset-password
func resetPasswordCLI() {
	encKey := os.Getenv("ENCRYPTION_KEY")
	if encKey == "" {
		encKey = generateRandomKey(32)
	}
	_ = crypto.Init(encKey)

	if err := database.Initialize(); err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer database.Close()

	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		log.Fatalf("Failed to generate password: %v", err)
	}
	pw := hex.EncodeToString(raw)[:16]

	if _, err := database.DB.Exec(
		`INSERT INTO settings (setting_key, setting_value, updated_at)
		 VALUES ('web_password', ?, CURRENT_TIMESTAMP)
		 ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
		pw,
	); err != nil {
		log.Fatalf("Failed to store password: %v", err)
	}

	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║                   Password Reset                             ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════╣")
	fmt.Printf("║  New Password:  %-40s  ║\n", pw)
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
}
