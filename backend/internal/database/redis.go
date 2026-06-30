package database

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

var RDB *redis.Client

func InitializeRedis() error {
	host := os.Getenv("REDIS_HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("REDIS_PORT")
	if port == "" {
		port = "6379"
	}
	password := os.Getenv("REDIS_PASSWORD")
	db := 0
	if v := os.Getenv("REDIS_DB"); v != "" {
		fmt.Sscanf(v, "%d", &db)
	}

	RDB = redis.NewClient(&redis.Options{
		Addr:         host + ":" + port,
		Password:     password,
		DB:           db,
		DialTimeout:  5 * time.Second,
		ReadTimeout:  3 * time.Second,
		WriteTimeout: 3 * time.Second,
		PoolSize:     10,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := RDB.Ping(ctx).Err(); err != nil {
		log.Printf("Redis connection failed (non-fatal, caching disabled): %v", err)
		RDB = nil
		return nil // Redis is optional — don't block startup.
	}
	log.Printf("Redis connected at %s:%s", host, port)
	return nil
}

// CacheGet retrieves a cached value. Returns (value, true) on hit.
func CacheGet(key string) (string, bool) {
	if RDB == nil {
		return "", false
	}
	ctx := context.Background()
	val, err := RDB.Get(ctx, key).Result()
	if err != nil {
		return "", false
	}
	return val, true
}

// CacheSet stores a value with a TTL.
func CacheSet(key string, value interface{}, ttl time.Duration) {
	if RDB == nil {
		return
	}
	ctx := context.Background()
	RDB.Set(ctx, key, value, ttl)
}

// CacheDelete removes a cached key.
func CacheDelete(key string) {
	if RDB == nil {
		return
	}
	ctx := context.Background()
	RDB.Del(ctx, key)
}

// ── Sync progress helpers ──────────────────────────────────────────

// syncProgressKey returns the Redis key for an account's sync progress.
func syncProgressKey(accountID int64) string {
	return fmt.Sprintf("mailgo:sync:%d", accountID)
}

// SyncProgressSet sets a single field in the account's sync progress hash.
func SyncProgressSet(accountID int64, field string, value interface{}) {
	if RDB == nil {
		return
	}
	ctx := context.Background()
	key := syncProgressKey(accountID)
	RDB.HSet(ctx, key, field, value)
	RDB.Expire(ctx, key, 24*time.Hour)
}

// SyncProgressSetMulti sets multiple fields at once.
func SyncProgressSetMulti(accountID int64, fields map[string]interface{}) {
	if RDB == nil || len(fields) == 0 {
		return
	}
	ctx := context.Background()
	key := syncProgressKey(accountID)
	RDB.HSet(ctx, key, fields)
	RDB.Expire(ctx, key, 24*time.Hour)
}

// SyncProgressGetAll returns all fields of the sync progress hash.
func SyncProgressGetAll(accountID int64) map[string]string {
	if RDB == nil {
		return nil
	}
	ctx := context.Background()
	val, err := RDB.HGetAll(ctx, syncProgressKey(accountID)).Result()
	if err != nil || len(val) == 0 {
		return nil
	}
	return val
}

// SyncProgressClear removes the sync progress key for an account.
func SyncProgressClear(accountID int64) {
	if RDB == nil {
		return
	}
	ctx := context.Background()
	RDB.Del(ctx, syncProgressKey(accountID))
}

// SyncProgressResetStale scans all sync progress keys and resets any
// that are stuck in "syncing" status (e.g. from a server crash) to
// "idle". Called once at startup.
func SyncProgressResetStale() {
	if RDB == nil {
		return
	}
	ctx := context.Background()
	iter := RDB.Scan(ctx, 0, "mailgo:sync:*", 100).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		status, err := RDB.HGet(ctx, key, "status").Result()
		if err != nil {
			continue
		}
		if status == "syncing" {
			RDB.HSet(ctx, key, "status", "idle", "error", "interrupted by server restart")
			log.Printf("Redis: reset stale sync progress for %s", key)
		}
	}
	if err := iter.Err(); err != nil {
		log.Printf("Redis: scan sync keys error: %v", err)
	}
}

// SyncProgressListAll returns sync progress for all accounts that have
// a progress entry in Redis.
func SyncProgressListAll() []map[string]string {
	if RDB == nil {
		return nil
	}
	ctx := context.Background()
	var results []map[string]string
	iter := RDB.Scan(ctx, 0, "mailgo:sync:*", 100).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		val, err := RDB.HGetAll(ctx, key).Result()
		if err != nil || len(val) == 0 {
			continue
		}
		// Inject account_id parsed from key "mailgo:sync:{id}".
		var aid string
		if n, _ := fmt.Sscanf(key, "mailgo:sync:%s", &aid); n == 1 {
			val["_account_id"] = aid
		}
		results = append(results, val)
	}
	return results
}
