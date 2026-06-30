package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"time"

	"mailgo/internal/database"

	"github.com/redis/go-redis/v9"
)

const (
	loginFailureWindow = time.Minute
	loginSubnetBan     = 5 * time.Minute
	loginFailureLimit  = 5
)

var errLoginProtectionUnavailable = errors.New("login protection is unavailable")

type loginRateLimiter interface {
	RetryAfter(ctx context.Context, ip string) (time.Duration, error)
	RecordFailure(ctx context.Context, ip string) (loginFailureResult, error)
	ClearFailures(ctx context.Context, ip string) error
}

type loginFailureResult struct {
	Failures int
	BanFor   time.Duration
}

type redisLoginRateLimiter struct{}

var recordLoginFailureScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
if count >= tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  redis.call('DEL', KEYS[1])
  return {count, tonumber(ARGV[3])}
end
return {count, 0}
`)

func (redisLoginRateLimiter) RetryAfter(ctx context.Context, ip string) (time.Duration, error) {
	if database.RDB == nil {
		return 0, errLoginProtectionUnavailable
	}
	ttl, err := database.RDB.PTTL(ctx, loginSubnetBlockKey(ip)).Result()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("%w: %v", errLoginProtectionUnavailable, err)
	}
	if ttl <= 0 {
		return 0, nil
	}
	return ttl, nil
}

func (redisLoginRateLimiter) RecordFailure(ctx context.Context, ip string) (loginFailureResult, error) {
	if database.RDB == nil {
		return loginFailureResult{}, errLoginProtectionUnavailable
	}
	values, err := recordLoginFailureScript.Run(
		ctx,
		database.RDB,
		[]string{loginFailureKey(ip), loginSubnetBlockKey(ip)},
		loginFailureWindow.Milliseconds(),
		loginFailureLimit,
		loginSubnetBan.Milliseconds(),
	).Slice()
	if err != nil {
		return loginFailureResult{}, fmt.Errorf("%w: %v", errLoginProtectionUnavailable, err)
	}
	if len(values) != 2 {
		return loginFailureResult{}, fmt.Errorf("%w: invalid Redis script response", errLoginProtectionUnavailable)
	}
	failures, okFailures := values[0].(int64)
	banMilliseconds, okBan := values[1].(int64)
	if !okFailures || !okBan {
		return loginFailureResult{}, fmt.Errorf("%w: invalid Redis script values", errLoginProtectionUnavailable)
	}
	return loginFailureResult{
		Failures: int(failures),
		BanFor:   time.Duration(banMilliseconds) * time.Millisecond,
	}, nil
}

func (redisLoginRateLimiter) ClearFailures(ctx context.Context, ip string) error {
	if database.RDB == nil {
		return errLoginProtectionUnavailable
	}
	if err := database.RDB.Del(ctx, loginFailureKey(ip)).Err(); err != nil {
		return fmt.Errorf("%w: %v", errLoginProtectionUnavailable, err)
	}
	return nil
}

func loginFailureKey(ip string) string {
	return "mailgo:auth:fail:" + stableKey(ip)
}

func loginSubnetBlockKey(ip string) string {
	return "mailgo:auth:block:" + stableKey(ipSubnet(ip))
}

func stableKey(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func ipSubnet(value string) string {
	ip := net.ParseIP(value)
	if ip == nil {
		return value
	}
	if ipv4 := ip.To4(); ipv4 != nil {
		return ipv4.Mask(net.CIDRMask(24, 32)).String() + "/24"
	}
	ipv6 := ip.To16()
	if ipv6 == nil {
		return value
	}
	return ipv6.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
