package handlers

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gorilla/mux"
	"mailgo/internal/safehttp"
)

const avatarCacheTTL = 30 * 24 * time.Hour
const maxFaviconBytes = 256 * 1024
const avatarCacheVersion = "v2:"

func GetFaviconAvatar(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.URL.Query().Get("domain"))
	if domain == "" {
		email := strings.TrimSpace(r.URL.Query().Get("email"))
		if at := strings.LastIndex(email, "@"); at >= 0 && at < len(email)-1 {
			domain = email[at+1:]
		}
	}
	domain = normalizeAvatarDomain(domain)
	if domain == "" || isUnsafeAvatarDomain(domain) {
		http.NotFound(w, r)
		return
	}

	cacheDir, err := avatarCacheDir()
	if err != nil {
		log.Printf("avatar cache dir: %v", err)
		http.NotFound(w, r)
		return
	}
	_ = os.MkdirAll(cacheDir, 0755)

	key := hashString(avatarCacheVersion + domain)
	if serveCachedAvatar(w, r, cacheDir, key) {
		return
	}

	data, contentType, err := fetchFaviconForDomain(domain)
	if err != nil {
		_ = os.WriteFile(filepath.Join(cacheDir, key+".miss"), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
		http.NotFound(w, r)
		return
	}

	ext := extensionForContentType(contentType)
	cachePath := filepath.Join(cacheDir, key+ext)
	if err := os.WriteFile(cachePath, data, 0644); err != nil {
		log.Printf("avatar cache write: %v", err)
	}
	writeAvatarResponse(w, data, contentType)
}

