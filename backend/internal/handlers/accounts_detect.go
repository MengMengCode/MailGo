package handlers

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/xml"
	"fmt"
	"io"
	"mailgo/internal/microsoftauth"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// KnownProviders maps email domains to their standard IMAP/SMTP settings.
// Detection still probes the sockets before treating a config as ready.
var KnownProviders = map[string]ProviderConfig{
	"gmail.com":      newProvider("imap.gmail.com", 993, "smtp.gmail.com", 587),
	"googlemail.com": newProvider("imap.gmail.com", 993, "smtp.gmail.com", 587),
	"outlook.com":    newProvider("outlook.office365.com", 993, "smtp-mail.outlook.com", 587),
	"hotmail.com":    newProvider("outlook.office365.com", 993, "smtp-mail.outlook.com", 587),
	"live.com":       newProvider("outlook.office365.com", 993, "smtp-mail.outlook.com", 587),
	"msn.com":        newProvider("outlook.office365.com", 993, "smtp-mail.outlook.com", 587),
	"yahoo.com":      newProvider("imap.mail.yahoo.com", 993, "smtp.mail.yahoo.com", 587),
	"yahoo.co.jp":    newProvider("imap.mail.yahoo.co.jp", 993, "smtp.mail.yahoo.co.jp", 587),
	"icloud.com":     newProvider("imap.mail.me.com", 993, "smtp.mail.me.com", 587),
	"me.com":         newProvider("imap.mail.me.com", 993, "smtp.mail.me.com", 587),
	"mac.com":        newProvider("imap.mail.me.com", 993, "smtp.mail.me.com", 587),
	"qq.com":         newProvider("imap.qq.com", 993, "smtp.qq.com", 465),
	"foxmail.com":    newProvider("imap.qq.com", 993, "smtp.qq.com", 465),
	"163.com":        newProvider("imap.163.com", 993, "smtp.163.com", 465),
	"126.com":        newProvider("imap.126.com", 993, "smtp.126.com", 465),
	"yeah.net":       newProvider("imap.yeah.net", 993, "smtp.yeah.net", 465),
	"sina.com":       newProvider("imap.sina.com", 993, "smtp.sina.com", 465),
	"sina.cn":        newProvider("imap.sina.cn", 993, "smtp.sina.cn", 465),
	"aliyun.com":     newProvider("imap.aliyun.com", 993, "smtp.aliyun.com", 465),
	"zoho.com":       newProvider("imap.zoho.com", 993, "smtp.zoho.com", 587),
	"protonmail.com": {ImapHost: "127.0.0.1", ImapPort: 1143, ImapTLS: false, SmtpHost: "127.0.0.1", SmtpPort: 1025, SmtpTLS: false},
	"proton.me":      {ImapHost: "127.0.0.1", ImapPort: 1143, ImapTLS: false, SmtpHost: "127.0.0.1", SmtpPort: 1025, SmtpTLS: false},
	"fastmail.com":   newProvider("imap.fastmail.com", 993, "smtp.fastmail.com", 587),
	"gmx.com":        newProvider("imap.gmx.com", 993, "mail.gmx.com", 587),
	"gmx.net":        newProvider("imap.gmx.net", 993, "mail.gmx.net", 587),
	"web.de":         newProvider("imap.web.de", 993, "smtp.web.de", 587),
	"mail.ru":        newProvider("imap.mail.ru", 993, "smtp.mail.ru", 465),
	"yandex.com":     newProvider("imap.yandex.com", 993, "smtp.yandex.com", 465),
	"yandex.ru":      newProvider("imap.yandex.ru", 993, "smtp.yandex.ru", 465),
}

type ProviderConfig struct {
	ImapHost       string `json:"imap_host"`
	ImapPort       int    `json:"imap_port"`
	ImapTLS        bool   `json:"imap_tls"`
	ImapEncryption string `json:"imap_encryption"`
	SmtpHost       string `json:"smtp_host"`
	SmtpPort       int    `json:"smtp_port"`
	SmtpTLS        bool   `json:"smtp_tls"`
	SmtpEncryption string `json:"smtp_encryption"`
}

type DetectRequest struct {
	Email string `json:"email"`
}

type DetectResponse struct {
	Found           bool           `json:"found"`
	Method          string         `json:"method"` // provider | mx | autoconfig | autodiscover | srv | guess | none
	Provider        ProviderConfig `json:"provider"`
	MXRecords       []string       `json:"mx_records"`
	ImapOK          bool           `json:"imap_ok"`
	SmtpOK          bool           `json:"smtp_ok"`
	ErrorMessage    string         `json:"error_message,omitempty"`
	AuthType        string         `json:"auth_type,omitempty"`
	OAuthConfigured bool           `json:"oauth_configured"`
}

