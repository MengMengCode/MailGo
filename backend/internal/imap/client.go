package imap

import (
	"crypto/tls"
	"fmt"
	"log"
	"mailgo/internal/microsoftauth"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-imap/client"
)

// AccountConfig holds the IMAP connection parameters for one account.
type AccountConfig struct {
	ID              int64
	Host            string
	Port            int
	TLS             bool   // legacy boolean (true for ssl/starttls, false for none)
	Encryption      string // "ssl", "starttls", or "none"
	Username        string
	Password        string
	OAuthToken      string
	SyncDays        int // 0 = sync all, >0 = only sync last N days
	SyncMaxMessages int // 0 = unlimited, >0 = cap initial history backfill
}

// ServerMailbox keeps the server mailbox name together with the IMAP
// attributes returned by LIST (for example \Inbox, \Sent, \Trash). The
// attributes are the most reliable way to classify special-use folders.
type ServerMailbox struct {
	Name       string
	Attributes []string
}

// Connect creates an IMAP client connection, authenticates, and returns
// the ready-to-use client. The caller is responsible for calling Logout()
// and Close() when done.
func Connect(cfg AccountConfig) (*client.Client, error) {
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	enc := cfg.Encryption
	if enc == "" {
		if cfg.TLS || cfg.Port == 993 {
			enc = "ssl"
		} else {
			enc = "starttls"
		}
	}

	// Use a dialer with an explicit timeout so a slow/unreachable IMAP
	// server never blocks the sync indefinitely.  The go-imap Dial/DialTLS
	// helpers use the default dialer (no timeout), so we dial manually
	// and pass the pre-connected net.Conn to client.New().
	dialer := &net.Dialer{Timeout: 15 * time.Second}

	var c *client.Client
	var err error

	switch enc {
	case "ssl":
		tlsConfig := &tls.Config{
			ServerName: cfg.Host,
			MinVersion: tls.VersionTLS12,
		}
		conn, dialErr := dialer.Dial("tcp", addr)
		if dialErr != nil {
			return nil, fmt.Errorf("imap dial %s: %w", addr, dialErr)
		}
		tlsConn := tls.Client(conn, tlsConfig)
		if tlsHandshakeErr := tlsConn.Handshake(); tlsHandshakeErr != nil {
			conn.Close()
			return nil, fmt.Errorf("imap TLS handshake %s: %w", addr, tlsHandshakeErr)
		}
		c, err = client.New(tlsConn)
	case "starttls":
		conn, dialErr := dialer.Dial("tcp", addr)
		if dialErr != nil {
			return nil, fmt.Errorf("imap dial %s: %w", addr, dialErr)
		}
		c, err = client.New(conn)
		if err == nil {
			tlsConfig := &tls.Config{
				ServerName: cfg.Host,
				MinVersion: tls.VersionTLS12,
			}
			if err = c.StartTLS(tlsConfig); err != nil {
				c.Close()
				return nil, fmt.Errorf("imap STARTTLS %s: %w", addr, err)
			}
		}
	case "none":
		conn, dialErr := dialer.Dial("tcp", addr)
		if dialErr != nil {
			return nil, fmt.Errorf("imap dial %s: %w", addr, dialErr)
		}
		c, err = client.New(conn)
	default:
		tlsConfig := &tls.Config{
			ServerName: cfg.Host,
			MinVersion: tls.VersionTLS12,
		}
		conn, dialErr := dialer.Dial("tcp", addr)
		if dialErr != nil {
			return nil, fmt.Errorf("imap dial %s: %w", addr, dialErr)
		}
		tlsConn := tls.Client(conn, tlsConfig)
		if tlsHandshakeErr := tlsConn.Handshake(); tlsHandshakeErr != nil {
			conn.Close()
			return nil, fmt.Errorf("imap TLS handshake %s: %w", addr, tlsHandshakeErr)
		}
		c, err = client.New(tlsConn)
	}
	if err != nil {
		return nil, fmt.Errorf("imap client %s: %w", addr, err)
	}

	// I/O timeout for all commands after login. Bulk fetches of large
	// messages can easily exceed 30s, so we use a generous timeout.
	c.Timeout = 3 * time.Minute

	if cfg.OAuthToken != "" {
		if err := c.Authenticate(microsoftauth.NewXOAuth2Client(cfg.Username, cfg.OAuthToken)); err != nil {
			c.Logout()
			c.Close()
			return nil, fmt.Errorf("imap XOAUTH2 login %s: %w", cfg.Username, explainXOAuth2LoginError(err))
		}
	} else if err := c.Login(cfg.Username, cfg.Password); err != nil {
		c.Logout()
		c.Close()
		return nil, fmt.Errorf("imap login %s: %w", cfg.Username, err)
	}

	return c, nil
}

func explainXOAuth2LoginError(err error) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "user is authenticated but not connected") {
		return fmt.Errorf("%w (Microsoft accepted the OAuth token, but Outlook/Exchange refused the mailbox connection. Check that IMAP is enabled for this mailbox, the account has an active mailbox, and the app has delegated Office 365 Exchange Online IMAP.AccessAsUser.All permission; then reconnect the account)", err)
	}
	return err
}

// FetchMailboxes returns the list of mailbox names available on the server.
func FetchMailboxes(c *client.Client) ([]string, error) {
	infos, err := FetchMailboxInfos(c)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(infos))
	for _, info := range infos {
		names = append(names, info.Name)
	}
	return names, nil
}

// FetchMailboxInfos returns mailbox names and LIST attributes. Callers that
// need folder classification should prefer this over FetchMailboxes.
func FetchMailboxInfos(c *client.Client) ([]ServerMailbox, error) {
	mailboxes := make(chan *imap.MailboxInfo, 10)
	go func() {
		if err := c.List("", "*", mailboxes); err != nil {
			log.Printf("imap list mailboxes error: %v", err)
		}
	}()

	var infos []ServerMailbox
	for mbox := range mailboxes {
		attrs := make([]string, 0, len(mbox.Attributes))
		for _, attr := range mbox.Attributes {
			attrs = append(attrs, strings.ToLower(strings.TrimSpace(attr)))
		}
		infos = append(infos, ServerMailbox{Name: mbox.Name, Attributes: attrs})
	}
	return infos, nil
}

// disconnect safely closes an IMAP connection, suppressing errors.
func disconnect(c *client.Client) {
	if c == nil {
		return
	}
	_ = c.Logout()
	_ = c.Close()
}

// isTemporaryError returns true for transient network errors that should
// be retried on the next sync cycle rather than surfacing to the user.
func isTemporaryError(err error) bool {
	if ne, ok := err.(net.Error); ok && ne.Temporary() {
		return true
	}
	// go-imap wraps errors; check for common timeout / reset strings.
	s := err.Error()
	return contains(s, "timeout") || contains(s, "reset") || contains(s, "broken pipe")
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && searchString(s, sub)
}

func searchString(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
