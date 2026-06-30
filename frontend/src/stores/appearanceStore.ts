import { create } from "zustand";
import { persist } from "zustand/middleware";
import { type AppearanceSettings, DEFAULT_APPEARANCE } from "@/lib/api";

const STORAGE_KEY = "mailgo-appearance";

// Track when local edits are in progress so Layout.tsx can skip backend sync.
let _editingUntil = 0;
export function isAppearanceEditing() {
  return Date.now() < _editingUntil;
}
export function markAppearanceEditing() {
  _editingUntil = Date.now() + 1000; // 1s grace period
}

interface AppearanceState extends AppearanceSettings {
  /** Overwrite one or more fields and re-apply CSS. */
  patch: (partial: Partial<AppearanceSettings>) => void;
  /** Replace the entire state (e.g. from backend sync). */
  replaceAll: (next: AppearanceSettings) => void;
}

export const useAppearanceStore = create<AppearanceState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_APPEARANCE,

      patch: (partial) => {
        set(partial);
        // Defer CSS apply to next microtask so zustand state is updated.
        queueMicrotask(() => applyAppearance(get()));
      },

      replaceAll: (next) => {
        set(next);
        queueMicrotask(() => applyAppearance(get()));
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (s) => {
        const { patch: _, replaceAll: __, ...rest } = s;
        return rest;
      },
    },
  ),
);

/* ── Apply CSS custom properties ─────────────────────────────────────── */

function applyAppearance(s: AppearanceSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const body = document.body;
  const isDark = root.getAttribute("data-theme") === "dark";

  // ── Accent color ──
  const accent = isValidHex(s.accent_color) ? s.accent_color : DEFAULT_APPEARANCE.accent_color;
  const adjustedAccent = adjustSaturation(accent, s.accent_saturation);
  const { r, g, b } = hexToRgb(adjustedAccent);
  root.style.setProperty("--mailgo-accent", adjustedAccent);
  root.style.setProperty("--mailgo-accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty(
    "--mailgo-accent-light",
    lightenHex(adjustedAccent, 0.92),
  );
  root.style.setProperty(
    "--mailgo-accent-focus",
    withAlpha(adjustedAccent, 0.25),
  );

  // ── Background image ──
  // Pick desktop or mobile image based on viewport width.
  const isMobileViewport = typeof window !== "undefined" && window.innerWidth < 640;
  const activeBgImage = isMobileViewport
    ? (s.bg_image_mobile || s.bg_image)
    : (s.bg_image || s.bg_image_mobile);
  if (activeBgImage) {
    body.style.backgroundImage = `url(${activeBgImage})`;
    body.style.backgroundSize = "cover";
    body.style.backgroundPosition = "center";
    body.style.backgroundAttachment = "fixed";
  } else {
    body.style.backgroundImage = "none";
  }

  // ── Surface tinting + transparency ──
  // bg_opacity: 100 = fully opaque (no image visible), 0 = fully transparent
  const surfaceAlpha = s.bg_opacity / 100;
  const hasBgImage = !!activeBgImage;

  if (isDark) {
    const overlay = `rgba(0, 0, 0, ${surfaceAlpha})`;
    const overlayAlt = `rgba(10, 10, 10, ${surfaceAlpha})`;
    root.style.setProperty("--geist-bg-100", overlay);
    root.style.setProperty("--geist-bg-200", overlayAlt);
  } else {
    const tintedBg = tintTowardAccent("#ffffff", adjustedAccent, 0.04);
    const tintedBgAlt = tintTowardAccent("#fafafa", adjustedAccent, 0.06);
    const { r: tr, g: tg, b: tb } = hexToRgb(tintedBg);
    const { r: ar, g: ag, b: ab } = hexToRgb(tintedBgAlt);
    root.style.setProperty("--geist-bg-100", `rgba(${tr}, ${tg}, ${tb}, ${surfaceAlpha})`);
    root.style.setProperty("--geist-bg-200", `rgba(${ar}, ${ag}, ${ab}, ${surfaceAlpha})`);
  }

  // When no background image and full opacity, reset to CSS defaults.
  if (!hasBgImage && s.bg_opacity === 100) {
    root.style.removeProperty("--geist-bg-100");
    root.style.removeProperty("--geist-bg-200");
  }

  // ── Border radius ──
  root.style.setProperty("--geist-radius", `${s.border_radius}px`);
  root.style.setProperty("--geist-radius-sm", `${Math.max(0, s.border_radius - 2)}px`);

  // ── Font size ──
  const fontPx = s.font_size === "sm" ? 13 : s.font_size === "lg" ? 16 : 14;
  root.style.setProperty("--mailgo-font-size", `${fontPx}px`);

  // ── Custom text color ──
  // Uses separate --mailgo-text-* variables so accent (--geist-primary) is
  // NOT affected. Buttons, focus rings, links keep their accent color.
  const rawColor = isDark ? s.text_color_dark : s.text_color_light;
  const customColor = rawColor && isValidHex(rawColor) ? rawColor : "";
  if (customColor) {
    root.style.setProperty("--mailgo-text-primary", customColor);
    root.style.setProperty("--mailgo-text-secondary", mixWithGray(customColor, 0.35));
    root.style.setProperty("--mailgo-text-tertiary", mixWithGray(customColor, 0.55));
  } else {
    root.style.removeProperty("--mailgo-text-primary");
    root.style.removeProperty("--mailgo-text-secondary");
    root.style.removeProperty("--mailgo-text-tertiary");
  }

  // ── Compact mode ──
  root.setAttribute("data-compact", String(s.compact_mode));

  // ── Shadow intensity ──
  root.setAttribute("data-shadow", s.shadow_intensity);

  // ── Animation speed ──
  const speedMap = { off: "0ms", slow: "300ms", normal: "150ms", fast: "80ms" };
  root.style.setProperty("--mailgo-transition", speedMap[s.animation_speed]);

  // ── Sidebar / Titlebar / Statusbar glassmorphism ──
  // All three share the same opacity and blur settings.
  const sidebarAlpha = s.sidebar_opacity / 100;
  const sidebarBase = isDark ? "0, 0, 0" : "255, 255, 255";
  const sidebarBg = `rgba(${sidebarBase}, ${sidebarAlpha})`;
  const sidebarBlur = s.sidebar_blur > 0 ? `blur(${s.sidebar_blur}px)` : "none";
  root.style.setProperty("--mailgo-sidebar-bg", sidebarBg);
  root.style.setProperty("--mailgo-titlebar-bg", sidebarBg);
  root.style.setProperty("--mailgo-statusbar-bg", sidebarBg);
  root.style.setProperty("--mailgo-sidebar-backdrop", sidebarBlur);

  // ── Content panel blur ──
  root.style.setProperty(
    "--mailgo-content-backdrop",
    s.bg_blur > 0 ? `blur(${s.bg_blur}px)` : "none",
  );
}

