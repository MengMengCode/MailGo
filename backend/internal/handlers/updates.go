package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const latestReleaseURL = "https://api.github.com/repos/MengMengCode/MailGo/releases/latest"

type latestReleaseResponse struct {
	Version     string `json:"version"`
	TagName     string `json:"tag_name"`
	URL         string `json:"url"`
	PublishedAt string `json:"published_at"`
}

var latestReleaseCache struct {
	sync.Mutex
	value     latestReleaseResponse
	expiresAt time.Time
}

// LatestRelease returns the latest stable GitHub Release. The destination is
// fixed server-side, and successful responses are cached to avoid exhausting
// GitHub's unauthenticated API rate limit.
func LatestRelease(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	latestReleaseCache.Lock()
	defer latestReleaseCache.Unlock()

	if latestReleaseCache.value.Version != "" && now.Before(latestReleaseCache.expiresAt) {
		w.Header().Set("Cache-Control", "private, max-age=900")
		respondJSON(w, http.StatusOK, latestReleaseCache.value)
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, latestReleaseURL, nil)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "Failed to create update request")
		return
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "MailGo update checker")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	client := &http.Client{Timeout: 8 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		respondError(w, http.StatusBadGateway, "Unable to check for updates")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		respondError(w, http.StatusBadGateway, "GitHub release service is unavailable")
		return
	}

	var release struct {
		TagName     string `json:"tag_name"`
		HTMLURL     string `json:"html_url"`
		PublishedAt string `json:"published_at"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&release); err != nil {
		respondError(w, http.StatusBadGateway, "Invalid GitHub release response")
		return
	}

	tagName := strings.TrimSpace(release.TagName)
	version := strings.TrimPrefix(strings.TrimPrefix(tagName, "v"), "V")
	if version == "" {
		respondError(w, http.StatusBadGateway, "GitHub release has no version")
		return
	}
	if !strings.HasPrefix(release.HTMLURL, "https://github.com/MengMengCode/MailGo/releases/") {
		release.HTMLURL = "https://github.com/MengMengCode/MailGo/releases"
	}
	if r.Context().Err() != nil {
		return
	}

	value := latestReleaseResponse{
		Version:     version,
		TagName:     tagName,
		URL:         release.HTMLURL,
		PublishedAt: release.PublishedAt,
	}
	latestReleaseCache.value = value
	latestReleaseCache.expiresAt = now.Add(15 * time.Minute)

	w.Header().Set("Cache-Control", "private, max-age=900")
	respondJSON(w, http.StatusOK, value)
}
