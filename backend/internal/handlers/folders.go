package handlers

import (
	"log"
	"mailgo/internal/database"
	"mailgo/internal/models"
	"net/http"
)

func ListFolders(w http.ResponseWriter, r *http.Request) {
	accountID := r.URL.Query().Get("account_id")

	var query string
	var args []interface{}

	baseQuery := `WITH inbox_keys AS (
			SELECT mi.account_id, LOWER(TRIM(COALESCE(mi.message_id, ''))) AS message_key
			FROM messages mi
			JOIN folders fi ON mi.folder_id = fi.id
			WHERE fi.role = 'inbox' AND mi.is_deleted = 0 AND TRIM(COALESCE(mi.message_id, '')) != ''
			GROUP BY mi.account_id, message_key
		)
		SELECT f.id, f.account_id, f.name, f.role, f.uid_validity, f.uid_next,
			f.last_synced_at, f.created_at,
			COALESCE(SUM(CASE
				WHEN m.id IS NULL THEN 0
				WHEN f.role = 'archive' AND ik.message_key IS NOT NULL THEN 0
				ELSE 1
			END), 0) AS total_count,
			COALESCE(SUM(CASE
				WHEN m.id IS NULL OR m.is_read != 0 THEN 0
				WHEN f.role = 'archive' AND ik.message_key IS NOT NULL THEN 0
				ELSE 1
			END), 0) AS unread_count
		FROM folders f
		LEFT JOIN messages m ON m.folder_id = f.id AND m.is_deleted = 0
		LEFT JOIN inbox_keys ik ON f.role = 'archive'
			AND ik.account_id = m.account_id
			AND ik.message_key = LOWER(TRIM(COALESCE(m.message_id, ''))) `

	if accountID != "" {
		query = baseQuery + `WHERE f.account_id = ?
			GROUP BY f.id
			ORDER BY f.account_id, f.role, f.name`
		args = append(args, accountID)
	} else {
		query = baseQuery + `GROUP BY f.id
			ORDER BY f.account_id, f.role, f.name`
	}

	rows, err := database.DB.Query(query, args...)
	if err != nil {
		log.Printf("ListFolders query error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch folders")
		return
	}
	defer rows.Close()

	folders := make([]models.Folder, 0)
	for rows.Next() {
		var f models.Folder
		if err := rows.Scan(&f.ID, &f.AccountID, &f.Name, &f.Role, &f.UIDValidity, &f.UIDNext,
			&f.LastSyncedAt, &f.CreatedAt, &f.TotalCount, &f.UnreadCount); err != nil {
			log.Printf("ListFolders scan error: %v", err)
			continue
		}
		f.AfterScan()
		folders = append(folders, f)
	}
	respondJSON(w, http.StatusOK, folders)
}

func GetFolder(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid folder ID")
		return
	}

	var f models.Folder
	err := database.DB.QueryRow(`WITH inbox_keys AS (
			SELECT mi.account_id, LOWER(TRIM(COALESCE(mi.message_id, ''))) AS message_key
			FROM messages mi
			JOIN folders fi ON mi.folder_id = fi.id
			WHERE fi.role = 'inbox' AND mi.is_deleted = 0 AND TRIM(COALESCE(mi.message_id, '')) != ''
			GROUP BY mi.account_id, message_key
		)
		SELECT f.id, f.account_id, f.name, f.role, f.uid_validity, f.uid_next,
			f.last_synced_at, f.created_at,
			COALESCE(SUM(CASE
				WHEN m.id IS NULL THEN 0
				WHEN f.role = 'archive' AND ik.message_key IS NOT NULL THEN 0
				ELSE 1
			END), 0),
			COALESCE(SUM(CASE
				WHEN m.id IS NULL OR m.is_read != 0 THEN 0
				WHEN f.role = 'archive' AND ik.message_key IS NOT NULL THEN 0
				ELSE 1
			END), 0)
		FROM folders f
		LEFT JOIN messages m ON m.folder_id = f.id AND m.is_deleted = 0
		LEFT JOIN inbox_keys ik ON f.role = 'archive'
			AND ik.account_id = m.account_id
			AND ik.message_key = LOWER(TRIM(COALESCE(m.message_id, '')))
		WHERE f.id = ?
		GROUP BY f.id`, id).
		Scan(&f.ID, &f.AccountID, &f.Name, &f.Role, &f.UIDValidity, &f.UIDNext,
			&f.LastSyncedAt, &f.CreatedAt, &f.TotalCount, &f.UnreadCount)
	if err != nil {
		respondError(w, http.StatusNotFound, "Folder not found")
		return
	}
	f.AfterScan()
	respondJSON(w, http.StatusOK, f)
}
