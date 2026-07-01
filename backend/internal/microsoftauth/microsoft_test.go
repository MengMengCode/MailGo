package microsoftauth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/smtp"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestMicrosoftProviderDetection(t *testing.T) {
	for _, domain := range []string{"outlook.com", "HOTMAIL.COM", "live.com", "msn.com"} {
		if !IsMicrosoftDomain(domain) {
			t.Fatalf("expected Microsoft domain: %s", domain)
		}
	}
	if IsMicrosoftDomain("example.com") {
		t.Fatal("generic domain must not be classified as Microsoft without MX/host detection")
	}
	if !IsMicrosoftHost("outlook.office365.com") || !IsMicrosoftHost("tenant.mail.protection.outlook.com") {
		t.Fatal("Microsoft mail hosts were not detected")
	}
}

func TestXOAuth2Payload(t *testing.T) {
	client := NewXOAuth2Client("person@outlook.com", "access-token")
	mechanism, initial, err := client.Start()
	if err != nil {
		t.Fatal(err)
	}
	if mechanism != "XOAUTH2" {
		t.Fatalf("mechanism = %q", mechanism)
	}
	value := string(initial)
	if !strings.Contains(value, "user=person@outlook.com\x01") ||
		!strings.Contains(value, "auth=Bearer access-token\x01\x01") {
		t.Fatalf("unexpected XOAUTH2 payload: %q", value)
	}
}

func TestSMTPXOAuth2RequiresTLS(t *testing.T) {
	auth := NewSMTPAuth("person@outlook.com", "access-token")
	if _, _, err := auth.Start(&smtp.ServerInfo{Name: "smtp-mail.outlook.com", TLS: false}); err == nil {
		t.Fatal("XOAUTH2 must reject a plaintext SMTP connection")
	}
}

func TestRequestTokens(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "refresh_token" {
			t.Fatalf("grant_type = %q", r.Form.Get("grant_type"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`))
	}))
	defer server.Close()
	previous := tokenEndpoint
	tokenEndpoint = server.URL
	defer func() { tokenEndpoint = previous }()

	tokens, oauthError, err := requestTokens(context.Background(), url.Values{
		"grant_type": {"refresh_token"},
	})
	if err != nil || oauthError != "" {
		t.Fatalf("requestTokens() error=%v oauthError=%q", err, oauthError)
	}
	if tokens.AccessToken != "new-access" || tokens.RefreshToken != "new-refresh" {
		t.Fatalf("unexpected tokens: %+v", tokens)
	}
	if time.Until(tokens.ExpiresAt) < 59*time.Minute {
		t.Fatalf("token expiry was not calculated: %v", tokens.ExpiresAt)
	}
}

func TestRequestTokensPending(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"authorization_pending"}`))
	}))
	defer server.Close()
	previous := tokenEndpoint
	tokenEndpoint = server.URL
	defer func() { tokenEndpoint = previous }()

	_, oauthError, err := requestTokens(context.Background(), url.Values{})
	if err != nil {
		t.Fatal(err)
	}
	if oauthError != "authorization_pending" {
		t.Fatalf("oauthError = %q", oauthError)
	}
}
