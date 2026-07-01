package microsoftauth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mailgo/internal/crypto"
	"mailgo/internal/database"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	defaultDeviceCodeURL = "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode"
	defaultTokenURL      = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
	scopes               = "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"
)

var httpClient = &http.Client{Timeout: 20 * time.Second}
var deviceCodeEndpoint = defaultDeviceCodeURL
var tokenEndpoint = defaultTokenURL

type Config struct {
	ClientID     string
	ClientSecret string
}

type DeviceAuthorization struct {
	FlowID          string `json:"flow_id"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	Message         string `json:"message"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

type PollResult struct {
	Status   string `json:"status"`
	Interval int    `json:"interval,omitempty"`
}

type tokenSet struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

type pendingFlow struct {
	Email      string
	DeviceCode string
	ExpiresAt  time.Time
	Interval   int
	LastPollAt time.Time
	Tokens     *tokenSet
}

var flowStore = struct {
	sync.Mutex
	flows map[string]*pendingFlow
}{flows: make(map[string]*pendingFlow)}

var refreshMu sync.Mutex

func Configured() bool {
	cfg, err := LoadConfig()
	return err == nil && cfg.ClientID != "" && cfg.ClientSecret != ""
}

func LoadConfig() (Config, error) {
	values := map[string]string{}
	rows, err := database.DB.Query(
		`SELECT setting_key, setting_value FROM settings
		 WHERE setting_key IN ('microsoft_client_id', 'microsoft_client_secret')`,
	)
	if err != nil {
		return Config{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return Config{}, err
		}
		values[key] = value
	}
	secret, err := crypto.Decrypt(values["microsoft_client_secret"])
	if err != nil {
		return Config{}, fmt.Errorf("decrypt Microsoft client secret: %w", err)
	}
	return Config{
		ClientID:     strings.TrimSpace(values["microsoft_client_id"]),
		ClientSecret: strings.TrimSpace(secret),
	}, rows.Err()
}

func IsMicrosoftDomain(domain string) bool {
	switch strings.ToLower(strings.TrimSpace(domain)) {
	case "outlook.com", "hotmail.com", "live.com", "msn.com":
		return true
	default:
		return false
	}
}

func IsMicrosoftHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	return host == "outlook.office365.com" ||
		host == "smtp-mail.outlook.com" ||
		strings.HasSuffix(host, ".protection.outlook.com")
}

