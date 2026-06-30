import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { syncApi, accountsApi, type SyncResult } from "@/lib/api";
import { useSyncStore } from "@/stores/sync.store";

/**
 * useAutoRefresh wires the "auto-refresh mail" feature end-to-end:
 *
 *   1. Reads the latest settings (`auto_refresh_enabled`, `check_interval`)
 *      every time they change.
 *   2. Sets up a setTimeout that calls `syncApi.trigger` on a fixed cadence.
 *   3. Pauses the timer while the network is offline or when the user has
 *      disabled auto-refresh in Settings.
 *   4. Runs an immediate sync on mount when auto-refresh is on, so the user
 *      doesn't have to wait the full interval to see fresh data.
 *   5. Surfaces progress + errors through the sync store so the StatusBar
 *      and InboxView can show "Syncing…" / "Last sync 3m ago" / error toasts.
 *
 * Sync is a single-flight queue backed by the server:
 *   - POST /sync returns 200 (started) or 409 (already running).
 *   - While syncing, we poll GET /sync/status every 2s until syncing=false.
 *   - Background syncs (started by the server loop) are also detected via
 *     the status poll and reflected in the UI automatically.
 */
export interface UseAutoRefreshOptions {
  /** Optional account id to scope the sync to (null = all accounts). */
  accountId?: number | null;
  /** Enable the browser-side polling timer. Default true. */
  enableTimer?: boolean;
}

/** How often to poll /sync/status while a sync is in progress. */
const STATUS_POLL_INTERVAL_MS = 2000;

