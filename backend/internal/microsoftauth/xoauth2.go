package microsoftauth

import (
	"errors"
	"fmt"
	"net/smtp"

	"github.com/emersion/go-sasl"
)

type xoauth2Client struct {
	username string
	token    string
}

func NewXOAuth2Client(username, accessToken string) sasl.Client {
	return &xoauth2Client{username: username, token: accessToken}
}

func (c *xoauth2Client) Start() (string, []byte, error) {
	return "XOAUTH2", xoauth2Payload(c.username, c.token), nil
}

func (c *xoauth2Client) Next(challenge []byte) ([]byte, error) {
	if len(challenge) > 0 {
		return nil, fmt.Errorf("XOAUTH2 rejected: %s", string(challenge))
	}
	return nil, errors.New("XOAUTH2 authentication rejected")
}

type smtpXOAuth2 struct {
	username string
	token    string
}

func NewSMTPAuth(username, accessToken string) smtp.Auth {
	return &smtpXOAuth2{username: username, token: accessToken}
}

func (a *smtpXOAuth2) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS {
		return "", nil, errors.New("XOAUTH2 requires a TLS connection")
	}
	return "XOAUTH2", xoauth2Payload(a.username, a.token), nil
}

func (a *smtpXOAuth2) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}
	if len(fromServer) > 0 {
		return nil, fmt.Errorf("XOAUTH2 rejected: %s", string(fromServer))
	}
	return nil, errors.New("XOAUTH2 authentication rejected")
}

func xoauth2Payload(username, token string) []byte {
	return []byte("user=" + username + "\x01auth=Bearer " + token + "\x01\x01")
}
