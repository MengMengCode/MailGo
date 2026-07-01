import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const TIMEZONE_KEY = "mailgo-timezone";

/** Combine class names with tailwind-merge for safe overrides. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function getAppTimeZone(): string | undefined {
  try {
    const value = localStorage.getItem(TIMEZONE_KEY);
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function setAppTimeZone(value: string): void {
  try {
    if (value) localStorage.setItem(TIMEZONE_KEY, value);
    else localStorage.removeItem(TIMEZONE_KEY);
    window.dispatchEvent(new CustomEvent("mailgo:timezone-change"));
  } catch {
    /* ignore */
  }
}

function dateParts(date: Date, timeZone?: string) {
  const parts = new Intl.DateTimeFormat(undefined, {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Format a date string as a relative short label. */
export function formatDate(dateStr: string | number | Date): string {
  const d = new Date(dateStr);
  const now = new Date();
  const timeZone = getAppTimeZone();
  const current = dateParts(now, timeZone);
  const target = dateParts(d, timeZone);
  const sameYear = target.year === current.year;
  const isToday =
    target.year === current.year &&
    target.month === current.month &&
    target.day === current.day;

  if (isToday) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone });
  }

  if (sameYear) {
    return d.toLocaleDateString([], { month: "short", day: "numeric", timeZone });
  }
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric", timeZone });
}

/** Format a date with full date + time. */
export function formatDateTime(dateStr: string | number | Date): string {
  const d = new Date(dateStr);
  const timeZone = getAppTimeZone();
  return d.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

/** Truncate a string with ellipsis. */
export function truncate(str: string, len: number): string {
  if (!str) return "";
  if (str.length <= len) return str;
  return str.slice(0, len) + "…";
}

/** Get initials from a name. */
export function getInitials(name: string): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Format file size in human-readable form. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Try to JSON-parse a value with a fallback. */
export function safeJSON<T = unknown>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Parse a comma/semicolon separated string into a list of email addresses. */
export function parseAddressList(input: string | undefined | null): string[] {
  if (!input) return [];
  return input
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sleep helper. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a stable color from a string (account color hashing). */
export function colorFromString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 48%)`;
}
