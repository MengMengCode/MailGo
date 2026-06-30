package handlers

import (
	"log"
	"mailgo/internal/crypto"
	"mailgo/internal/database"
	"mailgo/internal/models"
	"net/http"
)

func ListPGPKeys(w http.ResponseWriter, r *http.Request) {
	rows, err := database.DB.Query("SELECT id, name, public_key, created_at FROM pgp_keys ORDER BY created_at DESC")
	if err != nil {
		log.Printf("ListPGPKeys error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch PGP keys")
		return
	}
	defer rows.Close()

	keys := make([]models.PGPKey, 0)
	for rows.Next() {
		var k models.PGPKey
		if err := rows.Scan(&k.ID, &k.Name, &k.PublicKey, &k.CreatedAt); err != nil {
			log.Printf("ListPGPKeys scan error: %v", err)
			continue
		}
		keys = append(keys, k)
	}
	respondJSON(w, http.StatusOK, keys)
}

func CreatePGPKey(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name       string `json:"name"`
		PublicKey  string `json:"public_key"`
		PrivateKey string `json:"private_key"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Name == "" || req.PublicKey == "" {
		respondError(w, http.StatusBadRequest, "Name and public key are required")
		return
	}

	result, err := database.DB.Exec(
		"INSERT INTO pgp_keys (name, public_key, private_key) VALUES (?, ?, ?)",
		req.Name, req.PublicKey, encryptPGPKey(req.PrivateKey),
	)
	if err != nil {
		log.Printf("CreatePGPKey error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to save PGP key")
		return
	}

	id, _ := result.LastInsertId()
	respondJSON(w, http.StatusCreated, map[string]int64{"id": id})
}

func DeletePGPKey(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid key ID")
		return
	}

	_, err := database.DB.Exec("DELETE FROM pgp_keys WHERE id = ?", id)
	if err != nil {
		log.Printf("DeletePGPKey error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to delete PGP key")
		return
	}
	respondJSON(w, http.StatusOK, map[string]string{"message": "Key deleted"})
}

func GetPGPPrivateKey(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid key ID")
		return
	}

	var privateKey string
	err := database.DB.QueryRow("SELECT private_key FROM pgp_keys WHERE id = ?", id).Scan(&privateKey)
	if err != nil {
		respondError(w, http.StatusNotFound, "Key not found")
		return
	}
	if dec, decErr := crypto.Decrypt(privateKey); decErr == nil {
		privateKey = dec
	}
	respondJSON(w, http.StatusOK, map[string]string{"private_key": privateKey})
}

// encryptPGPKey encrypts a PGP private key for database storage.
// Returns empty string if encryption fails — never stores plaintext.
func encryptPGPKey(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	enc, err := crypto.Encrypt(plaintext)
	if err != nil {
		log.Printf("encryptPGPKey error: private key NOT stored (encryption unavailable)")
		return ""
	}
	return enc
}
