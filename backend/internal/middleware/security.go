package middleware

import "net/http"

// SecurityHeaders adds common security headers to all responses.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prevent MIME type sniffing.
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Clickjacking protection.
		w.Header().Set("X-Frame-Options", "DENY")
		// XSS filter (legacy but still useful).
		w.Header().Set("X-XSS-Protection", "1; mode=block")
		// Referrer policy — don't leak URLs to external sites.
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		// Content Security Policy — restrict resource loading.
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-inline' 'unsafe-eval'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob: https:; "+
				"font-src 'self' data:; "+
				"connect-src 'self'; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'")
		// Permissions policy — disable unused browser features.
		w.Header().Set("Permissions-Policy",
			"camera=(), microphone=(), geolocation=(), payment=()")

		next.ServeHTTP(w, r)
	})
}
