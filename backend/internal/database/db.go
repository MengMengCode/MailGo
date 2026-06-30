package database

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"

	_ "github.com/go-sql-driver/mysql"
)

var DB *sql.DB

func Initialize() error {
	user := os.Getenv("MYSQL_USER")
	if user == "" {
		user = "root"
	}
	pass := os.Getenv("MYSQL_PASSWORD")
	host := os.Getenv("MYSQL_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("MYSQL_PORT")
	if port == "" {
		port = "3306"
	}
	dbName := os.Getenv("MYSQL_DATABASE")
	if dbName == "" {
		dbName = "mailgo"
	}

	// First connect without database to create it if needed.
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/?charset=utf8mb4&parseTime=true&loc=UTC", user, pass, host, port)
	rootDB, err := sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("mysql root connect: %w", err)
	}
	if err := rootDB.Ping(); err != nil {
		return fmt.Errorf("mysql ping: %w", err)
	}
	_, err = rootDB.Exec("CREATE DATABASE IF NOT EXISTS `" + dbName + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
	rootDB.Close()
	if err != nil {
		return fmt.Errorf("create database: %w", err)
	}

	// Connect to the application database.
	dsn = fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?charset=utf8mb4&parseTime=true&loc=UTC&multiStatements=true",
		user, pass, host, port, dbName)
	DB, err = sql.Open("mysql", dsn)
	if err != nil {
		return fmt.Errorf("mysql open: %w", err)
	}

	DB.SetMaxOpenConns(25)
	DB.SetMaxIdleConns(10)

	if err := DB.Ping(); err != nil {
		return fmt.Errorf("mysql ping db: %w", err)
	}

	return runMigrations()
}

func runMigrations() error {
	if _, err := DB.Exec(migrationsSQL); err != nil {
		log.Printf("Migration error: %v", err)
		return err
	}
	// Add new columns to existing tables (idempotent).
	if err := ensureColumn("folders", "role", "VARCHAR(32) NOT NULL DEFAULT ''"); err != nil {
		log.Printf("ensureColumn folders.role error: %v", err)
		return err
	}
	if err := ensureColumn("attachments", "content", "LONGBLOB"); err != nil {
		log.Printf("ensureColumn attachments.content error: %v", err)
		return err
	}
	if err := ensureColumn("messages", "previous_folder_id", "BIGINT"); err != nil {
		log.Printf("ensureColumn messages.previous_folder_id error: %v", err)
		return err
	}
	if err := ensureColumn("drafts", "is_trashed", "TINYINT(1) NOT NULL DEFAULT 0"); err != nil {
		log.Printf("ensureColumn drafts.is_trashed error: %v", err)
		return err
	}
	if err := ensureColumn("drafts", "sync_revision", "BIGINT NOT NULL DEFAULT 1"); err != nil {
		log.Printf("ensureColumn drafts.sync_revision error: %v", err)
		return err
	}
	if err := ensureColumn("accounts", "imap_encryption", "VARCHAR(16) NOT NULL DEFAULT ''"); err != nil {
		log.Printf("ensureColumn accounts.imap_encryption error: %v", err)
		return err
	}
	if err := ensureColumn("accounts", "smtp_encryption", "VARCHAR(16) NOT NULL DEFAULT ''"); err != nil {
		log.Printf("ensureColumn accounts.smtp_encryption error: %v", err)
		return err
	}
	DB.Exec(`UPDATE accounts SET imap_encryption = CASE WHEN imap_tls = 1 THEN 'ssl' ELSE 'starttls' END WHERE imap_encryption = ''`)
	DB.Exec(`UPDATE accounts SET smtp_encryption = CASE WHEN smtp_tls = 1 THEN 'starttls' ELSE 'none' END WHERE smtp_encryption = ''`)
	if err := ensureColumn("attachments", "content_expires_at", "DATETIME"); err != nil {
		log.Printf("ensureColumn attachments.content_expires_at error: %v", err)
		return err
	}
	accountColumns := []struct {
		name string
		def  string
	}{
		{"sender_email", "VARCHAR(255) DEFAULT ''"},
		{"avatar_url", "TEXT"},
		{"auto_reply_enabled", "TINYINT(1) NOT NULL DEFAULT 0"},
		{"auto_reply_subject", "TEXT"},
		{"auto_reply_body", "TEXT"},
	}
	for _, col := range accountColumns {
		if err := ensureColumn("accounts", col.name, col.def); err != nil {
			log.Printf("ensureColumn accounts.%s error: %v", col.name, err)
			return err
		}
	}
	if err := ensureColumn("accounts", "tag_color", "VARCHAR(32) DEFAULT ''"); err != nil {
		log.Printf("ensureColumn accounts.tag_color error: %v", err)
		return err
	}
	if err := ensureColumn("accounts", "sync_days", "INT NOT NULL DEFAULT 0"); err != nil {
		log.Printf("ensureColumn accounts.sync_days error: %v", err)
		return err
	}
	// Ensure indexes exist (idempotent — ignores duplicate key errors).
	indexes := []struct {
		table string
		name  string
		cols  string
	}{
		{"messages", "idx_messages_account", "(account_id)"},
		{"messages", "idx_messages_folder", "(folder_id)"},
		{"messages", "idx_messages_thread", "(thread_id)"},
		{"messages", "idx_messages_received", "(received_at)"},
		{"messages", "idx_messages_starred", "(is_starred)"},
		{"messages", "idx_messages_unread", "(is_read)"},
		{"attachments", "idx_attachments_message", "(message_id)"},
		{"pending_remote_ops", "idx_pending_remote_ops_status", "(status)"},
	}
	for _, idx := range indexes {
		if err := ensureIndex(idx.table, idx.name, idx.cols); err != nil {
			log.Printf("ensureIndex %s.%s error: %v (non-fatal)", idx.table, idx.name, err)
		}
	}

	// Widen settings.setting_value to MEDIUMTEXT (idempotent, fast metadata op).
	DB.Exec("ALTER TABLE `settings` MODIFY COLUMN `setting_value` MEDIUMTEXT NOT NULL")

	if _, err := DB.Exec(seedRolesSQL); err != nil {
		log.Printf("Seed roles error: %v", err)
		return err
	}
	log.Println("Database migrations completed successfully")
	return nil
}

// ensureColumn adds a column if it doesn't already exist (MySQL idempotent).
func ensureColumn(table, column, def string) error {
	var count int
	err := DB.QueryRow(
		"SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
		table, column,
	).Scan(&count)
	if err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	_, err = DB.Exec("ALTER TABLE `" + table + "` ADD COLUMN `" + column + "` " + def)
	return err
}

// ensureIndex creates an index if it doesn't already exist. Duplicate key
// errors (1061) are silently ignored since MySQL doesn't support
// CREATE INDEX IF NOT EXISTS.
func ensureIndex(table, name, cols string) error {
	_, err := DB.Exec("CREATE INDEX `" + name + "` ON `" + table + "` " + cols)
	if err != nil {
		// Error 1061 = Duplicate key name — index already exists.
		if strings.Contains(err.Error(), "1061") {
			return nil
		}
		return err
	}
	return nil
}

func Close() {
	if DB != nil {
		DB.Close()
	}
}