// DetectAccount looks up known provider settings, inspects MX records, then
// probes common IMAP/SMTP host names. It only marks a config as found when
// both sockets are reachable, so the next step can safely ask for a password.
func DetectAccount(w http.ResponseWriter, r *http.Request) {
	var req DetectRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	email := strings.TrimSpace(req.Email)
	if !strings.Contains(email, "@") {
		respondError(w, http.StatusBadRequest, "Invalid email address")
		return
	}
	domain := strings.ToLower(strings.SplitN(email, "@", 2)[1])

	resp := DetectResponse{
		Method:    "none",
		Provider:  newProvider("imap."+domain, 993, "smtp."+domain, 587),
		MXRecords: []string{},
	}
	if microsoftauth.IsMicrosoftDomain(domain) {
		resp.AuthType = "microsoft_oauth"
		resp.OAuthConfigured = microsoftauth.Configured()
	}
	// Backfill the legacy boolean from the encryption mode for the
	// initial guess (downstream code may read either field).
	resp.Provider.ImapTLS = resp.Provider.ImapEncryption != "none"
	resp.Provider.SmtpTLS = resp.Provider.SmtpEncryption != "none"

	candidates := make([]detectCandidate, 0, 16)
	if cfg, ok := KnownProviders[domain]; ok {
		candidates = append(candidates, detectCandidate{method: "provider", provider: cfg})
		resp.Provider = cfg
	}

	mxHosts := make([]string, 0)
	mxs, err := net.LookupMX(domain)
	if err == nil {
		for _, mx := range mxs {
			host := strings.TrimSuffix(mx.Host, ".")
			mxHosts = append(mxHosts, host)
			resp.MXRecords = append(resp.MXRecords, host)
			if cfg, ok := providerFromMX(host); ok {
				candidates = append(candidates, detectCandidate{method: "mx", provider: cfg})
			}
		}
	}

	candidates = dedupeCandidates(candidates)
	if selected, probe, _ := probeCandidates(candidates); selected != nil && probe.OK {
		resp.Found = true
		resp.Method = selected.method
		resp.Provider = selected.provider
		resp.ImapOK = true
		resp.SmtpOK = true
		markMicrosoftDetection(&resp, domain)
		respondJSON(w, http.StatusOK, resp)
		return
	}

	candidates = append(candidates, autoconfigCandidates(email, domain)...)
	candidates = append(candidates, autodiscoverCandidates(email, domain)...)
	candidates = append(candidates, srvCandidates(domain)...)
	candidates = append(candidates, mxDerivedCandidates(domain, mxHosts)...)
	candidates = append(candidates, guessCandidates(domain)...)
	candidates = dedupeCandidates(candidates)
	if len(candidates) > 0 && resp.Provider.ImapHost == "" {
		resp.Provider = candidates[0].provider
	}

	selected, probe, probeErrors := probeCandidates(candidates)
	if selected != nil && probe.OK {
		resp.Found = true
		resp.Method = selected.method
		resp.Provider = selected.provider
		resp.ImapOK = true
		resp.SmtpOK = true
		markMicrosoftDetection(&resp, domain)
		respondJSON(w, http.StatusOK, resp)
		return
	}
	if len(candidates) > 0 {
		resp.Provider = candidates[0].provider
	}

	resp.ErrorMessage = "Could not reach the default IMAP/SMTP servers."
	if len(probeErrors) > 0 {
		resp.ErrorMessage = probeErrors[0]
	}
	respondJSON(w, http.StatusOK, resp)
}

func markMicrosoftDetection(resp *DetectResponse, domain string) {
	if microsoftauth.IsMicrosoftDomain(domain) ||
		microsoftauth.IsMicrosoftHost(resp.Provider.ImapHost) ||
		microsoftauth.IsMicrosoftHost(resp.Provider.SmtpHost) {
		resp.AuthType = "microsoft_oauth"
		resp.OAuthConfigured = microsoftauth.Configured()
	}
}

type ProbeRequest struct {
	ImapHost       string `json:"imap_host"`
	ImapPort       int    `json:"imap_port"`
	ImapTLS        bool   `json:"imap_tls"`
	ImapEncryption string `json:"imap_encryption"`
	SmtpHost       string `json:"smtp_host"`
	SmtpPort       int    `json:"smtp_port"`
	SmtpTLS        bool   `json:"smtp_tls"`
	SmtpEncryption string `json:"smtp_encryption"`
}

type ProbeResponse struct {
	OK           bool   `json:"ok"`
	ImapOK       bool   `json:"imap_ok"`
	SmtpOK       bool   `json:"smtp_ok"`
	ErrorMessage string `json:"error_message,omitempty"`
}

