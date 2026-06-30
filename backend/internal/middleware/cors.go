package middleware

import (
	"net/http"
	"os"
	"strings"
)

// CORS restricts cross-origin requests. By default only same-origin is
// allowed. Set the CORS_ORIGINS environment variable to a comma-separated
// list of allowed origins if cross-origin access is needed (e.g. a web
// frontend on a different domain).
func CORS(next http.Handler) http.Handler {
	allowed := getAllowedOrigins()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		if originAllowed(origin, allowed) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}

		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func getAllowedOrigins() []string {
	env := os.Getenv("CORS_ORIGINS")
	if env == "" {
		return nil // same-origin only
	}
	parts := strings.Split(env, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	// If no explicit origins are configured, reject all cross-origin requests.
	if len(allowed) == 0 {
		return false
	}
	for _, a := range allowed {
		if a == "*" || a == origin {
			return true
		}
	}
	return false
}
