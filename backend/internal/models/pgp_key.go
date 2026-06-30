package models

import "time"

type PGPKey struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	PublicKey  string    `json:"public_key"`
	PrivateKey string    `json:"private_key,omitempty"`
	CreatedAt  time.Time `json:"created_at"`
}