func ProbeAccount(w http.ResponseWriter, r *http.Request) {
	var req ProbeRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.ImapHost == "" || req.SmtpHost == "" {
		respondError(w, http.StatusBadRequest, "imap_host and smtp_host are required")
		return
	}
	// SSRF protection: block connections to private/loopback IPs.
	if isPrivateHost(req.ImapHost) || isPrivateHost(req.SmtpHost) {
		respondError(w, http.StatusBadRequest, "Connections to private/local addresses are not allowed")
		return
	}
	if req.ImapPort == 0 {
		req.ImapPort = 993
	}
	if req.SmtpPort == 0 {
		req.SmtpPort = 587
	}
	// Normalize encryption from the request, falling back to the legacy
	// boolean when the encryption field is empty.
	imapEnc := normalizeEncryption(req.ImapEncryption, req.ImapPort)
	smtpEnc := normalizeEncryption(req.SmtpEncryption, req.SmtpPort)
	if req.ImapEncryption == "" {
		if req.ImapTLS {
			if req.ImapPort == 993 {
				imapEnc = "ssl"
			} else {
				imapEnc = "starttls"
			}
		} else {
			imapEnc = "none"
		}
	}
	if req.SmtpEncryption == "" {
		if req.SmtpTLS {
			if req.SmtpPort == 465 {
				smtpEnc = "ssl"
			} else {
				smtpEnc = "starttls"
			}
		} else {
			smtpEnc = "none"
		}
	}
	respondJSON(w, http.StatusOK, probeProvider(ProviderConfig{
		ImapHost:       req.ImapHost,
		ImapPort:       req.ImapPort,
		ImapTLS:        imapEnc != "none",
		ImapEncryption: imapEnc,
		SmtpHost:       req.SmtpHost,
		SmtpPort:       req.SmtpPort,
		SmtpTLS:        smtpEnc != "none",
		SmtpEncryption: smtpEnc,
	}))
}

type VerifyRequest struct {
	ImapHost       string `json:"imap_host"`
	ImapPort       int    `json:"imap_port"`
	ImapTLS        bool   `json:"imap_tls"`
	ImapEncryption string `json:"imap_encryption"`
	SmtpHost       string `json:"smtp_host"`
	SmtpPort       int    `json:"smtp_port"`
	SmtpTLS        bool   `json:"smtp_tls"`
	SmtpEncryption string `json:"smtp_encryption"`
	Username       string `json:"username"`
	Password       string `json:"password"`
}

type VerifyResponse struct {
	OK           bool   `json:"ok"`
	ImapOK       bool   `json:"imap_ok"`
	SmtpOK       bool   `json:"smtp_ok"`
	ErrorMessage string `json:"error_message,omitempty"`
}

type detectCandidate struct {
	method   string
	provider ProviderConfig
}

func newProvider(imapHost string, imapPort int, smtpHost string, smtpPort int) ProviderConfig {
	imapEnc := "starttls"
	if imapPort == 993 {
		imapEnc = "ssl"
	}
	smtpEnc := "starttls"
	if smtpPort == 465 {
		smtpEnc = "ssl"
	}
	return ProviderConfig{
		ImapHost:       imapHost,
		ImapPort:       imapPort,
		ImapTLS:        true,
		ImapEncryption: imapEnc,
		SmtpHost:       smtpHost,
		SmtpPort:       smtpPort,
		SmtpTLS:        true,
		SmtpEncryption: smtpEnc,
	}
}

func providerFromMX(host string) (ProviderConfig, bool) {
	h := strings.ToLower(host)
	switch {
	case strings.Contains(h, "google.com") || strings.Contains(h, "googlemail.com") || strings.Contains(h, "aspmx.l.google.com"):
		return KnownProviders["gmail.com"], true
	case strings.Contains(h, "outlook.com") || strings.Contains(h, "hotmail.com") || strings.Contains(h, "protection.outlook.com") || strings.Contains(h, "mail.protection.outlook.com"):
		return KnownProviders["outlook.com"], true
	case strings.Contains(h, "yahoodns.net") || strings.Contains(h, "yahoo.com"):
		return KnownProviders["yahoo.com"], true
	case strings.Contains(h, "qq.com"):
		return KnownProviders["qq.com"], true
	case strings.Contains(h, "163.com"):
		return KnownProviders["163.com"], true
	case strings.Contains(h, "126.com"):
		return KnownProviders["126.com"], true
	case strings.Contains(h, "icloud.com") || strings.Contains(h, "me.com"):
		return KnownProviders["icloud.com"], true
	case strings.Contains(h, "zoho."):
		return KnownProviders["zoho.com"], true
	case strings.Contains(h, "fastmail."):
		return KnownProviders["fastmail.com"], true
	case strings.Contains(h, "yandex."):
		return KnownProviders["yandex.com"], true
	case strings.Contains(h, "mail.ru"):
		return KnownProviders["mail.ru"], true
	case strings.Contains(h, "gmx."):
		return KnownProviders["gmx.com"], true
	case strings.Contains(h, "web.de"):
		return KnownProviders["web.de"], true
	case strings.Contains(h, "mxrouting.net"):
		return ProviderConfig{
			ImapHost: host,
			ImapPort: 993,
			ImapTLS:  true,
			SmtpHost: host,
			SmtpPort: 465,
			SmtpTLS:  true,
		}, true
	}
	return ProviderConfig{}, false
}

func autoconfigCandidates(email, domain string) []detectCandidate {
	endpoints := []string{
		"https://autoconfig." + domain + "/mail/config-v1.1.xml?emailaddress=" + url.QueryEscape(email),
		"https://" + domain + "/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=" + url.QueryEscape(email),
		"http://autoconfig." + domain + "/mail/config-v1.1.xml?emailaddress=" + url.QueryEscape(email),
	}
	out := make([]detectCandidate, 0, len(endpoints))
	for _, endpoint := range endpoints {
		body, err := fetchDiscoveryXML(endpoint, "", "")
		if err != nil {
			continue
		}
		if cfg, ok := parseMozillaAutoconfig(body); ok {
			out = append(out, detectCandidate{method: "autoconfig", provider: cfg})
		}
	}
	return out
}

