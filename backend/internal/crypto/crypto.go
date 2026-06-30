package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
)

const encPrefix = "enc:v1:"

var key []byte

// Init initializes the encryption key from the given string.
// The key is accepted as hex (64 chars), base64 (44 chars), or any
// arbitrary string that is hashed with SHA-256 to derive a 32-byte key.
func Init(keyStr string) error {
	if keyStr == "" {
		return fmt.Errorf("ENCRYPTION_KEY is empty")
	}

	// Try hex decode first (64 hex chars = 32 bytes).
	if len(keyStr) == 64 {
		if b, err := hex.DecodeString(keyStr); err == nil && len(b) == 32 {
			key = b
			return nil
		}
	}

	// Try base64 decode (standard or URL encoding).
	if b, err := base64.StdEncoding.DecodeString(keyStr); err == nil && len(b) == 32 {
		key = b
		return nil
	}
	if b, err := base64.URLEncoding.DecodeString(keyStr); err == nil && len(b) == 32 {
		key = b
		return nil
	}

	// Fall back: SHA-256 hash of the raw input to derive a 32-byte key.
	h := sha256.Sum256([]byte(keyStr))
	key = h[:]
	return nil
}

// Encrypt encrypts plaintext using AES-256-GCM and returns an encoded string
// prefixed with "enc:v1:".
func Encrypt(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	if key == nil {
		return "", fmt.Errorf("encryption key not initialized")
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes.NewCipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher.NewGCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return encPrefix + base64.StdEncoding.EncodeToString(ciphertext), nil
}

// Decrypt decrypts a value that was encrypted with Encrypt.
// If the value does not have the "enc:v1:" prefix it is returned as-is
// (legacy plaintext fallback).
func Decrypt(encoded string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	if !strings.HasPrefix(encoded, encPrefix) {
		// Legacy plaintext — return verbatim.
		return encoded, nil
	}
	if key == nil {
		return "", fmt.Errorf("encryption key not initialized")
	}

	raw, err := base64.StdEncoding.DecodeString(encoded[len(encPrefix):])
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("aes.NewCipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("cipher.NewGCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := raw[:nonceSize], raw[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("gcm.Open: %w", err)
	}
	return string(plaintext), nil
}

// IsEncrypted returns true if the value has the "enc:v1:" prefix.
func IsEncrypted(val string) bool {
	return strings.HasPrefix(val, encPrefix)
}