export function useAutoRefresh(options: UseAutoRefreshOptions = {}) {
  const { accountId = null, enableTimer = true } = options;
  const qc = useQueryClient();
  const phase = useSyncStore((s) => s.phase);

  // Refs let the interval callback read the latest values without having
  // to recreate the timer on every render. We intentionally do *not* put
  // these into the effect dependency list to keep the timer stable.
  const settingsRef = useRef({
    enabled: true,
    intervalSeconds: 300,
  });
  const accountIdRef = useRef<number | null>(accountId);
  const onlineRef = useRef<boolean>(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const statusPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Status polling ──────────────────────────────────────────────────
  // While a sync is active, poll GET /sync/status every 2s. When the
  // backend reports syncing=false, stop polling, refresh queries, and
  // transition the store to idle.
  const startStatusPolling = useCallback(() => {
    if (statusPollRef.current) return; // already polling
    statusPollRef.current = setInterval(async () => {
      try {
        const status = await syncApi.status();

        if (!status.syncing) {
          // Sync finished — stop polling, update store, refresh data.
          stopStatusPolling();
          useSyncStore
            .getState()
            .applyBackendStatus(false, status.last_sync_at ?? "");
          qc.invalidateQueries({ queryKey: ["messages"] });
          qc.invalidateQueries({ queryKey: ["folders"] });
          qc.invalidateQueries({ queryKey: ["accounts"] });
        } else {
          // Still syncing — keep the store in "syncing" state.
          useSyncStore.getState().applyBackendStatus(true, "");

          // Update per-account spinners: remove accounts whose per-account
          // progress shows "completed" (or "failed") so only accounts that
          // are still actively syncing show the spinning indicator.
          try {
            const allProgress = await syncApi.progressAll();
            // Only update if we got actual progress data. An empty array
            // could mean Redis is unavailable — in that case keep the
            // existing syncingAccountIds until the global sync ends.
            if (Array.isArray(allProgress) && allProgress.length > 0) {
              const stillSyncing = new Set(
                allProgress
                  .filter((p) => p.status === "syncing")
                  .map((p) => Number(p._account_id))
                  .filter((id) => Number.isFinite(id) && id > 0),
              );
              useSyncStore.getState().updateSyncingAccountIds(stillSyncing);
            }
          } catch {
            // Progress endpoint unavailable — keep the current
            // syncingAccountIds as-is until the global sync ends.
          }
        }
      } catch {
        // Status poll failed — don't crash, just skip this tick.
      }
    }, STATUS_POLL_INTERVAL_MS);
  }, [qc]);

  const stopStatusPolling = useCallback(() => {
    if (statusPollRef.current) {
      clearInterval(statusPollRef.current);
      statusPollRef.current = null;
    }
  }, []);

  // Clean up polling on unmount.
  useEffect(() => () => stopStatusPolling(), [stopStatusPolling]);

  // Core sync routine — attempts to trigger a sync, then starts status
  // polling so the UI stays accurate for the entire duration.
  const runSync = useCallback(async () => {
    // Atomic lock: read + set in one synchronous step via getState() to
    // prevent two hook instances (e.g. Sidebar + Settings) from both
    // passing the guard in the same render tick.
    const store = useSyncStore.getState();
    if (store.syncLock || store.backendSyncing) return;

    // Determine which accounts will be synced for the spinner.
    let syncIds: number[] | undefined;
    if (accountIdRef.current) {
      syncIds = [accountIdRef.current];
    } else {
      // Fetch all account IDs so the sidebar shows spinners for each.
      try {
        const accts = await accountsApi.list();
        syncIds = accts.map((a) => a.id);
      } catch {
        // If we can't list accounts, still trigger sync — just no spinners.
        syncIds = undefined;
      }
    }
    store.beginSync(syncIds);

    try {
      const res: SyncResult = await syncApi.trigger(
        accountIdRef.current ?? undefined,
      );
      // Sync started on the backend — begin polling for completion.
      startStatusPolling();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sync failed";
      // 409 means "sync already in progress" — not a real error, just
      // start polling the existing sync instead.
      if (msg.includes("already in progress") || msg.includes("409")) {
        startStatusPolling();
        return;
      }
      useSyncStore.getState().failSync(msg);
    }
  }, [startStatusPolling]);

  // Re-read settings from localStorage / zustand cache. The settings page
  // writes back to the same keys via settingsApi.update + localStorage so
  // polling once a second is overkill — listening to the storage event
  // covers the "open in two tabs" case too.
  useEffect(() => {
    const read = () => {
      try {
        const get = (k: string, fallback: string) =>
          localStorage.getItem(`mailgo-setting:${k}`) || fallback;
        settingsRef.current = {
          enabled: get("auto_refresh_enabled", "true") === "true",
          intervalSeconds: clampInt(
            Number(get("check_interval", "300")),
            30, // never less than 30s — protects against accidental 1s
            24 * 60 * 60, // never more than 24h
          ),
        };
      } catch {
        /* localStorage may be unavailable in private windows */
      }
    };
    read();
    const onStorage = (e: StorageEvent) => {
      if (!e.key || e.key.startsWith("mailgo-setting:")) read();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Track online/offline.
  useEffect(() => {
    const onOnline = () => {
      onlineRef.current = true;
    };
    const onOffline = () => {
      onlineRef.current = false;
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Keep the account id ref in sync with the latest prop.
  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  // The actual timer.
  useEffect(() => {
    if (!enableTimer) return;
    let timer: number | null = null;

    const shouldPause = () => {
      const { enabled } = settingsRef.current;
      if (!enabled) return true;
      if (!onlineRef.current) return true;
      if (useSyncStore.getState().syncLock) return true;
      if (useSyncStore.getState().backendSyncing) return true;
      return false;
    };

    const arm = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (shouldPause()) {
        // When paused, re-evaluate every 5s so we resume quickly once
        // conditions improve (network back, user re-enables).
        timer = window.setTimeout(arm, 5000);
        return;
      }
      const period = Math.max(5, settingsRef.current.intervalSeconds) * 1000;
      timer = window.setTimeout(async () => {
        await runSync();
        arm();
      }, period);
    };

    // Kick off the very first sync on mount (when auto-refresh is on) so
    // the UI starts with fresh data instead of waiting a full interval.
    if (settingsRef.current.enabled && !shouldPause()) {
      void runSync();
    }

    // Also do a one-time status check on mount to detect a sync that was
    // already running when the page loaded (e.g. background loop).
    void (async () => {
      try {
        const status = await syncApi.status();
        if (status.syncing) {
          useSyncStore.getState().applyBackendStatus(true, "");
          startStatusPolling();
        } else if (status.last_sync_at) {
          useSyncStore.getState().applyBackendStatus(false, status.last_sync_at);
        }
      } catch { /* ignore */ }
    })();

    arm();

    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [enableTimer, runSync, startStatusPolling]);

  // Manually trigger a sync on demand. The store still flips to "syncing"
  // so the spinner lights up.
  const syncNow = useCallback(async () => {
    await runSync();
  }, [runSync]);

  return { syncNow, phase };
}

function clampInt(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