func autodiscoverCandidates(email, domain string) []detectCandidate {
	endpoints := []string{
		"https://autodiscover." + domain + "/autodiscover/autodiscover.xml",
		"https://" + domain + "/autodiscover/autodiscover.xml",
	}
	reqBody := `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>` + xmlEscape(email) + `</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`
	out := make([]detectCandidate, 0, len(endpoints))
	for _, endpoint := range endpoints {
		body, err := fetchDiscoveryXML(endpoint, "text/xml", reqBody)
		if err != nil {
			continue
		}
		if cfg, ok := parseOutlookAutodiscover(body); ok {
			out = append(out, detectCandidate{method: "autodiscover", provider: cfg})
		}
	}
	return out
}

func srvCandidates(domain string) []detectCandidate {
	imapTargets := lookupSRVTargets("imaps", "tcp", domain, 993, true)
	if len(imapTargets) == 0 {
		imapTargets = append(imapTargets, lookupSRVTargets("imap", "tcp", domain, 143, false)...)
	}
	smtpTargets := lookupSRVTargets("submission", "tcp", domain, 587, true)
	smtpTargets = append(smtpTargets, lookupSRVTargets("submissions", "tcp", domain, 465, true)...)
	if len(smtpTargets) == 0 {
		smtpTargets = append(smtpTargets, lookupSRVTargets("smtp", "tcp", domain, 587, true)...)
	}

	out := make([]detectCandidate, 0)
	for _, imap := range imapTargets {
		for _, smtp := range smtpTargets {
			out = append(out, detectCandidate{
				method: "srv",
				provider: ProviderConfig{
					ImapHost: imap.host,
					ImapPort: imap.port,
					ImapTLS:  imap.tls,
					SmtpHost: smtp.host,
					SmtpPort: smtp.port,
					SmtpTLS:  smtp.tls,
				},
			})
		}
	}
	return out
}

func mxDerivedCandidates(domain string, mxHosts []string) []detectCandidate {
	out := make([]detectCandidate, 0)
	for _, mx := range mxHosts {
		out = append(out,
			detectCandidate{method: "mx", provider: ProviderConfig{ImapHost: mx, ImapPort: 993, ImapTLS: true, SmtpHost: mx, SmtpPort: 465, SmtpTLS: true}},
			detectCandidate{method: "mx", provider: ProviderConfig{ImapHost: mx, ImapPort: 993, ImapTLS: true, SmtpHost: mx, SmtpPort: 587, SmtpTLS: true}},
		)
		base := mailDomainFromMX(domain, mx)
		if base == "" {
			continue
		}
		out = append(out,
			detectCandidate{method: "mx", provider: newProvider("imap."+base, 993, "smtp."+base, 587)},
			detectCandidate{method: "mx", provider: newProvider("mail."+base, 993, "mail."+base, 587)},
			detectCandidate{method: "mx", provider: newProvider("imap."+base, 993, "smtp."+base, 465)},
			detectCandidate{method: "mx", provider: newProvider("mail."+base, 993, "mail."+base, 465)},
		)
	}
	return out
}

func guessCandidates(domain string) []detectCandidate {
	return []detectCandidate{
		{method: "guess", provider: newProvider("imap."+domain, 993, "smtp."+domain, 587)},
		{method: "guess", provider: newProvider("imap."+domain, 993, "smtp."+domain, 465)},
		{method: "guess", provider: newProvider("mail."+domain, 993, "mail."+domain, 587)},
		{method: "guess", provider: newProvider("mail."+domain, 993, "mail."+domain, 465)},
	}
}

func dedupeCandidates(in []detectCandidate) []detectCandidate {
	seen := map[string]bool{}
	out := make([]detectCandidate, 0, len(in))
	for _, c := range in {
		key := fmt.Sprintf("%s:%d:%t|%s:%d:%t",
			c.provider.ImapHost, c.provider.ImapPort, c.provider.ImapTLS,
			c.provider.SmtpHost, c.provider.SmtpPort, c.provider.SmtpTLS,
		)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, c)
	}
	return out
}

type srvTarget struct {
	host string
	port int
	tls  bool
}

type candidateProbeResult struct {
	index int
	probe ProbeResponse
}

func lookupSRVTargets(service, proto, domain string, fallbackPort int, useTLS bool) []srvTarget {
	_, records, err := net.LookupSRV(service, proto, domain)
	if err != nil {
		return nil
	}
	out := make([]srvTarget, 0, len(records))
	for _, record := range records {
		host := strings.TrimSuffix(record.Target, ".")
		port := int(record.Port)
		if port == 0 {
			port = fallbackPort
		}
		out = append(out, srvTarget{host: host, port: port, tls: useTLS})
	}
	return out
}

func fetchDiscoveryXML(endpoint, contentType, body string) ([]byte, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	var req *http.Request
	var err error
	if body == "" {
		req, err = http.NewRequest(http.MethodGet, endpoint, nil)
	} else {
		req, err = http.NewRequest(http.MethodPost, endpoint, strings.NewReader(body))
	}
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "MailGo/0.2")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("discovery returned HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 512*1024))
}

