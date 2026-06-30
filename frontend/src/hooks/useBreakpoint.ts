import { useSyncExternalStore } from "react";

// Breakpoints aligned with Tailwind config:
//   Mobile:  < 640px
//   Tablet:  640px – 1023px
//   Desktop: ≥ 1024px

type Breakpoint = "mobile" | "tablet" | "desktop";

const MOBILE_QUERY = "(max-width: 639px)";
const TABLET_QUERY = "(max-width: 1023px)";

function getSnapshot(): Breakpoint {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia(MOBILE_QUERY).matches) return "mobile";
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet";
  return "desktop";
}

function subscribe(callback: () => void): () => void {
  const mqlMobile = window.matchMedia(MOBILE_QUERY);
  const mqlTablet = window.matchMedia(TABLET_QUERY);
  mqlMobile.addEventListener("change", callback);
  mqlTablet.addEventListener("change", callback);
  return () => {
    mqlMobile.removeEventListener("change", callback);
    mqlTablet.removeEventListener("change", callback);
  };
}

/** Returns the current breakpoint tier: "mobile" | "tablet" | "desktop". */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, getSnapshot, () => "desktop" as Breakpoint);
}

/** Convenience: returns true when viewport < 640px. */
export function useIsMobile(): boolean {
  return useBreakpoint() === "mobile";
}

/** Convenience: returns true when viewport < 1024px. */
export function useIsMobileOrTablet(): boolean {
  return useBreakpoint() !== "desktop";
}
