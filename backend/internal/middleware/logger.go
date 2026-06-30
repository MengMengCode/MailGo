package middleware

import (
	"log"
	"net/http"
	"strings"
	"time"
)

type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

		next.ServeHTTP(rw, r)

		// Skip noisy health-check heartbeat logs.
		if r.URL.Path == "/api/v1/health" {
			return
		}

		// High-frequency polling endpoints: only log on errors.
		polling := r.Method == "GET" &&
			(r.URL.Path == "/api/v1/sync/progress" ||
				r.URL.Path == "/api/v1/sync/status" ||
				r.URL.Path == "/api/v1/folders" ||
				r.URL.Path == "/api/v1/accounts" ||
				r.URL.Path == "/api/v1/messages" ||
				r.URL.Path == "/api/v1/settings" ||
				r.URL.Path == "/api/v1/storage/stats")
		if polling && rw.statusCode < 400 {
			return
		}

		log.Printf("%s %s %d %s",
			r.Method,
			sanitizeLogValue(r.URL.Path),
			rw.statusCode,
			time.Since(start),
		)
	})
}

// sanitizeLogValue strips newlines and carriage returns to prevent log injection.
func sanitizeLogValue(s string) string {
	return strings.NewReplacer("\n", "_", "\r", "_").Replace(s)
}
