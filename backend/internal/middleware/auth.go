package middleware

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"mailgo/internal/database"
)

const authCookieName = "mailgo_session"

type authSession struct {
	ExpiresAt time.Time
}

type TokenAuth struct {
	passwordHash [32]byte
	sessionTTL   time.Duration
	mu           sync.Mutex
	sessions     map[[32]byte]authSession
	limiter      loginRateLimiter
}

func NewTokenAuth(password string) *TokenAuth {
	return newTokenAuthWithLimiter(password, redisLoginRateLimiter{})
}

func newTokenAuthWithLimiter(password string, limiter loginRateLimiter) *TokenAuth {
	return &TokenAuth{
		passwordHash: sha256.Sum256([]byte(password)),
		sessionTTL:   14 * 24 * time.Hour,
		sessions:     make(map[[32]byte]authSession),
		limiter:      limiter,
	}
}

// UpdatePassword changes the password hash at runtime. All existing sessions
// are preserved — only future logins use the new password.
func (a *TokenAuth) UpdatePassword(newPassword string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.passwordHash = sha256.Sum256([]byte(newPassword))
}

func (a *TokenAuth) Login(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	ip := clientIP(r)
	retryAfter, err := a.limiter.RetryAfter(r.Context(), ip)
	if err != nil {
		writeAuthError(w, http.StatusServiceUnavailable, "Login protection is temporarily unavailable")
		return
	}
	if retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(retryAfter.Seconds()))))
		writeAuthError(w, http.StatusTooManyRequests, "当前网段已被封禁，请在 5 分钟后重试")
		return
	}

	var body struct {
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	if err := decoder.Decode(&body); err != nil {
		writeAuthError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	candidate := sha256.Sum256([]byte(body.Password))
	if subtle.ConstantTimeCompare(candidate[:], a.passwordHash[:]) != 1 {
		failure, err := a.limiter.RecordFailure(r.Context(), ip)
		if err != nil {
			writeAuthError(w, http.StatusServiceUnavailable, "Login protection is temporarily unavailable")
			return
		}
		if failure.BanFor > 0 {
			w.Header().Set("Retry-After", strconv.Itoa(max(1, int(failure.BanFor.Seconds()))))
			writeAuthError(w, http.StatusTooManyRequests, "密码错误次数过多，当前网段已禁止登录 5 分钟")
			return
		}
		remaining := max(0, loginFailureLimit-failure.Failures)
		writeAuthJSON(w, http.StatusUnauthorized, map[string]interface{}{
			"error":              fmt.Sprintf("密码错误，还剩 %d 次机会", remaining),
			"remaining_attempts": remaining,
		})
		return
	}
	if err := a.limiter.ClearFailures(r.Context(), ip); err != nil {
		writeAuthError(w, http.StatusServiceUnavailable, "Login protection is temporarily unavailable")
		return
	}

	// Invalidate any pre-existing session to prevent session fixation.
	if oldToken := tokenFromRequest(r); oldToken != "" {
		oldHash := sha256.Sum256([]byte(oldToken))
		a.mu.Lock()
		delete(a.sessions, oldHash)
		a.mu.Unlock()
		if database.RDB != nil {
			_ = database.RDB.Del(r.Context(), authSessionKey(oldHash)).Err()
		}
	}

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		writeAuthError(w, http.StatusInternalServerError, "Failed to create session")
		return
	}
	token := hex.EncodeToString(tokenBytes)
	tokenHash := sha256.Sum256([]byte(token))
	expiresAt := time.Now().Add(a.sessionTTL)

	a.mu.Lock()
	a.removeExpiredSessionsLocked(time.Now())
	a.sessions[tokenHash] = authSession{ExpiresAt: expiresAt}
	a.mu.Unlock()
	if database.RDB != nil {
		if err := database.RDB.Set(r.Context(), authSessionKey(tokenHash), "1", a.sessionTTL).Err(); err != nil {
			a.mu.Lock()
			delete(a.sessions, tokenHash)
			a.mu.Unlock()
			writeAuthError(w, http.StatusServiceUnavailable, "Failed to persist authentication session")
			return
		}
	}

	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    token,
		Path:     "/api/v1",
		HttpOnly: true,
		Secure:   requestIsSecure(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(a.sessionTTL.Seconds()),
		Expires:  expiresAt,
	})

	writeAuthJSON(w, http.StatusOK, map[string]interface{}{
		"token":      token,
		"expires_at": expiresAt.UTC().Format(time.RFC3339),
	})
}

func (a *TokenAuth) Logout(w http.ResponseWriter, r *http.Request) {
	if token := tokenFromRequest(r); token != "" {
		hash := sha256.Sum256([]byte(token))
		a.mu.Lock()
		delete(a.sessions, hash)
		a.mu.Unlock()
		if database.RDB != nil {
			_ = database.RDB.Del(r.Context(), authSessionKey(hash)).Err()
		}
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    "",
		Path:     "/api/v1",
		HttpOnly: true,
		Secure:   requestIsSecure(r),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
	writeAuthJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *TokenAuth) Session(w http.ResponseWriter, _ *http.Request) {
	writeAuthJSON(w, http.StatusOK, map[string]bool{"authenticated": true})
}

func (a *TokenAuth) RequireToken(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		token := tokenFromRequest(r)
		if token == "" || !a.validToken(r.Context(), token) {
			http.SetCookie(w, &http.Cookie{
				Name:     authCookieName,
				Value:    "",
				Path:     "/api/v1",
				HttpOnly: true,
				Secure:   requestIsSecure(r),
				SameSite: http.SameSiteStrictMode,
				MaxAge:   -1,
			})
			writeAuthError(w, http.StatusUnauthorized, "Authentication required")
			return
		}
		if isUnsafeMethod(r.Method) &&
			strings.TrimSpace(r.Header.Get("Authorization")) == "" {
			fetchSite := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
			if fetchSite != "" && fetchSite != "same-origin" {
				writeAuthError(w, http.StatusForbidden, "Cross-site request rejected")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (a *TokenAuth) validToken(ctx context.Context, token string) bool {
	hash := sha256.Sum256([]byte(token))
	if database.RDB != nil {
		exists, err := database.RDB.Exists(ctx, authSessionKey(hash)).Result()
		return err == nil && exists == 1
	}

	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	session, ok := a.sessions[hash]
	if !ok || !now.Before(session.ExpiresAt) {
		delete(a.sessions, hash)
		return false
	}
	return true
}

func authSessionKey(hash [32]byte) string {
	return "mailgo:auth:session:" + hex.EncodeToString(hash[:])
}

func tokenFromRequest(r *http.Request) string {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authorization) > 7 && strings.EqualFold(authorization[:7], "Bearer ") {
		return strings.TrimSpace(authorization[7:])
	}
	if cookie, err := r.Cookie(authCookieName); err == nil {
		return cookie.Value
	}
	return ""
}

func (a *TokenAuth) removeExpiredSessionsLocked(now time.Time) {
	for token, session := range a.sessions {
		if !now.Before(session.ExpiresAt) {
			delete(a.sessions, token)
		}
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func requestIsSecure(r *http.Request) bool {
	return r.TLS != nil ||
		strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}

func isUnsafeMethod(method string) bool {
	return method != http.MethodGet &&
		method != http.MethodHead &&
		method != http.MethodOptions
}

func writeAuthError(w http.ResponseWriter, status int, message string) {
	writeAuthJSON(w, status, map[string]string{"error": message})
}

func writeAuthJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