type mozillaClientConfig struct {
	EmailProvider struct {
		Incoming []mozillaServer `xml:"incomingServer"`
		Outgoing []mozillaServer `xml:"outgoingServer"`
	} `xml:"emailProvider"`
}

type mozillaServer struct {
	Type       string `xml:"type,attr"`
	Hostname   string `xml:"hostname"`
	Port       int    `xml:"port"`
	SocketType string `xml:"socketType"`
}

func parseMozillaAutoconfig(body []byte) (ProviderConfig, bool) {
	var cfg mozillaClientConfig
	if err := xml.Unmarshal(body, &cfg); err != nil {
		return ProviderConfig{}, false
	}
	var imap, smtp mozillaServer
	for _, incoming := range cfg.EmailProvider.Incoming {
		if strings.EqualFold(incoming.Type, "imap") && incoming.Hostname != "" {
			imap = incoming
			break
		}
	}
	for _, outgoing := range cfg.EmailProvider.Outgoing {
		if strings.EqualFold(outgoing.Type, "smtp") && outgoing.Hostname != "" {
			smtp = outgoing
			break
		}
	}
	if imap.Hostname == "" || smtp.Hostname == "" {
		return ProviderConfig{}, false
	}
	if imap.Port == 0 {
		imap.Port = 993
	}
	if smtp.Port == 0 {
		smtp.Port = 587
	}
	return ProviderConfig{
		ImapHost:       strings.TrimSpace(imap.Hostname),
		ImapPort:       imap.Port,
		ImapTLS:        socketTypeUsesTLS(imap.SocketType, imap.Port),
		ImapEncryption: socketTypeToEncryption(imap.SocketType, imap.Port),
		SmtpHost:       strings.TrimSpace(smtp.Hostname),
		SmtpPort:       smtp.Port,
		SmtpTLS:        socketTypeUsesTLS(smtp.SocketType, smtp.Port),
		SmtpEncryption: socketTypeToEncryption(smtp.SocketType, smtp.Port),
	}, true
}

type autodiscoverEnvelope struct {
	Protocols []autodiscoverProtocol `xml:"Response>Account>Protocol"`
}

type autodiscoverProtocol struct {
	Type   string `xml:"Type"`
	Server string `xml:"Server"`
	Port   int    `xml:"Port"`
	SSL    string `xml:"SSL"`
}

func parseOutlookAutodiscover(body []byte) (ProviderConfig, bool) {
	var envelope autodiscoverEnvelope
	if err := xml.Unmarshal(body, &envelope); err != nil {
		return ProviderConfig{}, false
	}
	var imap, smtp autodiscoverProtocol
	for _, p := range envelope.Protocols {
		switch strings.ToUpper(strings.TrimSpace(p.Type)) {
		case "IMAP":
			if p.Server != "" {
				imap = p
			}
		case "SMTP":
			if p.Server != "" {
				smtp = p
			}
		}
	}
	if imap.Server == "" || smtp.Server == "" {
		return ProviderConfig{}, false
	}
	if imap.Port == 0 {
		imap.Port = 993
	}
	if smtp.Port == 0 {
		smtp.Port = 587
	}
	return ProviderConfig{
		ImapHost:       strings.TrimSpace(imap.Server),
		ImapPort:       imap.Port,
		ImapTLS:        autodiscoverUsesTLS(imap.SSL, imap.Port),
		ImapEncryption: autodiscoverToEncryption(imap.SSL, imap.Port),
		SmtpHost:       strings.TrimSpace(smtp.Server),
		SmtpPort:       smtp.Port,
		SmtpTLS:        autodiscoverUsesTLS(smtp.SSL, smtp.Port),
		SmtpEncryption: autodiscoverToEncryption(smtp.SSL, smtp.Port),
	}, true
}

func socketTypeUsesTLS(socketType string, port int) bool {
	socketType = strings.ToUpper(strings.TrimSpace(socketType))
	return socketType == "SSL" || socketType == "STARTTLS" || port == 993 || port == 465 || port == 587
}

// socketTypeToEncryption maps an autoconfig socketType to our encryption
// enum: "SSL" → "ssl", "STARTTLS" → "starttls", everything else → inferred
// from the port.
func socketTypeToEncryption(socketType string, port int) string {
	socketType = strings.ToUpper(strings.TrimSpace(socketType))
	switch socketType {
	case "SSL":
		return "ssl"
	case "STARTTLS":
		return "starttls"
	case "PLAIN", "NONE":
		return "none"
	}
	if port == 993 || port == 465 || port == 995 {
		return "ssl"
	}
	return "starttls"
}

func autodiscoverUsesTLS(value string, port int) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	return value == "on" || value == "true" || value == "1" || port == 993 || port == 465 || port == 587
}

// autodiscoverToEncryption maps an autodiscover SSL flag to our encryption
// enum.
func autodiscoverToEncryption(value string, port int) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "on" || value == "true" || value == "1" {
		if port == 993 || port == 465 || port == 995 {
			return "ssl"
		}
		return "starttls"
	}
	if value == "off" || value == "false" || value == "0" {
		return "none"
	}
	// Unknown — infer from port
	if port == 993 || port == 465 || port == 995 {
		return "ssl"
	}
	return "starttls"
}

