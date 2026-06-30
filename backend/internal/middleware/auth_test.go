package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeLoginLimiter struct {
	failures map[string]int
	blocked  map[string]time.Duration
}

func newFakeLoginLimiter() *fakeLoginLimiter {
	return &fakeLoginLimiter{
		failures: make(map[string]int),
		blocked:  make(map[string]time.Duration),
	}
}

func (f *fakeLoginLimiter) RetryAfter(_ context.Context, ip string) (time.Duration, error) {
	return f.blocked[ipSubnet(ip)], nil
}

func (f *fakeLoginLimiter) RecordFailure(_ context.Context, ip string) (loginFailureResult, error) {
	f.failures[ip]++
	if f.failures[ip] >= loginFailureLimit {
		f.blocked[ipSubnet(ip)] = loginSubnetBan
		delete(f.failures, ip)
		return loginFailureResult{Failures: loginFailureLimit, BanFor: loginSubnetBan}, nil
	}
	return loginFailureResult{Failures: f.failures[ip]}, nil
}

func (f *fakeLoginLimiter) ClearFailures(_ context.Context, ip string) error {
	delete(f.failures, ip)
	return nil
}

func TestTokenAuthLoginAndProtectedRoute(t *testing.T) {
	auth := newTokenAuthWithLimiter("correct horse battery staple", newFakeLoginLimiter())

	bad := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"password":"wrong"}`))
	bad.RemoteAddr = "127.0.0.1:1234"
	badRecorder := httptest.NewRecorder()
	auth.Login(badRecorder, bad)
	if badRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("bad login status = %d", badRecorder.Code)
	}
	if !strings.Contains(badRecorder.Body.String(), "还剩 4 次机会") {
		t.Fatalf("remaining-attempt message missing: %s", badRecorder.Body.String())
	}

	login := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"password":"correct horse battery staple"}`))
	login.RemoteAddr = "127.0.0.1:1234"
	loginRecorder := httptest.NewRecorder()
	auth.Login(loginRecorder, login)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", loginRecorder.Code, loginRecorder.Body.String())
	}

	var response struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(loginRecorder.Body.Bytes(), &response); err != nil || response.Token == "" {
		t.Fatalf("missing token: %v body=%s", err, loginRecorder.Body.String())
	}

	protected := auth.RequireToken(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))

	anonymousRecorder := httptest.NewRecorder()
	protected.ServeHTTP(anonymousRecorder, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))
	if anonymousRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status = %d", anonymousRecorder.Code)
	}

	bearerRequest := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	bearerRequest.Header.Set("Authorization", "Bearer "+response.Token)
	bearerRecorder := httptest.NewRecorder()
	protected.ServeHTTP(bearerRecorder, bearerRequest)
	if bearerRecorder.Code != http.StatusNoContent {
		t.Fatalf("bearer status = %d", bearerRecorder.Code)
	}

	cookies := loginRecorder.Result().Cookies()
	if len(cookies) == 0 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("secure session cookie not set: %+v", cookies)
	}
	if cookies[0].MaxAge != 14*24*60*60 {
		t.Fatalf("cookie MaxAge = %d, want 14 days", cookies[0].MaxAge)
	}
	cookieRequest := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	cookieRequest.AddCookie(cookies[0])
	cookieRecorder := httptest.NewRecorder()
	protected.ServeHTTP(cookieRecorder, cookieRequest)
	if cookieRecorder.Code != http.StatusNoContent {
		t.Fatalf("cookie status = %d", cookieRecorder.Code)
	}

	crossSiteRequest := httptest.NewRequest(http.MethodPost, "/api/v1/messages/send", nil)
	crossSiteRequest.AddCookie(cookies[0])
	crossSiteRequest.Header.Set("Sec-Fetch-Site", "cross-site")
	crossSiteRecorder := httptest.NewRecorder()
	protected.ServeHTTP(crossSiteRecorder, crossSiteRequest)
	if crossSiteRecorder.Code != http.StatusForbidden {
		t.Fatalf("cross-site status = %d", crossSiteRecorder.Code)
	}

	logoutRequest := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	logoutRequest.Header.Set("Authorization", "Bearer "+response.Token)
	logoutRecorder := httptest.NewRecorder()
	auth.Logout(logoutRecorder, logoutRequest)
	if logoutRecorder.Code != http.StatusOK {
		t.Fatalf("logout status = %d", logoutRecorder.Code)
	}
	expiredRecorder := httptest.NewRecorder()
	protected.ServeHTTP(expiredRecorder, bearerRequest)
	if expiredRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("logged-out token status = %d", expiredRecorder.Code)
	}
}

func TestTokenAuthRateLimitsFailures(t *testing.T) {
	auth := newTokenAuthWithLimiter("secret", newFakeLoginLimiter())
	for i := 0; i < 5; i++ {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"password":"wrong"}`))
		request.RemoteAddr = "127.0.0.2:1234"
		recorder := httptest.NewRecorder()
		auth.Login(recorder, request)
		expected := http.StatusUnauthorized
		if i == 4 {
			expected = http.StatusTooManyRequests
		}
		if recorder.Code != expected {
			t.Fatalf("attempt %d status = %d", i+1, recorder.Code)
		}
	}

	request := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(`{"password":"secret"}`))
	request.RemoteAddr = "127.0.0.99:1234"
	recorder := httptest.NewRecorder()
	auth.Login(recorder, request)
	if recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("same /24 status = %d", recorder.Code)
	}
}
