import { useEffect, useState, type CSSProperties } from "react";
import { colorFromString } from "@/lib/utils";
import { getAccountInitials } from "@/lib/accountColors";

export interface AvatarProps {
  /** Sender display name (used for initials + color). */
  name?: string;
  /** Sender email address (used for favicon domain, gravatar hash, initials). */
  email?: string;
  /** Pixel size of the avatar circle. */
  size?: number;
  /** Custom image URL. When provided it takes precedence (e.g. a user-uploaded avatar). */
  src?: string;
  /** Account tag color — used as gradient base for the initials fallback. */
  tagColor?: string;
  className?: string;
  style?: CSSProperties;
}

/* -------------------------------------------------------------------------- *
 * Avatar cache
 *
 * Remote avatar resolution (favicon / gravatar) involves multiple network
 * requests per sender. In a 50-message list that's up to 200 image fetches
 * on every render, which freezes the page. We cache the *resolved* result
 * (either a working image URL or the sentinel "fallback" meaning "use
 * initials") in a module-level Map, persisted to localStorage so it
 * survives reloads.
 *
 * Cache key: `src || domain || email`
 * Cache value: { url: string | null }  — null means "use initials"
 * -------------------------------------------------------------------------- */

interface CacheEntry {
  url: string | null;
  ts: number;
}

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const LS_KEY = "mailgo-avatar-cache";

// In-memory cache — checked first (synchronous, no JSON parse).
const memoryCache = new Map<string, CacheEntry>();

// Hydrate from localStorage once on module load.
try {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
    const now = Date.now();
    let changed = false;
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || now - entry.ts >= CACHE_TTL) continue;
      // Drop entries that were resolved to the Google S2 favicon service —
      // that service always returns a generic placeholder, so those cached
      // URLs are worse than the initials fallback. (The service is no
      // longer probed, but old cache entries may still reference it.)
      if (typeof entry.url === "string" && entry.url.includes("google.com/s2/favicons")) {
        changed = true;
        continue;
      }
      memoryCache.set(key, entry);
    }
    if (changed) setTimeout(persistCache, 0);
  }
} catch {
  /* ignore corrupt cache */
}

// Listen for cache clear events from the Settings page.
window.addEventListener("mailgo:clear-avatar-cache", () => {
  memoryCache.clear();
});

function persistCache() {
  try {
    const obj: Record<string, CacheEntry> = {};
    for (const [key, entry] of memoryCache) {
      obj[key] = entry;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch {
    /* localStorage full or unavailable — ignore */
  }
}

/** Look up a cached avatar result. Returns `null` when not cached. */
function getCached(key: string): CacheEntry | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    memoryCache.delete(key);
    return null;
  }
  return entry;
}

/** Store a resolved avatar URL (or null for "use initials") in the cache. */
function setCached(key: string, url: string | null) {
  memoryCache.set(key, { url, ts: Date.now() });
  // Throttle persistence — writing to localStorage on every resolution
  // would be slow when many avatars resolve at once.
  if (persistTimer === null) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistCache();
    }, 2000);
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Probe a URL and resolve to true if the image actually loads.
 *
 * We use a detached <img> element rather than fetch() because the Image
 * element's onerror fires for genuine 404s / non-image responses, which
 * is exactly what we need to decide whether a favicon exists. A no-cors
 * fetch, by contrast, can't distinguish a real favicon from a 404 HTML
 * page (both produce an opaque response), so it would accept broken
 * URLs as valid avatars.
 */
async function probeImage(url: string, timeoutMs = 5000): Promise<boolean> {
  return probeImageFallback(url, timeoutMs);
}

