package handlers

import (
	"encoding/base64"
	"log"
	"mailgo/internal/database"
	"mailgo/internal/imap"
	"net/http"
	"strconv"
	"strings"
)

// Attachment represents a stored email attachment. The content is stored as
// a BLOB in SQLite so the whole thing is self-contained — no external file
// system needed.
type Attachment struct {
	ID        int64  `json:"id"`
	MessageID int64  `json:"message_id"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mime_type"`
	Size      int64  `json:"size"`
	ContentID string `json:"content_id"`
	PartID    string `json:"part_id"`
}

// ListAttachments returns metadata for every attachment belonging to a
// message. Content is NOT included — use GET /attachments/{id} to download.
func ListAttachments(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid message ID")
		return
	}

	rows, err := database.DB.Query(
		`SELECT id, message_id, filename, mime_type, size, COALESCE(content_id,''), COALESCE(part_id,'')
		 FROM attachments WHERE message_id = ? ORDER BY id`,
		id,
	)
	if err != nil {
		log.Printf("ListAttachments error: %v", err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch attachments")
		return
	}
	defer rows.Close()

	items := make([]Attachment, 0)
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.ID, &a.MessageID, &a.Filename, &a.MimeType,
			&a.Size, &a.ContentID, &a.PartID); err != nil {
			log.Printf("ListAttachments scan error: %v", err)
			continue
		}
		items = append(items, a)
	}
	respondJSON(w, http.StatusOK, items)
}

// GetAttachment streams the raw attachment content to the browser. The
// content is lazily fetched from the IMAP server on first access and
// cached for 24 hours (attachments.content_expires_at). Safe previewable
// types (PDF, images, text, etc.) use Content-Disposition: inline so the
// browser shows them inline like Gmail. Other types use attachment to
// force a download.
func GetAttachment(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid attachment ID")
		return
	}

	// Lazily fetch + cache the content from IMAP.
	filename, mimeType, content, err := imap.FetchAttachmentContent(id)
	if err != nil {
		log.Printf("GetAttachment fetch error (id=%d): %v", id, err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch attachment")
		return
	}

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))

	// Determine whether this MIME type is safe for inline preview.
	// Browsers can natively render PDFs, images, plain text, and HTML.
	if isInlinePreviewable(mimeType) {
		w.Header().Set("Content-Disposition", `inline; filename="`+sanitizeFilename(filename)+`"`)
	} else {
		w.Header().Set("Content-Disposition", `attachment; filename="`+sanitizeFilename(filename)+`"`)
	}
	w.Write(content)
}

// previewDataResp is the JSON payload returned by GetAttachmentPreviewData.
// The attachment bytes are base64-encoded so the whole response is served as
// application/json — download managers that hijack application/pdf responses
// never see a downloadable Content-Type and leave the request alone, letting
// the browser-side PDF.js render the preview.
type previewDataResp struct {
	Filename   string `json:"filename"`
	MimeType   string `json:"mime_type"`
	Size       int64  `json:"size"`
	DataBase64 string `json:"data_base64"`
}

// GetAttachmentPreviewData returns the attachment content as a base64 string
// wrapped in a JSON object. Unlike GetAttachment (which streams raw bytes
// with the real Content-Type and triggers download-manager hijacking), this
// endpoint always responds with application/json so browser extensions
// ignore it. The frontend decodes the base64 and feeds it to PDF.js.
func GetAttachmentPreviewData(w http.ResponseWriter, r *http.Request) {
	id, ok := parseIDParam(r, "id")
	if !ok {
		respondError(w, http.StatusBadRequest, "Invalid attachment ID")
		return
	}

	filename, mimeType, content, err := imap.FetchAttachmentContent(id)
	if err != nil {
		log.Printf("GetAttachmentPreviewData fetch error (id=%d): %v", id, err)
		respondError(w, http.StatusInternalServerError, "Failed to fetch attachment")
		return
	}

	resp := previewDataResp{
		Filename:   filename,
		MimeType:   mimeType,
		Size:       int64(len(content)),
		DataBase64: base64.StdEncoding.EncodeToString(content),
	}
	respondJSON(w, http.StatusOK, resp)
}

// isPdfMimeType reports whether the given MIME type is a PDF.
func isPdfMimeType(mimeType string) bool {
	mt := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	return mt == "application/pdf" || mt == "application/x-pdf"
}

// isInlinePreviewable returns true for MIME types that browsers can render
// directly without a plugin. These use Content-Disposition: inline so the
// user sees a preview instead of a forced download.
func isInlinePreviewable(mimeType string) bool {
	mt := mimeType
	// Normalize — strip parameters like "; charset=utf-8"
	if i := indexByte(mt, ';'); i >= 0 {
		mt = mt[:i]
	}
	mt = trimSpace(mt)
	switch mt {
	case "application/pdf", "application/x-pdf":
		return true
	case "text/plain", "text/csv", "text/markdown",
		"application/json", "application/xml":
		return true
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
		"image/bmp", "image/x-icon", "image/tiff":
		return true
	case "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav":
		return true
	}
	return false
}

func sanitizeFilename(name string) string {
	// Remove any characters that could break the Content-Disposition header.
	out := make([]byte, 0, len(name))
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c == '"' || c == '\\' || c == '\r' || c == '\n' {
			continue
		}
		out = append(out, c)
	}
	return string(out)
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

// storeAttachments inserts one row per attachment into the attachments
// table, decoding the base64 payload into a BLOB. Called by SendMessage
// and SaveDraft when the user includes files.
type attachmentInput struct {
	Filename   string `json:"filename"`
	MimeType   string `json:"mime_type"`
	Size       int64  `json:"size"`
	ContentID  string `json:"content_id"`
	DataBase64 string `json:"data_base64"`
}

func storeAttachments(messageID int64, atts []attachmentInput) {
	if len(atts) == 0 {
		return
	}
	stmt, err := database.DB.Prepare(
		`INSERT INTO attachments (message_id, filename, mime_type, size, content_id, part_id, content)
		 VALUES (?, ?, ?, ?, ?, '', ?)`,
	)
	if err != nil {
		log.Printf("storeAttachments prepare error: %v", err)
		return
	}
	defer stmt.Close()

	for _, a := range atts {
		data, err := base64.StdEncoding.DecodeString(a.DataBase64)
		if err != nil {
			log.Printf("storeAttachments decode error for %s: %v", a.Filename, err)
			continue
		}
		actualSize := a.Size
		if actualSize == 0 {
			actualSize = int64(len(data))
		}
		if _, err := stmt.Exec(messageID, a.Filename, a.MimeType, actualSize, a.ContentID, data); err != nil {
			log.Printf("storeAttachments insert error for %s: %v", a.Filename, err)
		}
	}
}
