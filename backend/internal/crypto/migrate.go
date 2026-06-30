package crypto

import (
	"database/sql"
	"log"
)

// MigratePlaintext encrypts any existing plaintext values in the database.
// It is idempotent: rows that already have the "enc:v1:" prefix are skipped.
func MigratePlaintext(db *sql.DB) error {
	total := 0

	// Accounts — password_encrypted
	total += migrateColumn(db, "accounts", "password_encrypted")
	// Accounts — oauth_token
	total += migrateColumn(db, "accounts", "oauth_token")
	// Accounts — oauth_refresh_token
	total += migrateColumn(db, "accounts", "oauth_refresh_token")
	// PGP keys — private_key
	total += migrateColumn(db, "pgp_keys", "private_key")

	if total > 0 {
		log.Printf("Encrypted %d existing plaintext column(s) at rest", total)
	}
	return nil
}

// migrateColumn encrypts all non-empty, non-prefixed values in the given
// table.column. Returns the number of rows updated.
func migrateColumn(db *sql.DB, table, column string) int {
	rows, err := db.Query("SELECT id, `" + column + "` FROM `" + table + "` WHERE `" + column + "` IS NOT NULL AND `" + column + "` != ''")
	if err != nil {
		log.Printf("migrateColumn %s.%s query error: %v", table, column, err)
		return 0
	}
	defer rows.Close()

	updated := 0
	for rows.Next() {
		var id int64
		var val string
		if err := rows.Scan(&id, &val); err != nil {
			continue
		}
		if IsEncrypted(val) {
			continue
		}
		encrypted, err := Encrypt(val)
		if err != nil {
			log.Printf("migrateColumn %s.%s id=%d encrypt error: %v", table, column, id, err)
			continue
		}
		if _, err := db.Exec("UPDATE `"+table+"` SET `"+column+"` = ? WHERE id = ?", encrypted, id); err != nil {
			log.Printf("migrateColumn %s.%s id=%d update error: %v", table, column, id, err)
			continue
		}
		updated++
	}
	if updated > 0 {
		log.Printf("Encrypted %d row(s) in %s.%s", updated, table, column)
	}
	return updated
}