func mailDomainFromMX(emailDomain, mxHost string) string {
	host := strings.ToLower(strings.TrimSuffix(mxHost, "."))
	if host == "" {
		return ""
	}
	if strings.HasSuffix(host, "."+emailDomain) || host == emailDomain {
		return emailDomain
	}
	parts := strings.Split(host, ".")
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		p := strings.Trim(part, "-")
		if p == "" || p == "mx" || p == "mail" || p == "smtp" || p == "imap" || strings.HasPrefix(p, "mx") {
			continue
		}
		filtered = append(filtered, p)
	}
	if len(filtered) >= 2 {
		return strings.Join(filtered[len(filtered)-2:], ".")
	}
	return emailDomain
}

func xmlEscape(value string) string {
	var out strings.Builder
	_ = xml.EscapeText(&out, []byte(value))
	return out.String()
}

func probeProvider(cfg ProviderConfig) ProbeResponse {
	resp := ProbeResponse{}
	var errs []string
	imapEnc := cfg.ImapEncryption
	if imapEnc == "" {
		if cfg.ImapTLS || cfg.ImapPort == 993 {
			imapEnc = "ssl"
		} else {
			imapEnc = "starttls"
		}
	}
	smtpEnc := cfg.SmtpEncryption
	if smtpEnc == "" {
		if cfg.SmtpTLS && cfg.SmtpPort == 465 {
			smtpEnc = "ssl"
		} else if cfg.SmtpTLS {
			smtpEnc = "starttls"
		} else {
			smtpEnc = "none"
		}
	}
	if err := probeIMAP(cfg.ImapHost, cfg.ImapPort, imapEnc); err != nil {
		errs = append(errs, "IMAP: "+err.Error())
	} else {
		resp.ImapOK = true
	}
	if err := probeSMTP(cfg.SmtpHost, cfg.SmtpPort, smtpEnc); err != nil {
		errs = append(errs, "SMTP: "+err.Error())
	} else {
		resp.SmtpOK = true
	}
	resp.OK = resp.ImapOK && resp.SmtpOK
	if !resp.OK {
		resp.ErrorMessage = strings.Join(errs, "; ")
	}
	return resp
}

func probeCandidates(candidates []detectCandidate) (*detectCandidate, ProbeResponse, []string) {
	if len(candidates) == 0 {
		return nil, ProbeResponse{}, nil
	}

	results := make([]ProbeResponse, len(candidates))
	resolved := make([]bool, len(candidates))
	resultCh := make(chan candidateProbeResult, len(candidates))
	sem := make(chan struct{}, 6)
	for i, candidate := range candidates {
		i, candidate := i, candidate
		go func() {
			sem <- struct{}{}
			result := probeProvider(candidate.provider)
			<-sem
			resultCh <- candidateProbeResult{index: i, probe: result}
		}()
	}

	errors := make([]string, 0)
	bestOK := -1
	for received := 0; received < len(candidates); received++ {
		result := <-resultCh
		results[result.index] = result.probe
		resolved[result.index] = true
		if result.probe.ErrorMessage != "" {
			errors = append(errors, result.probe.ErrorMessage)
		}
		if result.probe.OK && (bestOK == -1 || result.index < bestOK) {
			bestOK = result.index
		}
		if bestOK >= 0 {
			allHigherPriorityDone := true
			for i := 0; i < bestOK; i++ {
				if !resolved[i] {
					allHigherPriorityDone = false
					break
				}
			}
			if allHigherPriorityDone {
				return &candidates[bestOK], results[bestOK], errors
			}
		}
	}
	return nil, ProbeResponse{}, errors
}

func probeIMAP(host string, port int, encryption string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	dialer := &net.Dialer{Timeout: 5 * time.Second}

	var conn net.Conn
	var err error
	if encryption == "ssl" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		})
	} else {
		// starttls or none — start with a plain connection
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("cannot connect: %w", err)
	}
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(6 * time.Second))
	greeting, err := readLine(conn)
	if err != nil {
		return fmt.Errorf("no greeting: %w", err)
	}
	if !strings.Contains(strings.ToUpper(greeting), "OK") {
		return fmt.Errorf("server not ready: %s", firstLine(greeting))
	}
	return nil
}

func probeSMTP(host string, port int, encryption string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	dialer := &net.Dialer{Timeout: 5 * time.Second}

	var conn net.Conn
	var err error
	if encryption == "ssl" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("cannot connect: %w", err)
	}
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(6 * time.Second))
	greeting, err := readLine(conn)
	if err != nil {
		return fmt.Errorf("no greeting: %w", err)
	}
	if !strings.HasPrefix(greeting, "220") {
		return fmt.Errorf("server not ready: %s", firstLine(greeting))
	}
	// For STARTTLS we verify the server advertises it.
	if encryption == "starttls" {
		if _, err := conn.Write([]byte("EHLO mailgo.local\r\n")); err != nil {
			return fmt.Errorf("EHLO failed: %w", err)
		}
		ehloResp, err := readSMTPResponse(conn)
		if err != nil {
			return fmt.Errorf("EHLO response: %w", err)
		}
		if !strings.Contains(strings.ToUpper(ehloResp), "STARTTLS") {
			return fmt.Errorf("STARTTLS is not advertised")
		}
	}
	return nil
}

