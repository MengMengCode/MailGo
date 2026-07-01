package handlers

import (
	"crypto/tls"
	"fmt"
	mailimap "mailgo/internal/imap"
	"mailgo/internal/microsoftauth"
	"net"
	"net/http"
	"net/smtp"
	"strings"
	"time"
)

func StartMicrosoftDeviceAuthorization(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := decodeJSON(r, &body); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	parts := strings.Split(email, "@")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		respondError(w, http.StatusBadRequest, "Invalid Microsoft email address")
		return
	}
	result, err := microsoftauth.StartDeviceAuthorization(r.Context(), email)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, result)
}

func PollMicrosoftDeviceAuthorization(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FlowID string `json:"flow_id"`
	}
	if err := decodeJSON(r, &body); err != nil || strings.TrimSpace(body.FlowID) == "" {
		respondError(w, http.StatusBadRequest, "flow_id is required")
		return
	}
	result, err := microsoftauth.PollDeviceAuthorization(r.Context(), body.FlowID)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}
	if result.Status == "authorized" {
		email, token, ok := microsoftauth.AuthorizedCredentials(body.FlowID)
		if !ok {
			respondError(w, http.StatusBadRequest, "Microsoft authorization session was not found")
			return
		}
		if err := verifyMicrosoftMailbox(email, token); err != nil {
			microsoftauth.ForgetFlow(body.FlowID)
			respondError(w, http.StatusBadRequest,
				"Microsoft authorized the account, but mail access failed: "+err.Error())
			return
		}
	}
	respondJSON(w, http.StatusOK, result)
}

func verifyMicrosoftMailbox(email, accessToken string) error {
	imapClient, err := mailimap.Connect(mailimap.AccountConfig{
		Host:       "outlook.office365.com",
		Port:       993,
		TLS:        true,
		Encryption: "ssl",
		Username:   email,
		OAuthToken: accessToken,
	})
	if err != nil {
		return fmt.Errorf("IMAP XOAUTH2: %w", err)
	}
	_ = imapClient.Logout()
	_ = imapClient.Close()

	const smtpHost = "smtp-mail.outlook.com"
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	conn, err := dialer.Dial("tcp", smtpHost+":587")
	if err != nil {
		return fmt.Errorf("SMTP connect: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	client, err := smtp.NewClient(conn, smtpHost)
	if err != nil {
		return fmt.Errorf("SMTP client: %w", err)
	}
	defer client.Close()
	if err := client.StartTLS(&tls.Config{
		ServerName: smtpHost,
		MinVersion: tls.VersionTLS12,
	}); err != nil {
		return fmt.Errorf("SMTP STARTTLS: %w", err)
	}
	if err := client.Auth(microsoftauth.NewSMTPAuth(email, accessToken)); err != nil {
		return fmt.Errorf("SMTP XOAUTH2: %w", err)
	}
	return client.Quit()
}
