package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLatestReleaseUsesCachedValue(t *testing.T) {
	latestReleaseCache.Lock()
	previousValue := latestReleaseCache.value
	previousExpiry := latestReleaseCache.expiresAt
	latestReleaseCache.value = latestReleaseResponse{
		Version:     "9.8.7",
		TagName:     "v9.8.7",
		URL:         "https://github.com/MengMengCode/MailGo/releases/tag/v9.8.7",
		PublishedAt: "2026-07-01T00:00:00Z",
	}
	latestReleaseCache.expiresAt = time.Now().Add(time.Minute)
	latestReleaseCache.Unlock()
	t.Cleanup(func() {
		latestReleaseCache.Lock()
		latestReleaseCache.value = previousValue
		latestReleaseCache.expiresAt = previousExpiry
		latestReleaseCache.Unlock()
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/updates/latest", nil)
	rec := httptest.NewRecorder()
	LatestRelease(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var response latestReleaseResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Version != "9.8.7" || response.TagName != "v9.8.7" {
		t.Fatalf("unexpected response: %+v", response)
	}
}
