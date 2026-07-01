package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if data != nil {
		if err := json.NewEncoder(w).Encode(data); err != nil {
			if !isClientClosedResponseError(err) {
				log.Printf("Failed to encode JSON response: %v", err)
			}
		}
	}
}

func isClientClosedResponseError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "broken pipe") ||
		strings.Contains(msg, "connection reset by peer") ||
		strings.Contains(msg, "use of closed network connection")
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}

func decodeJSON(r *http.Request, v interface{}) error {
	defer r.Body.Close()
	// Default 10MB body limit to prevent OOM from oversized requests.
	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 10<<20)).Decode(v)
}

func HealthCheck(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "MailGo",
	})
}
