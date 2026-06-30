package imap

import (
	"strings"
	"testing"
)

// TestExtractPartsQPInMultipart reproduces the issue where a reply message
// contains a quoted-printable encoded original message inside its body.
// The top-level body must be decoded, and any embedded QP sequences that are
// literally part of the text content (not encoding markers) should be left
// as-is or handled gracefully.
func TestExtractPartsQPInMultipart(t *testing.T) {
	// A reply message: text/plain part with Content-Transfer-Encoding:
	// quoted-printable. The body contains "好的" (decoded from QP) followed
	// by a quoted original message that itself contains raw QP bytes.
	raw := `From: admin@cli.cd
To: admin@cli.cd
Subject: =?utf-8?B?UmU6IOS4i+S4quW8gOWFpeaooeWei+Wtl+WFpeWPuw==?=
Date: Sun, 28 Jun 2026 23:46:00 +0800
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable
MIME-Version: 1.0

=E5=A5=BD=E7=9A=84

On 2026=E5=B9=B4 6=E6=9C=88 9=E6=97=A5, admin@cli.cd wrote:
=E4=BA=B2=E7=88=B1=E7=9A=84=E7=94=A8=E6=88=B7, =E8=BF=99=E6=98=AF=E4=B8=80=E5=B0=81=E8=B4=A6=E6=88=B7 'admin@cli.cd' =E9=85=8D=E7=BD=AE=E4=BF=A1=E6=81=AF=E7=9A=84=E6=B5=8B=E8=AF=95=E9=82=AE=E4=BB=B6.
`

	text, html, atts := extractParts(raw)
	if len(atts) != 0 {
		t.Errorf("expected no attachments, got %d", len(atts))
	}
	if html != "" {
		t.Errorf("expected no html, got %q", html)
	}
	if !strings.Contains(text, "好的") {
		t.Errorf("expected decoded '好的' in text, got %q", text)
	}
	// The quoted original message should be decoded too, not left as
	// =E4=BA=B2=E7=88=B1... gibberish.
	if strings.Contains(text, "=E4=BA=B2") {
		t.Errorf("text still contains undecoded QP sequences: %q", text)
	}
	if !strings.Contains(text, "亲爱的用户") {
		t.Errorf("expected decoded '亲爱的用户' in text, got %q", text)
	}
}

// TestExtractPartsNonMultipartQP ensures a simple non-multipart QP message
// is fully decoded.
func TestExtractPartsNonMultipartQP(t *testing.T) {
	raw := `From: admin@cli.cd
To: admin@cli.cd
Subject: Test
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable
MIME-Version: 1.0

=E4=BA=B2=E7=88=B1=E7=9A=84=E7=94=A8=E6=88=B7, =E8=BF=99=E6=98=AF=E6=B5=8B=E8=AF=95=E9=82=AE=E4=BB=B6
`
	text, _, _ := extractParts(raw)
	if !strings.Contains(text, "亲爱的用户") {
		t.Errorf("expected decoded text, got %q", text)
	}
	if strings.Contains(text, "=E4=BA=B2") {
		t.Errorf("text contains undecoded QP: %q", text)
	}
}