/** Image-element probe — onload = ok, onerror = fail, with a timeout. */
function probeImageFallback(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      img.onload = null;
      img.onerror = null;
      resolve(ok);
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.referrerPolicy = "no-referrer";
    img.src = url;
    setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Resolve the best avatar URL for a sender. Returns a URL string if a
 * remote image is available, or `null` if the caller should render the
 * initials fallback. Results are cached so each sender is only probed
 * once (ever, until the cache expires).
 *
 * In-flight deduplication: if the same key is already being resolved,
 * the promise is shared so we never probe the same domain twice
 * simultaneously.
 */
// Map of key → in-flight promise, so multiple Avatar components with the
// same domain share a single probe.
const inflight = new Map<string, Promise<string | null>>();

async function resolveAvatar(
  key: string,
  candidates: string[],
): Promise<string | null> {
  // Check cache first — synchronous, no network.
  const cached = getCached(key);
  if (cached) return cached.url;

  // If already resolving this key, share the promise.
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    // Try each candidate URL in order.
    for (const url of candidates) {
      if (await probeImage(url)) {
        setCached(key, url);
        return url;
      }
    }
    // All candidates failed — cache the "fallback" result.
    setCached(key, null);
    return null;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Avatar resolves a sender's avatar the same way eM Client / Gmail do:
 *
 *   1. Explicit `src` (e.g. the user's own account avatar_url) — always wins.
 *   2. Favicon of the sender's email domain — `https://<domain>/favicon.ico`.
 *      This is what makes "Oracle Cloud", "GitHub", "Stripe" … show their
 *      brand icon without anyone having to sign up for anything.
 *   3. Gravatar — `https://gravatar.com/avatar/<md5(email)>`. Only resolves
 *      when the sender registered on Gravatar.
 *   4. Initials color block — the universal fallback.
 *
 * Each remote source is tried in order; on error it falls through to the
 * next, so the user never sees a broken image. Results are cached per
 * sender (keyed on src/domain/email) in localStorage so repeat renders
 * are instant.
 *
 * IMPORTANT: email avatars are *not* part of the email itself. The avatar
 * you set in Settings is only visible to *you*. Other people will see your
 * favicon / Gravatar (if any) on their client — never your local upload.
 */
export function Avatar({ name, email, size = 36, src, tagColor, className, style }: AvatarProps) {
  const domain = email ? email.split("@")[1]?.toLowerCase() ?? "" : "";
  // Build the cache key: prefer src, then domain, then email.
  const cacheKey = src || domain || email || "unknown";

  // Build the ordered list of remote URLs to try. Empty entries are skipped.
  //
  // We intentionally do NOT use Google's S2 favicon service
  // (https://www.google.com/s2/favicons) as a fallback: it always
  // responds 200 with a generic globe/placeholder image for domains
  // that have no real favicon. Because probeImage runs in no-cors mode
  // (opaque responses can't be inspected for status), that placeholder
  // would be accepted as a "working" avatar — so senders without a real
  // favicon would all show the same generic globe instead of their
  // initials. Falling through to the initials block is a better UX.
  const candidates: string[] = [];
  // Custom src always goes first (uploaded avatar), but does NOT prevent
  // favicon / gravatar from being tried as fallbacks when the custom
  // image fails to load.
  if (src) candidates.push(src);
  if (email || domain) {
    const params = new URLSearchParams();
    if (email) params.set("email", email);
    else params.set("domain", domain);
    candidates.push(`/api/v1/avatars/favicon?${params.toString()}`);
  }
  if (email) {
    candidates.push(`/api/v1/avatars/gravatar?email=${encodeURIComponent(email)}`);
  }

  // Synchronous cache check — if we already know the answer, render
  // immediately without any loading state.
  const cached = getCached(cacheKey);

  const [resolvedUrl, setResolvedUrl] = useState<string | null | undefined>(
    cached ? cached.url : undefined, // undefined = "not yet resolved"
  );

  // When the cache key changes (different sender), re-resolve.
  useEffect(() => {
    const entry = getCached(cacheKey);
    if (entry) {
      setResolvedUrl(entry.url);
      return;
    }
    // No cache — resolve asynchronously.
    setResolvedUrl(undefined);
    let cancelled = false;
    void resolveAvatar(cacheKey, candidates).then((url) => {
      if (!cancelled) setResolvedUrl(url);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const initials = getAccountInitials(name, email);
  const initialsBg = tagColor
    ? `linear-gradient(135deg, ${tagColor}, ${lightenHex(tagColor, 0.35)})`
    : colorFromString(email || domain || name || "unknown");

  // Resolved to "use initials" (cached null) — render the fallback block.
  if (resolvedUrl === null) {
    return <InitialsBlock initials={initials} size={size} bgColor={initialsBg} className={className} style={style} />;
  }

  // Have a working image URL (cached or freshly resolved) — render it.
  if (resolvedUrl) {
    return (
      <img
        src={resolvedUrl}
        alt={name || email || ""}
        width={size}
        height={size}
        className={className}
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
          backgroundColor: "var(--geist-gray-100)",
          ...style,
        }}
        referrerPolicy="no-referrer"
      />
    );
  }

  // Not yet resolved and not cached — show initials immediately while
  // the async resolution runs in the background. This avoids a blank
  // circle flash.
  return <InitialsBlock initials={initials} size={size} bgColor={initialsBg} className={className} style={style} />;
}

/** The initials fallback block — colored background, white text. */
function InitialsBlock({
  initials,
  size,
  bgColor,
  className,
  style,
}: {
  initials: string;
  size: number;
  bgColor: string;
  className?: string;
  style?: CSSProperties;
}) {
  const isGradient = bgColor.startsWith("linear-gradient");
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        ...(isGradient
          ? { background: bgColor }
          : { backgroundColor: bgColor }),
        color: "#ffffff",
        fontSize: Math.max(10, Math.floor(size * 0.38)),
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        userSelect: "none",
        ...style,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

/* ----------------------------- tiny MD5 ----------------------------- *
 * Gravatar requires an MD5 hash of the lowercased email. We inline a
 * compact implementation so we don't pull in a dependency for ~30 lines.
 * Based on the public-domain Joseph Myers implementation.
 * ------------------------------------------------------------------- */
function md5(str: string): string {
  function toUtf8(s: string) {
    return unescape(encodeURIComponent(s));
  }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    a = add(add(a, q), add(x, t));
    return add((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn((b&c)|(~b&d),a,b,x,s,t);}
  function gg(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn((b&d)|(c&~d),a,b,x,s,t);}
  function hh(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn(b^c^d,a,b,x,s,t);}
  function ii(a:number,b:number,c:number,d:number,x:number,s:number,t:number){return cmn(c^(b|~d),a,b,x,s,t);}
  function add(x: number, y: number) {
    const l = (x & 0xffff) + (y & 0xffff);
    const m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  function rol(num: number, cnt: number) {
    return (num << cnt) | (num >>> (32 - cnt));
  }

  const input = toUtf8(str);
  const n = input.length;
  const x: number[] = [];
  for (let i = 0; i < n; i++) {
    x[i >> 2] = (x[i >> 2] || 0) | (input.charCodeAt(i) << ((i % 4) * 8));
  }
  x[n >> 2] = (x[n >> 2] || 0) | (0x80 << ((n % 4) * 8));
  x[(((n + 8) >>> 6) + 1) * 16 - 2] = n * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i]!, 7, -680876936);
    d = ff(d, a, b, c, x[i + 1]!, 12, -389564586);
    c = ff(c, d, a, b, x[i + 2]!, 17, 606105819);
    b = ff(b, c, d, a, x[i + 3]!, 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4]!, 7, -176418897);
    d = ff(d, a, b, c, x[i + 5]!, 12, 1200080426);
    c = ff(c, d, a, b, x[i + 6]!, 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7]!, 22, -45705983);
    a = ff(a, b, c, d, x[i + 8]!, 7, 1770035416);
    d = ff(d, a, b, c, x[i + 9]!, 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10]!, 17, -42063);
    b = ff(b, c, d, a, x[i + 11]!, 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12]!, 7, 1804603682);
    d = ff(d, a, b, c, x[i + 13]!, 12, -40341101);
    c = ff(c, d, a, b, x[i + 14]!, 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15]!, 22, 1236535329);
    a = gg(a, b, c, d, x[i + 1]!, 5, -165796510);
    d = gg(d, a, b, c, x[i + 6]!, 9, -1069501632);
    c = gg(c, d, a, b, x[i + 11]!, 14, 643717713);
    b = gg(b, c, d, a, x[i]!, 20, -373897302);
    a = gg(a, b, c, d, x[i + 5]!, 5, -701558691);
    d = gg(d, a, b, c, x[i + 10]!, 9, 38016083);
    c = gg(c, d, a, b, x[i + 15]!, 14, -660478335);
    b = gg(b, c, d, a, x[i + 4]!, 20, -405537848);
    a = gg(a, b, c, d, x[i + 9]!, 5, 568446438);
    d = gg(d, a, b, c, x[i + 14]!, 9, -1019803690);
    c = gg(c, d, a, b, x[i + 3]!, 14, -187363961);
    b = gg(b, c, d, a, x[i + 8]!, 20, 1163531501);
    a = gg(a, b, c, d, x[i + 13]!, 5, -1444681467);
    d = gg(d, a, b, c, x[i + 2]!, 9, -51403784);
    c = gg(c, d, a, b, x[i + 7]!, 14, 1735328473);
    b = gg(b, c, d, a, x[i + 12]!, 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5]!, 4, -378558);
    d = hh(d, a, b, c, x[i + 8]!, 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11]!, 16, 1839030562);
    b = hh(b, c, d, a, x[i + 14]!, 23, -35309556);
    a = hh(a, b, c, d, x[i + 1]!, 4, -1530992060);
    d = hh(d, a, b, c, x[i + 4]!, 11, 1272893353);
    c = hh(c, d, a, b, x[i + 7]!, 16, -155497632);
    b = hh(b, c, d, a, x[i + 10]!, 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13]!, 4, 681279174);
    d = hh(d, a, b, c, x[i]!, 11, -358537222);
    c = hh(c, d, a, b, x[i + 3]!, 16, -722521979);
    b = hh(b, c, d, a, x[i + 6]!, 23, 76029189);
    a = hh(a, b, c, d, x[i + 9]!, 4, -640364487);
    d = hh(d, a, b, c, x[i + 12]!, 11, -421815835);
    c = hh(c, d, a, b, x[i + 15]!, 16, 530742520);
    b = hh(b, c, d, a, x[i + 2]!, 23, -995338651);
    a = ii(a, b, c, d, x[i]!, 6, -198630844);
    d = ii(d, a, b, c, x[i + 7]!, 10, 1126891415);
    c = ii(c, d, a, b, x[i + 14]!, 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5]!, 21, -57434055);
    a = ii(a, b, c, d, x[i + 12]!, 6, 1700485571);
    d = ii(d, a, b, c, x[i + 3]!, 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10]!, 15, -1051523);
    b = ii(b, c, d, a, x[i + 1]!, 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8]!, 6, 1873313359);
    d = ii(d, a, b, c, x[i + 15]!, 10, -30611744);
    c = ii(c, d, a, b, x[i + 6]!, 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13]!, 21, 1309151649);
    a = ii(a, b, c, d, x[i + 4]!, 6, -145523070);
    d = ii(d, a, b, c, x[i + 11]!, 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2]!, 15, 718787259);
    b = ii(b, c, d, a, x[i + 9]!, 21, -343485551);
    a = add(a, oa);
    b = add(b, ob);
    c = add(c, oc);
    d = add(d, od);
  }
  return [a, b, c, d]
    .map((v) => {
      let s = "";
      for (let i = 0; i < 4; i++) {
        s += ((v >> (i * 8)) & 0xff).toString(16).padStart(2, "0");
      }
      return s;
    })
    .join("");
}

/** Lighten a hex color by mixing it with white. `amount` 0–1. */
function lightenHex(hex: string, amount: number): string {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}