// VerifyAccount tests IMAP + SMTP connectivity and credentials by speaking
// the raw protocols over a TLS or plain connection. This avoids pulling in
// a third-party IMAP/SMTP library while still doing a real login check.
func VerifyAccount(w http.ResponseWriter, r *http.Request) {
	var req VerifyRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.ImapHost == "" || req.SmtpHost == "" || req.Username == "" {
		respondError(w, http.StatusBadRequest, "imap_host, smtp_host and username are required")
		return
	}
	if req.ImapPort == 0 {
		req.ImapPort = 993
	}
	if req.SmtpPort == 0 {
		req.SmtpPort = 587
	}
	// Normalize encryption from the request.
	imapEnc := normalizeEncryption(req.ImapEncryption, req.ImapPort)
	smtpEnc := normalizeEncryption(req.SmtpEncryption, req.SmtpPort)
	if req.ImapEncryption == "" {
		if req.ImapTLS {
			if req.ImapPort == 993 {
				imapEnc = "ssl"
			} else {
				imapEnc = "starttls"
			}
		} else {
			imapEnc = "none"
		}
	}
	if req.SmtpEncryption == "" {
		if req.SmtpTLS {
			if req.SmtpPort == 465 {
				smtpEnc = "ssl"
			} else {
				smtpEnc = "starttls"
			}
		} else {
			smtpEnc = "none"
		}
	}

	resp := VerifyResponse{}
	var errs []string

	if err := verifyIMAP(req.ImapHost, req.ImapPort, imapEnc, req.Username, req.Password); err != nil {
		errs = append(errs, "IMAP: "+err.Error())
	} else {
		resp.ImapOK = true
	}

	if err := verifySMTP(req.SmtpHost, req.SmtpPort, smtpEnc, req.Username, req.Password); err != nil {
		errs = append(errs, "SMTP: "+err.Error())
	} else {
		resp.SmtpOK = true
	}

	resp.OK = resp.ImapOK && resp.SmtpOK
	if !resp.OK {
		resp.ErrorMessage = strings.Join(errs, "; ")
	}
	respondJSON(w, http.StatusOK, resp)
}

// verifyIMAP connects to the IMAP server, reads the greeting, sends a LOGIN
// command, and checks the response. Uses implicit TLS for "ssl", STARTTLS
// for "starttls", or plain for "none".
func verifyIMAP(host string, port int, encryption string, username, password string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	dialer := &net.Dialer{Timeout: 10 * time.Second}

	var conn net.Conn
	var err error
	if encryption == "ssl" {
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("cannot connect: %w", err)
	}
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(15 * time.Second))

	// For STARTTLS, upgrade the plain connection before sending credentials.
	if encryption == "starttls" {
		// Read greeting
		greeting, err := readLine(conn)
		if err != nil {
			return fmt.Errorf("no greeting: %w", err)
		}
		if !strings.Contains(greeting, "OK") {
			return fmt.Errorf("server not ready: %s", greeting)
		}
		// Send STARTTLS
		if _, err := conn.Write([]byte("A0 STARTTLS\r\n")); err != nil {
			return fmt.Errorf("STARTTLS write: %w", err)
		}
		startResp, err := readUntilTag(conn, "A0")
		if err != nil {
			return fmt.Errorf("STARTTLS response: %w", err)
		}
		if !strings.Contains(startResp, "A0 OK") {
			return fmt.Errorf("STARTTLS rejected: %s", firstLine(startResp))
		}
		// Upgrade to TLS
		tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err := tlsConn.Handshake(); err != nil {
			return fmt.Errorf("TLS handshake: %w", err)
		}
		conn = tlsConn
	}

	// Read server greeting (* OK ...)
	greeting, err := readLine(conn)
	if err != nil {
		return fmt.Errorf("no greeting: %w", err)
	}
	if !strings.Contains(greeting, "OK") {
		return fmt.Errorf("server not ready: %s", greeting)
	}

	// Send LOGIN
	cmd := fmt.Sprintf("A1 LOGIN %s %s\r\n", escapeIMAP(username), escapeIMAP(password))
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return fmt.Errorf("login write failed: %w", err)
	}

	// Read response — may be single or multi-line
	resp, err := readUntilTag(conn, "A1")
	if err != nil {
		return fmt.Errorf("login read failed: %w", err)
	}
	if strings.Contains(resp, "A1 OK") {
		return nil
	}
	return fmt.Errorf("login rejected: %s", firstLine(resp))
}

