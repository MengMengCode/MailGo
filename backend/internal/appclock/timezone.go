package appclock

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"mailgo/internal/database"
)

const SettingKey = "app_timezone"

func ServerTimezone() string {
	if name := strings.TrimSpace(time.Local.String()); name != "" && name != "Local" {
		return name
	}
	if raw, err := os.ReadFile("/etc/timezone"); err == nil {
		if name := strings.TrimSpace(string(raw)); name != "" {
			if _, err := time.LoadLocation(name); err == nil {
				return name
			}
		}
	}
	return "UTC"
}

func CurrentTimezone() string {
	if database.DB == nil {
		return ServerTimezone()
	}
	var value string
	err := database.DB.QueryRow(
		"SELECT setting_value FROM settings WHERE setting_key = ?",
		SettingKey,
	).Scan(&value)
	if err != nil && err != sql.ErrNoRows {
		log.Printf("appclock: read timezone setting: %v", err)
	}
	value = strings.TrimSpace(value)
	if value == "" || value == "server" {
		return ServerTimezone()
	}
	if _, err := time.LoadLocation(value); err != nil {
		log.Printf("appclock: invalid timezone %q, using server timezone: %v", value, err)
		return ServerTimezone()
	}
	return value
}

func CurrentLocation() *time.Location {
	name := CurrentTimezone()
	loc, err := time.LoadLocation(name)
	if err == nil {
		return loc
	}
	return time.Local
}

func StartOfDayDaysAgo(days int) time.Time {
	loc := CurrentLocation()
	now := time.Now().In(loc)
	return time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc).AddDate(0, 0, -days)
}

func ValidateTimezone(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" || value == "server" {
		return true
	}
	_, err := time.LoadLocation(value)
	return err == nil
}

func FormatOffset(offsetSeconds int) string {
	sign := "+"
	if offsetSeconds < 0 {
		sign = "-"
		offsetSeconds = -offsetSeconds
	}
	return fmt.Sprintf("UTC%s%02d:%02d", sign, offsetSeconds/3600, (offsetSeconds%3600)/60)
}
