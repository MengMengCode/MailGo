import type { Account } from "./api";

export interface AccountColorInfo {
  id: number | string;
  email: string;
  color: string;
  label: string;
}

export function assignAccountColors(
  accounts: Account[],
): Map<number, string> {
  const map = new Map<number, string>();
  accounts.forEach((acc) => {
    if (acc.id && acc.tag_color) {
      map.set(acc.id, acc.tag_color);
    }
  });
  return map;
}

export function getAccountColor(
  account: Account | undefined,
): string | undefined {
  return account?.tag_color || undefined;
}

export function getAccountLabel(
  account: Account | undefined,
  fallbackId?: number | string,
): string {
  if (account?.email) return account.email;
  if (account?.name) return account.name;
  return `Account ${fallbackId ?? ""}`.trim();
}

/** Two-letter initials used inside the avatar circle. */
export function getAccountInitials(
  name?: string,
  email?: string,
): string {
  const src = (name && name.trim()) || (email && email.split("@")[0]) || "";
  if (!src) return "?";
  const parts = src.split(/\s+|[\.\-_]/).filter(Boolean);
  if (parts.length === 0) return src.slice(0, 2).toUpperCase();
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