// verifySMTP connects to the SMTP server, issues EHLO, and attempts AUTH
// LOGIN with base64-encoded credentials. Supports implicit TLS ("ssl"),
// STARTTLS ("starttls"), and plain ("none").
func verifySMTP(host string, port int, encryption string, username, password string) error {
	addr := fmt.Sprintf("%s:%d", host, port)
	dialer := &net.Dialer{Timeout: 10 * time.Second}

	var conn net.Conn
	var err error
	if encryption == "ssl" {
		// Implicit TLS (common for Chinese providers like QQ/163, port 465)
		conn, err = tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		})
	} else {
		conn, err = dialer.Dial("tcp", addr)
	}
	if err != nil {
		return fmt.Errorf("cannot connect: %w", err)
	}
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(15 * time.Second))

	// Read greeting (220 ...)
	greeting, err := readLine(conn)
	if err != nil {
		return fmt.Errorf("no greeting: %w", err)
	}
	if !strings.HasPrefix(greeting, "220") {
		return fmt.Errorf("server not ready: %s", greeting)
	}

	// EHLO
	if _, err := conn.Write([]byte("EHLO mailgo.local\r\n")); err != nil {
		return fmt.Errorf("EHLO failed: %w", err)
	}
	// Read multi-line EHLO response (ends with 250 code without '-')
	ehloResp, err := readSMTPResponse(conn)
	if err != nil {
		return fmt.Errorf("EHLO response: %w", err)
	}

	// If STARTTLS is requested and advertised, upgrade the connection.
	if encryption == "starttls" && strings.Contains(ehloResp, "STARTTLS") {
		if _, err := conn.Write([]byte("STARTTLS\r\n")); err != nil {
			return fmt.Errorf("STARTTLS write: %w", err)
		}
		startResp, err := readLine(conn)
		if err != nil || !strings.HasPrefix(startResp, "220") {
			return fmt.Errorf("STARTTLS rejected: %s", startResp)
		}
		tlsConn := tls.Client(conn, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
		if err := tlsConn.Handshake(); err != nil {
			return fmt.Errorf("TLS handshake: %w", err)
		}
		conn = tlsConn
		// Re-EHLO over TLS
		if _, err := conn.Write([]byte("EHLO mailgo.local\r\n")); err != nil {
			return fmt.Errorf("EHLO over TLS: %w", err)
		}
		readSMTPResponse(conn)
	}

	// AUTH LOGIN
	if _, err := conn.Write([]byte("AUTH LOGIN\r\n")); err != nil {
		return fmt.Errorf("AUTH LOGIN write: %w", err)
	}
	prompt, err := readLine(conn)
	if err != nil || !strings.HasPrefix(prompt, "334") {
		return fmt.Errorf("AUTH LOGIN rejected: %s", prompt)
	}

	// Send base64 username
	userB64 := base64.StdEncoding.EncodeToString([]byte(username))
	if _, err := conn.Write([]byte(userB64 + "\r\n")); err != nil {
		return fmt.Errorf("username write: %w", err)
	}
	prompt2, err := readLine(conn)
	if err != nil || !strings.HasPrefix(prompt2, "334") {
		return fmt.Errorf("username rejected: %s", prompt2)
	}

	// Send base64 password
	passB64 := base64.StdEncoding.EncodeToString([]byte(password))
	if _, err := conn.Write([]byte(passB64 + "\r\n")); err != nil {
		return fmt.Errorf("password write: %w", err)
	}
	authResp, err := readLine(conn)
	if err != nil {
		return fmt.Errorf("auth response: %w", err)
	}
	if strings.HasPrefix(authResp, "235") {
		return nil // success
	}
	return fmt.Errorf("auth rejected: %s", authResp)
}

// --- low-level helpers ---

func readLine(conn net.Conn) (string, error) {
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 1)
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			return string(buf), err
		}
		if n > 0 {
			buf = append(buf, tmp[0])
			if tmp[0] == '\n' {
				return string(buf), nil
			}
		}
	}
}

func readUntilTag(conn net.Conn, tag string) (string, error) {
	var result strings.Builder
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 1)
	for {
		n, err := conn.Read(tmp)
		if err != nil {
			return result.String(), err
		}
		if n > 0 {
			buf = append(buf, tmp[0])
			if tmp[0] == '\n' {
				line := string(buf)
				result.WriteString(line)
				if strings.HasPrefix(strings.TrimSpace(line), tag+" ") {
					return result.String(), nil
				}
				buf = buf[:0]
			}
		}
	}
}

func readSMTPResponse(conn net.Conn) (string, error) {
	var result strings.Builder
	for {
		line, err := readLine(conn)
		if err != nil {
			return result.String(), err
		}
		result.WriteString(line)
		// SMTP multi-line: "250-..." continues, "250 ..." ends
		if len(line) >= 4 && line[3] == ' ' {
			return result.String(), nil
		}
	}
}

func firstLine(s string) string {
	if idx := strings.Index(s, "\r\n"); idx >= 0 {
		return s[:idx]
	}
	return s
}

func escapeIMAP(s string) string {
	// IMAP atoms with special chars need double-quoting
	if strings.ContainsAny(s, " \"\\{") {
		return "\"" + strings.ReplaceAll(s, "\"", "\\\"") + "\""
	}
	return s
}

// isPrivateHost returns true if the hostname resolves to a private, loopback,
// or link-local IP address. Used for SSRF protection on outbound connections.
func isPrivateHost(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	// Try parsing as literal IP first.
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
	}
	// Resolve DNS and check all results.
	ips, err := net.LookupIP(host)
	if err != nil {
		// If DNS fails, block the connection to be safe.
		return true
	}
	for _, ip := range ips {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return true
		}
	}
	return false
}
