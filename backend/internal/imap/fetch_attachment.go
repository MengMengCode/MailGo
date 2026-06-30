package imap

import (
	"database/sql"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"strings"
	"time"

	"mailgo/internal/database"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
)

// attachmentTTL is how long cached attachment content stays valid.
const attachmentTTL = 24 * time.Hour

// FetchAttachmentContent lazily downloads a single attachment's content
// from the IMAP server. It connects to the account, selects the message's
// folder, fetches the full RFC822 body, parses the MIME tree, and finds
// the part whose filename or Content-ID matches the requested attachment.
//
// The content is cached in the attachments.content BLOB with a TTL
// (content_expires_at). Subsequent calls within the TTL serve from cache
// without hitting IMAP.
func FetchAttachmentContent(attachmentID int64) (filename, mimeType string, data []byte, err error) {
	// 1. Check cache first.
	var cachedData []byte
	var cachedExpiry sql.NullTime
	var cachedMime, cachedFilename string
	var contentID string
	var partID string
	err = database.DB.QueryRow(
		`SELECT filename, COALESCE(mime_type,'application/octet-stream'), content, content_expires_at, COALESCE(content_id,''), COALESCE(part_id,'')
		 FROM attachments WHERE id = ?`,
		attachmentID,
	).Scan(&cachedFilename, &cachedMime, &cachedData, &cachedExpiry, &contentID, &partID)
	if err != nil {
		return "", "", nil, fmt.Errorf("attachment lookup: %w", err)
	}

	// Serve from cache if content exists and hasn't expired.
	if len(cachedData) > 0 && cachedExpiry.Valid && cachedExpiry.Time.After(time.Now()) {
		return cachedFilename, cachedMime, cachedData, nil
	}

	// 2. Need to fetch from IMAP. Look up the message + account info.
	//    The attachments table has no account_id column — get it from
	//    the joined messages row instead.
	var accountID int64
	var uid int64
	var folderName string
	err = database.DB.QueryRow(
		`SELECT m.account_id, m.uid, f.name
		 FROM attachments a
		 JOIN messages m ON a.message_id = m.id
		 JOIN folders f ON m.folder_id = f.id
		 WHERE a.id = ?`,
		attachmentID,
	).Scan(&accountID, &uid, &folderName)
	if err != nil {
		return "", "", nil, fmt.Errorf("attachment message lookup: %w", err)
	}

	// 3. Connect to IMAP and fetch the raw message body.
	configs, err := LoadAccountConfigs(accountID)
	if err != nil || len(configs) == 0 {
		return "", "", nil, fmt.Errorf("no IMAP config for account %d", accountID)
	}
	cfg := configs[0]

	c, err := Connect(cfg)
	if err != nil {
		return "", "", nil, fmt.Errorf("imap connect: %w", err)
	}
	defer disconnect(c)

	// Resolve the server folder name.
	serverMailboxes, err := FetchMailboxInfos(c)
	if err != nil {
		return "", "", nil, fmt.Errorf("list mailboxes: %w", err)
	}
	serverSet := make(map[string]bool, len(serverMailboxes))
	for _, mb := range serverMailboxes {
		serverSet[normalizeMailboxName(mb.Name)] = true
	}
	serverName := resolveServerFolderName(folderName, "", serverSet, serverMailboxes)
	if serverName == "" {
		return "", "", nil, fmt.Errorf("folder %q not found on server", folderName)
	}

	// Select and fetch the message by UID.
	if _, err := c.Select(serverName, true); err != nil {
		return "", "", nil, fmt.Errorf("select %s: %w", serverName, err)
	}

	rawBody, err := fetchRawBodyByUID(c, uint32(uid))
	if err != nil {
		return "", "", nil, fmt.Errorf("fetch uid %d: %w", uid, err)
	}
	if rawBody == "" {
		return "", "", nil, fmt.Errorf("empty message body")
	}

	// 4. Parse the MIME tree and find the matching attachment part.
	foundMime, foundData, found, ferr := findAttachmentPart(rawBody, cachedFilename, contentID, partID)
	if ferr != nil {
		return "", "", nil, fmt.Errorf("find attachment: %w", ferr)
	}
	if !found {
		return "", "", nil, fmt.Errorf("attachment %q not found in message", cachedFilename)
	}

	// 5. Cache the content with a TTL.
	expiresAt := time.Now().Add(attachmentTTL)
	_, _ = database.DB.Exec(
		`UPDATE attachments SET content = ?, content_expires_at = ?, size = ? WHERE id = ?`,
		foundData, expiresAt, len(foundData), attachmentID,
	)

	return cachedFilename, foundMime, foundData, nil
}

// fetchRawBodyByUID fetches the full RFC822 body of a single message by UID.
func fetchRawBodyByUID(c *client.Client, uid uint32) (string, error) {
	seqSet := new(imap.SeqSet)
	seqSet.AddNum(uid)

	section := &imap.BodySectionName{Peek: true}
	items := []imap.FetchItem{
		imap.FetchUid,
		section.FetchItem(),
	}

	ch := make(chan *imap.Message, 1)
	go func() {
		if err := c.UidFetch(seqSet, items, ch); err != nil {
			log.Printf("fetchRawBodyByUID uid fetch: %v", err)
		}
	}()

	msg := <-ch
	if msg == nil {
		return "", fmt.Errorf("message not found")
	}

	r := msg.GetBody(section)
	if r == nil {
		return "", fmt.Errorf("no body returned")
	}
	b, err := io.ReadAll(r)
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}
	return string(b), nil
}