func StartDeviceAuthorization(ctx context.Context, email string) (DeviceAuthorization, error) {
	cfg, err := LoadConfig()
	if err != nil {
		return DeviceAuthorization{}, err
	}
	if cfg.ClientID == "" || cfg.ClientSecret == "" {
		return DeviceAuthorization{}, errors.New("Microsoft OAuth is not configured in Settings > Accounts")
	}

	var response struct {
		DeviceCode       string `json:"device_code"`
		UserCode         string `json:"user_code"`
		VerificationURI  string `json:"verification_uri"`
		Message          string `json:"message"`
		ExpiresIn        int    `json:"expires_in"`
		Interval         int    `json:"interval"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	status, err := postFormStatus(ctx, deviceCodeEndpoint, url.Values{
		"client_id": {cfg.ClientID},
		"scope":     {scopes},
	}, &response)
	if err != nil {
		return DeviceAuthorization{}, err
	}
	if response.Error != "" {
		description := strings.TrimSpace(response.ErrorDescription)
		if description == "" {
			description = response.Error
		}
		return DeviceAuthorization{}, fmt.Errorf("Microsoft OAuth %s: %s", response.Error, description)
	}
	if status < 200 || status >= 300 {
		return DeviceAuthorization{}, fmt.Errorf("Microsoft OAuth endpoint returned HTTP %d", status)
	}
	if response.DeviceCode == "" || response.UserCode == "" {
		return DeviceAuthorization{}, errors.New("Microsoft returned an incomplete device authorization")
	}
	if response.Interval < 5 {
		response.Interval = 5
	}
	flowID, err := randomID()
	if err != nil {
		return DeviceAuthorization{}, err
	}
	flowStore.Lock()
	removeExpiredFlowsLocked(time.Now())
	flowStore.flows[flowID] = &pendingFlow{
		Email:      strings.ToLower(strings.TrimSpace(email)),
		DeviceCode: response.DeviceCode,
		ExpiresAt:  time.Now().Add(time.Duration(response.ExpiresIn) * time.Second),
		Interval:   response.Interval,
	}
	flowStore.Unlock()

	return DeviceAuthorization{
		FlowID:          flowID,
		UserCode:        response.UserCode,
		VerificationURI: response.VerificationURI,
		Message:         response.Message,
		ExpiresIn:       response.ExpiresIn,
		Interval:        response.Interval,
	}, nil
}

func PollDeviceAuthorization(ctx context.Context, flowID string) (PollResult, error) {
	flowStore.Lock()
	flow := flowStore.flows[flowID]
	if flow == nil {
		flowStore.Unlock()
		return PollResult{}, errors.New("Microsoft authorization session was not found")
	}
	if flow.Tokens != nil {
		flowStore.Unlock()
		return PollResult{Status: "authorized"}, nil
	}
	if time.Now().After(flow.ExpiresAt) {
		delete(flowStore.flows, flowID)
		flowStore.Unlock()
		return PollResult{}, errors.New("Microsoft authorization code expired")
	}
	if wait := time.Until(flow.LastPollAt.Add(time.Duration(flow.Interval) * time.Second)); !flow.LastPollAt.IsZero() && wait > 0 {
		interval := flow.Interval
		flowStore.Unlock()
		return PollResult{Status: "pending", Interval: interval}, nil
	}
	flow.LastPollAt = time.Now()
	deviceCode := flow.DeviceCode
	interval := flow.Interval
	flowStore.Unlock()

	cfg, err := LoadConfig()
	if err != nil {
		return PollResult{}, err
	}
	tokens, oauthErr, err := requestTokens(ctx, url.Values{
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"client_id":   {cfg.ClientID},
		"device_code": {deviceCode},
	})
	if err != nil {
		return PollResult{}, err
	}
	if oauthErr != "" {
		switch oauthErr {
		case "authorization_pending":
			return PollResult{Status: "pending", Interval: interval}, nil
		case "slow_down":
			flowStore.Lock()
			if current := flowStore.flows[flowID]; current != nil {
				current.Interval += 5
				interval = current.Interval
			}
			flowStore.Unlock()
			return PollResult{Status: "pending", Interval: interval}, nil
		case "authorization_declined":
			return PollResult{}, errors.New("Microsoft authorization was declined")
		case "expired_token":
			return PollResult{}, errors.New("Microsoft authorization code expired")
		default:
			return PollResult{}, fmt.Errorf("Microsoft authorization failed: %s", oauthErr)
		}
	}
	if tokens.RefreshToken == "" {
		return PollResult{}, errors.New("Microsoft did not issue a refresh token; verify offline_access permission and authorize again")
	}

	flowStore.Lock()
	if current := flowStore.flows[flowID]; current != nil {
		current.Tokens = &tokens
	}
	flowStore.Unlock()
	return PollResult{Status: "authorized"}, nil
}

func ConsumeAuthorizedFlow(flowID, email string) (accessEncrypted, refreshEncrypted string, expiresAt time.Time, err error) {
	flowStore.Lock()
	flow := flowStore.flows[flowID]
	if flow == nil || flow.Tokens == nil {
		flowStore.Unlock()
		return "", "", time.Time{}, errors.New("Microsoft authorization is not complete")
	}
	if !strings.EqualFold(flow.Email, strings.TrimSpace(email)) {
		flowStore.Unlock()
		return "", "", time.Time{}, errors.New("Microsoft authorization email does not match the account")
	}
	tokens := *flow.Tokens
	flowStore.Unlock()

	accessEncrypted, err = crypto.Encrypt(tokens.AccessToken)
	if err != nil {
		return "", "", time.Time{}, err
	}
	refreshEncrypted, err = crypto.Encrypt(tokens.RefreshToken)
	if err != nil {
		return "", "", time.Time{}, err
	}
	return accessEncrypted, refreshEncrypted, tokens.ExpiresAt, nil
}

func ForgetFlow(flowID string) {
	flowStore.Lock()
	delete(flowStore.flows, flowID)
	flowStore.Unlock()
}

func AuthorizedCredentials(flowID string) (email, accessToken string, ok bool) {
	flowStore.Lock()
	defer flowStore.Unlock()
	flow := flowStore.flows[flowID]
	if flow == nil || flow.Tokens == nil {
		return "", "", false
	}
	return flow.Email, flow.Tokens.AccessToken, true
}

// AccessTokenForAccount returns a valid access token, refreshing and
// atomically persisting it when it is close to expiry.
func AccessTokenForAccount(ctx context.Context, accountID int64) (string, error) {
	refreshMu.Lock()
	defer refreshMu.Unlock()

	var accessStored, refreshStored string
	var expiresAt sql.NullTime
	if err := database.DB.QueryRow(
		`SELECT COALESCE(oauth_token, ''), COALESCE(oauth_refresh_token, ''), oauth_expires_at
		 FROM accounts WHERE id = ?`, accountID,
	).Scan(&accessStored, &refreshStored, &expiresAt); err != nil {
		return "", err
	}
	access, err := crypto.Decrypt(accessStored)
	if err != nil {
		return "", err
	}
	if access != "" && expiresAt.Valid && time.Until(expiresAt.Time) > 2*time.Minute {
		return access, nil
	}
	refresh, err := crypto.Decrypt(refreshStored)
	if err != nil {
		return "", err
	}
	if refresh == "" {
		return "", errors.New("Microsoft refresh token is missing; reconnect the account")
	}
	cfg, err := LoadConfig()
	if err != nil {
		return "", err
	}
	tokens, oauthErr, err := requestTokens(ctx, url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {cfg.ClientID},
		"refresh_token": {refresh},
		"scope":         {scopes},
	})
	if err != nil {
		return "", err
	}
	if oauthErr != "" {
		return "", fmt.Errorf("Microsoft token refresh failed: %s", oauthErr)
	}
	if tokens.RefreshToken == "" {
		tokens.RefreshToken = refresh
	}
	encAccess, err := crypto.Encrypt(tokens.AccessToken)
	if err != nil {
		return "", err
	}
	encRefresh, err := crypto.Encrypt(tokens.RefreshToken)
	if err != nil {
		return "", err
	}
	if _, err := database.DB.Exec(
		`UPDATE accounts SET oauth_token=?, oauth_refresh_token=?, oauth_expires_at=? WHERE id=?`,
		encAccess, encRefresh, tokens.ExpiresAt, accountID,
	); err != nil {
		return "", err
	}
	return tokens.AccessToken, nil
}

func requestTokens(ctx context.Context, values url.Values) (tokenSet, string, error) {
	var response struct {
		AccessToken      string `json:"access_token"`
		RefreshToken     string `json:"refresh_token"`
		ExpiresIn        int    `json:"expires_in"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	status, err := postFormStatus(ctx, tokenEndpoint, values, &response)
	if err != nil {
		return tokenSet{}, "", err
	}
	if response.Error != "" {
		return tokenSet{}, response.Error, nil
	}
	if status < 200 || status >= 300 || response.AccessToken == "" {
		return tokenSet{}, "", fmt.Errorf("Microsoft token endpoint returned HTTP %d", status)
	}
	if response.ExpiresIn <= 0 {
		response.ExpiresIn = 3600
	}
	return tokenSet{
		AccessToken:  response.AccessToken,
		RefreshToken: response.RefreshToken,
		ExpiresAt:    time.Now().Add(time.Duration(response.ExpiresIn) * time.Second),
	}, "", nil
}

func postFormStatus(ctx context.Context, endpoint string, values url.Values, target interface{}) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return resp.StatusCode, fmt.Errorf("decode Microsoft OAuth response: %w", err)
	}
	return resp.StatusCode, nil
}

func randomID() (string, error) {
	value := make([]byte, 24)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func removeExpiredFlowsLocked(now time.Time) {
	for id, flow := range flowStore.flows {
		if now.After(flow.ExpiresAt) {
			delete(flowStore.flows, id)
		}
	}
}