func serveCachedAvatar(w http.ResponseWriter, r *http.Request, cacheDir, key string) bool {
	missPath := filepath.Join(cacheDir, key+".miss")
	if stat, err := os.Stat(missPath); err == nil && time.Since(stat.ModTime()) < avatarCacheTTL {
		http.NotFound(w, r)
		return true
	}

	matches, _ := filepath.Glob(filepath.Join(cacheDir, key+".*"))
	for _, path := range matches {
		if strings.HasSuffix(path, ".miss") {
			continue
		}
		stat, err := os.Stat(path)
		if err != nil || time.Since(stat.ModTime()) >= avatarCacheTTL {
			_ = os.Remove(path)
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		contentType := mime.TypeByExtension(filepath.Ext(path))
		if contentType == "" {
			contentType = http.DetectContentType(data)
		}
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Header().Set("Content-Type", contentType)
		http.ServeContent(w, r, filepath.Base(path), stat.ModTime(), bytes.NewReader(data))
		return true
	}
	return false
}

// GetGravatarAvatar serves a Gravatar image for the given email address.
// Falls back to 404 when the email has no Gravatar, so the frontend can
// fall through to the initials block.
func GetGravatarAvatar(w http.ResponseWriter, r *http.Request) {
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	if email == "" {
		http.NotFound(w, r)
		return
	}

	cacheDir, err := avatarCacheDir()
	if err != nil {
		log.Printf("avatar cache dir: %v", err)
		http.NotFound(w, r)
		return
	}
	_ = os.MkdirAll(cacheDir, 0755)

	key := hashString("gravatar:" + strings.ToLower(strings.TrimSpace(email)))
	if serveCachedAvatar(w, r, cacheDir, key) {
		return
	}

	// Gravatar URL: MD5 hash of lowercased trimmed email.
	h := md5.Sum([]byte(strings.ToLower(strings.TrimSpace(email))))
	hash := hex.EncodeToString(h[:])
	gravURL := "https://www.gravatar.com/avatar/" + hash + "?d=404&s=128"

	client := safehttp.NewClient(8 * time.Second)
	req, _ := http.NewRequest(http.MethodGet, gravURL, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MailGo/1.0 Safari/537.36")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")

	// codeql[go/request-forgery]
	resp, err := client.Do(req)
	if err != nil {
		_ = os.WriteFile(filepath.Join(cacheDir, key+".miss"), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
		http.NotFound(w, r)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		_ = os.WriteFile(filepath.Join(cacheDir, key+".miss"), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
		http.NotFound(w, r)
		return
	}

	limited := io.LimitReader(resp.Body, maxFaviconBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) == 0 || len(data) > maxFaviconBytes {
		_ = os.WriteFile(filepath.Join(cacheDir, key+".miss"), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
		http.NotFound(w, r)
		return
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		_ = os.WriteFile(filepath.Join(cacheDir, key+".miss"), []byte(time.Now().UTC().Format(time.RFC3339)), 0644)
		http.NotFound(w, r)
		return
	}

	ext := extensionForContentType(contentType)
	cachePath := filepath.Join(cacheDir, key+ext)
	if err := os.WriteFile(cachePath, data, 0644); err != nil {
		log.Printf("avatar cache write: %v", err)
	}
	writeAvatarResponse(w, data, contentType)
}

// fetchFaviconForDomain attempts to find a favicon/logo for the given domain.
// It tries multiple strategies in order:
//  1. Direct favicon.ico on the domain and common variants
//  2. <link rel="icon"> tags parsed from the homepage HTML
//  3. Google faviconV2 API (returns 200 for real favicons, 404 for unknown domains)
//  4. DuckDuckGo icon proxy (another reliable fallback)
func fetchFaviconForDomain(domain string) ([]byte, string, error) {
	if err := safehttp.ValidateHostname(context.Background(), domain); err != nil {
		return nil, "", err
	}
	client := safehttp.NewClient(8 * time.Second)

	// Phase 1: Try direct /favicon.ico candidates (fast).
	for _, candidate := range faviconCandidates(domain) {
		data, ct, err := probeURL(client, candidate)
		if err == nil {
			return data, ct, nil
		}
	}

	// Phase 2: Fetch the homepage HTML and look for <link rel="icon"> tags.
	// Many modern sites (e.g. SPA apps, CDNs) don't serve a favicon.ico at
	// the root but do declare one in their HTML.
	if data, ct, err := fetchFaviconFromHTML(client, domain); err == nil {
		return data, ct, nil
	}

	// Phase 3: Google favicon service (new API endpoint) — very reliable.
	// Returns 200 + real favicon for valid domains, 404 for unknown domains.
	googleURL := "https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=" +
		neturl.QueryEscape("http://"+domain) + "&size=128"
	if data, ct, err := probeURL(client, googleURL); err == nil {
		return data, ct, nil
	}

	// Phase 4: DuckDuckGo icon proxy.
	ddgURL := "https://icons.duckduckgo.com/ip3/" + neturl.PathEscape(domain) + ".ico"
	if data, ct, err := probeURL(client, ddgURL); err == nil {
		return data, ct, nil
	}

	return nil, "", os.ErrNotExist
}

// probeURL fetches a single URL and returns the image data if valid.
func probeURL(client *http.Client, url string) ([]byte, string, error) {
	target, err := neturl.Parse(url)
	if err != nil {
		return nil, "", err
	}
	if err := safehttp.ValidateURL(context.Background(), target); err != nil {
		return nil, "", err
	}
	req, err := http.NewRequest(http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MailGo/1.0 Safari/537.36")
	req.Header.Set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
	// safehttp validates the URL, every redirect, and the IP used at dial time.
	// codeql[go/request-forgery]
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", os.ErrNotExist
	}
	limited := io.LimitReader(resp.Body, maxFaviconBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) == 0 || len(data) > maxFaviconBytes {
		return nil, "", os.ErrNotExist
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	ctLower := strings.ToLower(contentType)
	if !strings.HasPrefix(ctLower, "image/") &&
		!strings.Contains(ctLower, "octet-stream") &&
		!strings.Contains(ctLower, "x-icon") {
		return nil, "", os.ErrNotExist
	}
	return data, contentType, nil
}

// linkRelIconRe matches <link rel="icon" href="..."> and variants.
var linkRelIconRe = regexp.MustCompile(`(?i)<link\s+[^>]*rel\s*=\s*["']?(?:shortcut )?icon["']?[^>]*>`)

// hrefRe extracts the href value from a <link> tag.
var hrefRe = regexp.MustCompile(`(?i)href\s*=\s*["']([^"']+)["']`)

// fetchFaviconFromHTML fetches the homepage of a domain, parses the HTML
// for <link rel="icon"> tags, and tries to download the referenced favicon.
func fetchFaviconFromHTML(client *http.Client, domain string) ([]byte, string, error) {
	// Try fetching the homepage from multiple hosts.
	hosts := []string{domain}
	root := rootAvatarDomain(domain)
	if root != domain {
		hosts = append(hosts, root)
		hosts = append(hosts, "www."+root)
	}

	seen := make(map[string]bool)
	for _, host := range hosts {
		host = normalizeAvatarDomain(host)
		if host == "" || seen[host] {
			continue
		}
		seen[host] = true

		homeURL := "https://" + host + "/"
		req, _ := http.NewRequest(http.MethodGet, homeURL, nil)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MailGo/1.0 Safari/537.36")
		req.Header.Set("Accept", "text/html,*/*")

		// safehttp validates every redirect and the IP used at dial time.
		// codeql[go/request-forgery]
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			continue
		}
		// Read only the first 256KB of HTML — the <link> tags are in <head>.
		limited := io.LimitReader(resp.Body, 256*1024)
		html, err := io.ReadAll(limited)
		resp.Body.Close()
		if err != nil || len(html) == 0 {
			continue
		}

		// Find <link rel="icon" ...> tags.
		matches := linkRelIconRe.FindAll(html, -1)
		for _, match := range matches {
			hrefMatch := hrefRe.FindSubmatch(match)
			if hrefMatch == nil {
				continue
			}
			iconURL := string(hrefMatch[1])
			// Resolve relative URLs.
			if strings.HasPrefix(iconURL, "//") {
				iconURL = "https:" + iconURL
			} else if strings.HasPrefix(iconURL, "/") {
				iconURL = "https://" + host + iconURL
			} else if !strings.HasPrefix(iconURL, "http") {
				iconURL = "https://" + host + "/" + iconURL
			}

			data, ct, err := probeURL(client, iconURL)
			if err == nil {
				return data, ct, nil
			}
		}
	}
	return nil, "", os.ErrNotExist
}

func faviconCandidates(domain string) []string {
	root := rootAvatarDomain(domain)
	seen := make(map[string]bool)
	out := make([]string, 0, 3)
	add := func(host string) {
		host = normalizeAvatarDomain(host)
		if host == "" || seen[host] {
			return
		}
		seen[host] = true
		out = append(out, "https://"+host+"/favicon.ico")
	}
	add(domain)
	add(root)
	add("www." + root)
	return out
}

func normalizeAvatarDomain(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	value = strings.TrimPrefix(value, "http://")
	value = strings.TrimPrefix(value, "https://")
	if slash := strings.Index(value, "/"); slash >= 0 {
		value = value[:slash]
	}
	host, _, err := net.SplitHostPort(value)
	if err == nil {
		value = host
	}
	value = strings.Trim(value, ".")
	return value
}

func rootAvatarDomain(domain string) string {
	parts := strings.Split(domain, ".")
	if len(parts) <= 2 {
		return domain
	}
	return strings.Join(parts[len(parts)-2:], ".")
}

func isUnsafeAvatarDomain(domain string) bool {
	return safehttp.ValidateHostname(context.Background(), domain) != nil
}

func avatarCacheDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".mailgo", "avatar-cache"), nil
}

func hashString(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func extensionForContentType(contentType string) string {
	contentType = strings.ToLower(strings.Split(contentType, ";")[0])
	switch contentType {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/svg+xml":
		return ".svg"
	case "image/webp":
		return ".webp"
	default:
		return ".ico"
	}
}

func writeAvatarResponse(w http.ResponseWriter, data []byte, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

// ---------------------------------------------------------------------------
// Persistent avatar storage
// ---------------------------------------------------------------------------

// avatarStoreDir returns the directory where permanently-stored avatars live.
func avatarStoreDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".mailgo", "avatars"), nil
}

// FetchAvatar downloads an avatar for the given domain or email and stores it
// permanently on disk. Returns JSON { "url": "/api/v1/avatars/serve/<file>" }.
//
//	GET /api/v1/avatars/fetch?domain=example.com
//	GET /api/v1/avatars/fetch?email=user@example.com
func FetchAvatar(w http.ResponseWriter, r *http.Request) {
	domain := strings.TrimSpace(r.URL.Query().Get("domain"))
	email := strings.TrimSpace(r.URL.Query().Get("email"))
	if domain == "" && email == "" {
		respondError(w, http.StatusBadRequest, "domain or email is required")
		return
	}
	if domain == "" {
		if at := strings.LastIndex(email, "@"); at >= 0 && at < len(email)-1 {
			domain = email[at+1:]
		}
	}
	domain = normalizeAvatarDomain(domain)
	if domain == "" {
		respondError(w, http.StatusBadRequest, "invalid domain")
		return
	}

	storeDir, err := avatarStoreDir()
	if err != nil {
		log.Printf("avatar store dir: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to prepare avatar storage")
		return
	}
	_ = os.MkdirAll(storeDir, 0755)

	// Try favicon first.
	data, contentType, err := fetchFaviconForDomain(domain)
	if err != nil && email != "" {
		// Fallback to Gravatar.
		data, contentType, err = fetchGravatarForEmail(email)
	}
	if err != nil || len(data) == 0 {
		respondError(w, http.StatusNotFound, "No avatar found for this domain")
		return
	}

	ext := extensionForContentType(contentType)
	key := hashString("store:" + domain)
	filename := key + ext
	storePath := filepath.Join(storeDir, filename)

	if err := os.WriteFile(storePath, data, 0644); err != nil {
		log.Printf("avatar store write: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to save avatar")
		return
	}

	serveURL := "/api/v1/avatars/serve/" + filename
	respondJSON(w, http.StatusOK, map[string]string{"url": serveURL})
}

// ServeAvatar serves a previously-stored avatar file.
//
//	GET /api/v1/avatars/serve/{file}
func ServeAvatar(w http.ResponseWriter, r *http.Request) {
	file := mux.Vars(r)["file"]
	if file == "" || strings.Contains(file, "..") || strings.ContainsAny(file, `/\:`) {
		http.NotFound(w, r)
		return
	}

	storeDir, err := avatarStoreDir()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	path := filepath.Join(storeDir, file)
	data, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	contentType := mime.TypeByExtension(filepath.Ext(path))
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=604800")
	_, _ = w.Write(data)
}

// fetchGravatarForEmail downloads a Gravatar image for the given email.
// Returns an error if the email has no Gravatar set.
func fetchGravatarForEmail(email string) ([]byte, string, error) {
	h := md5.Sum([]byte(strings.ToLower(strings.TrimSpace(email))))
	hash := hex.EncodeToString(h[:])
	gravURL := "https://www.gravatar.com/avatar/" + hash + "?d=404&s=128"

	client := safehttp.NewClient(8 * time.Second)
	req, _ := http.NewRequest(http.MethodGet, gravURL, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MailGo/1.0 Safari/537.36")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, "", os.ErrNotExist
	}

	limited := io.LimitReader(resp.Body, maxFaviconBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil || len(data) == 0 || len(data) > maxFaviconBytes {
		return nil, "", os.ErrNotExist
	}

	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		return nil, "", os.ErrNotExist
	}

	return data, contentType, nil
}