// findAttachmentPart walks the MIME tree of a raw RFC822 message and
// returns the decoded content of the part whose part_id, filename, or
// Content-ID matches. part_id is tried first for exact disambiguation.
// Returns (mimeType, data, found, error).
func findAttachmentPart(raw, wantFilename, wantContentID, wantPartID string) (string, []byte, bool, error) {
	m, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		return "", nil, false, fmt.Errorf("parse message: %w", err)
	}

	mediaType, params, _ := mime.ParseMediaType(m.Header.Get("Content-Type"))
	wantFilename = strings.TrimSpace(wantFilename)
	wantContentID = strings.TrimSpace(wantContentID)

	result, err := walkFindAttachment(m.Body, mediaType, params, wantFilename, wantContentID, wantPartID, "")
	return result.mimeType, result.data, result.found, err
}

type attachmentFindResult struct {
	mimeType string
	data     []byte
	found    bool
}

// walkFindAttachment recursively walks a multipart tree looking for an
// attachment whose part_id, filename, or Content-ID matches. When
// wantPartID is set it is checked first for exact disambiguation.
// currentPartIndex tracks the hierarchical MIME position (e.g. "1", "2.1").
func walkFindAttachment(body io.Reader, mediaType string, params map[string]string, wantFilename, wantContentID, wantPartID, currentPartIndex string) (attachmentFindResult, error) {
	if strings.HasPrefix(mediaType, "multipart/") {
		mr := multipart.NewReader(body, params["boundary"])
		idx := 0
		for {
			p, err := mr.NextPart()
			if err != nil {
				break
			}
			idx++
			childIndex := currentPartIndex
			if childIndex == "" {
				childIndex = fmt.Sprintf("%d", idx)
			} else {
				childIndex = fmt.Sprintf("%s.%d", currentPartIndex, idx)
			}
			pMediaType, pParams, _ := mime.ParseMediaType(p.Header.Get("Content-Type"))
			pCTE := strings.ToLower(p.Header.Get("Content-Transfer-Encoding"))
			partReader := decodeReader(p, pCTE)

			if strings.HasPrefix(pMediaType, "multipart/") {
				// Recurse into nested multipart.
				r, err := walkFindAttachment(partReader, pMediaType, pParams, wantFilename, wantContentID, wantPartID, childIndex)
				if err == nil && r.found {
					return r, nil
				}
				continue
			}

			disposition, dParams, _ := mime.ParseMediaType(p.Header.Get("Content-Disposition"))
			filename := pParams["name"]
			if fn := dParams["filename"]; fn != "" {
				filename = fn
			}
			cid := strings.Trim(p.Header.Get("Content-ID"), "<>")

			if disposition == "attachment" || disposition == "inline" || filename != "" || cid != "" {
				decodedFilename := mimeHeaderDecode(filename)
				// Match by part_id first (most reliable), then
				// Content-ID, then filename.
				matched := false
				if wantPartID != "" && childIndex == wantPartID {
					matched = true
				} else if wantContentID != "" && cid == wantContentID {
					matched = true
				} else if wantFilename != "" && strings.EqualFold(decodedFilename, wantFilename) {
					matched = true
				}
				if matched {
					data, err := io.ReadAll(partReader)
					if err != nil {
						return attachmentFindResult{}, err
					}
					return attachmentFindResult{
						mimeType: pMediaType,
						data:     data,
						found:    true,
					}, nil
				}
			}
		}
		return attachmentFindResult{}, nil
	}

	// Non-multipart — check if the top-level is the attachment.
	return attachmentFindResult{}, nil
}

// FetchMessageRaw downloads the full RFC822 source of a message from the
// IMAP server and returns it as-is. Used by the "view source" feature in
// the message detail view. Unlike FetchAttachmentContent it does not
// consult any cache — the raw source is small enough that re-fetching on
// demand is fine, and caching it would balloon the database.
func FetchMessageRaw(messageID int64) (string, error) {
	// Look up account + folder + uid for the message.
	var accountID int64
	var uid int64
	var folderName string
	err := database.DB.QueryRow(
		`SELECT m.account_id, m.uid, f.name
		 FROM messages m
		 JOIN folders f ON m.folder_id = f.id
		 WHERE m.id = ?`,
		messageID,
	).Scan(&accountID, &uid, &folderName)
	if err != nil {
		return "", fmt.Errorf("message lookup: %w", err)
	}

	configs, err := LoadAccountConfigs(accountID)
	if err != nil || len(configs) == 0 {
		return "", fmt.Errorf("no IMAP config for account %d", accountID)
	}
	cfg := configs[0]

	c, err := Connect(cfg)
	if err != nil {
		return "", fmt.Errorf("imap connect: %w", err)
	}
	defer disconnect(c)

	serverMailboxes, err := FetchMailboxInfos(c)
	if err != nil {
		return "", fmt.Errorf("list mailboxes: %w", err)
	}
	serverSet := make(map[string]bool, len(serverMailboxes))
	for _, mb := range serverMailboxes {
		serverSet[normalizeMailboxName(mb.Name)] = true
	}
	serverName := resolveServerFolderName(folderName, "", serverSet, serverMailboxes)
	if serverName == "" {
		return "", fmt.Errorf("folder %q not found on server", folderName)
	}

	if _, err := c.Select(serverName, true); err != nil {
		return "", fmt.Errorf("select %s: %w", serverName, err)
	}

	rawBody, err := fetchRawBodyByUID(c, uint32(uid))
	if err != nil {
		return "", fmt.Errorf("fetch uid %d: %w", uid, err)
	}
	return rawBody, nil
}

// decodeReader is already defined in sync.go but we need it here too.
// (Go allows same-package function reuse, so this is just a note.)
var _ = quotedprintable.NewReader // ensure import is used
var _ = base64.StdEncoding        // ensure import is used