/* ── Module-level init (call before React renders) ───────────────────── */

export function initAppearanceFromStorage() {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      applyAppearance(DEFAULT_APPEARANCE);
      return;
    }
    const parsed = JSON.parse(raw);
    // zustand wraps state under a "state" key
    const state = parsed?.state ?? parsed;
    applyAppearance({ ...DEFAULT_APPEARANCE, ...state });
  } catch {
    applyAppearance(DEFAULT_APPEARANCE);
  }

  // Re-apply when viewport crosses the mobile/desktop breakpoint so the
  // correct background image (desktop vs mobile) is swapped automatically.
  const mql = window.matchMedia("(max-width: 639px)");
  mql.addEventListener("change", () => {
    applyAppearance(useAppearanceStore.getState());
  });
}

/* ── Sync from backend ───────────────────────────────────────────────── */

export function syncAppearanceFromBackend(appearance: AppearanceSettings) {
  useAppearanceStore.getState().replaceAll(appearance);
}

/* ── Re-apply when theme changes (sidebar bg depends on dark/light) ──── */

export function reapplyAppearanceForTheme() {
  applyAppearance(useAppearanceStore.getState());
}

/* ── Color utilities ─────────────────────────────────────────────────── */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
      : h.padEnd(6, "0");
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

function isValidHex(hex: string): boolean {
  return /^#[0-9a-fA-F]{3,6}$/.test(hex.trim());
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix a hex color toward white by `amount` (0 = unchanged, 1 = white). */
function lightenHex(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `#${lr.toString(16).padStart(2, "0")}${lg.toString(16).padStart(2, "0")}${lb.toString(16).padStart(2, "0")}`;
}

/** Tint a base color slightly toward the accent color. */
function tintTowardAccent(baseHex: string, accentHex: string, amount: number): string {
  const base = hexToRgb(baseHex);
  const accent = hexToRgb(accentHex);
  const tr = Math.round(base.r + (accent.r - base.r) * amount);
  const tg = Math.round(base.g + (accent.g - base.g) * amount);
  const tb = Math.round(base.b + (accent.b - base.b) * amount);
  return `#${tr.toString(16).padStart(2, "0")}${tg.toString(16).padStart(2, "0")}${tb.toString(16).padStart(2, "0")}`;
}

/** Convert hex to HSL. Returns { h: 0-360, s: 0-100, l: 0-100 }. */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let { r, g, b } = hexToRgb(hex);
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Convert HSL back to hex. */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else              { r = c; b = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Adjust the saturation of a hex color. `saturation` is 0-100 (100 = unchanged). */
function adjustSaturation(hex: string, saturation: number): string {
  if (saturation === 100) return hex;
  const hsl = hexToHsl(hex);
  return hslToHex(hsl.h, Math.min(100, Math.max(0, hsl.s * (saturation / 100))), hsl.l);
}

/** Mix a color toward middle gray by `amount` (0 = unchanged, 1 = gray). */
function mixWithGray(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const gray = 128;
  const mr = Math.round(r + (gray - r) * amount);
  const mg = Math.round(g + (gray - g) * amount);
  const mb = Math.round(b + (gray - b) * amount);
  return `#${mr.toString(16).padStart(2, "0")}${mg.toString(16).padStart(2, "0")}${mb.toString(16).padStart(2, "0")}`;
}
