import { create } from "zustand";

/**
 * Sync store — tracks the live "auto-refresh" status so the StatusBar,
 * InboxView, and SettingsView can all reflect the same state without
 * having to share props.
 *
 * The state machine is intentionally tiny:
 *   - "idle"     → no sync in progress, no error
 *   - "syncing"  → a sync request is in-flight
 *   - "error"    → the most recent sync attempt failed
 *
 * `lastSyncAt` is the timestamp of the *last successful* sync. Errors
 * clear it from the latest attempt's perspective but we keep the previous
 * value so the UI can keep displaying "Synced 3m ago".
 */
export type SyncPhase = "idle" | "syncing" | "error";

export interface SyncState {
  phase: SyncPhase;
  /** ISO timestamp of the most recent successful sync, or null. */
  lastSyncAt: string | null;
  /** ISO timestamp of the most recent attempt (success or failure). */
  lastAttemptAt: string | null;
  /** Human-readable error message when phase === "error". */
  errorMessage: string | null;
  /** Number of new messages reported by the last successful sync. */
  newMessages: number;

  /** Global lock — true while a sync request is in-flight. Prevents
   *  multiple useAutoRefresh instances from triggering concurrent syncs. */
  syncLock: boolean;

  /** Whether the backend reports a sync is currently running. */
  backendSyncing: boolean;

  /** Set of account IDs currently being synced (for per-account spinner). */
  syncingAccountIds: Set<number>;

  beginSync: (accountIds?: number[]) => void;
  completeSync: (at: string, newMessages: number) => void;
  failSync: (message: string) => void;
  /** Update from backend status poll. Keeps phase="syncing" while
   *  backend reports syncing=true, and updates lastSyncAt when idle. */
  applyBackendStatus: (syncing: boolean, lastSyncAt: string) => void;
  /** Update which accounts are still syncing (from progress poll). */
  updateSyncingAccountIds: (ids: Set<number>) => void;
  /** Reset to the initial state — used when the user disables auto-refresh. */
  reset: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  phase: "idle",
  lastSyncAt: null,
  lastAttemptAt: null,
  errorMessage: null,
  newMessages: 0,
  syncLock: false,
  backendSyncing: false,
  syncingAccountIds: new Set<number>(),

  beginSync: (accountIds) =>
    set({
      phase: "syncing",
      syncLock: true,
      backendSyncing: true,
      lastAttemptAt: new Date().toISOString(),
      errorMessage: null,
      syncingAccountIds: new Set(accountIds ?? []),
    }),

  completeSync: (at, newMessages) =>
    set({
      phase: "idle",
      syncLock: false,
      backendSyncing: false,
      lastSyncAt: at,
      newMessages,
      errorMessage: null,
      syncingAccountIds: new Set(),
    }),

  failSync: (message) =>
    set({
      phase: "error",
      syncLock: false,
      backendSyncing: false,
      errorMessage: message,
      syncingAccountIds: new Set(),
    }),

  applyBackendStatus: (syncing, lastSyncAt) =>
    set((state) => {
      if (syncing) {
        return {
          phase: "syncing",
          syncLock: true,
          backendSyncing: true,
          lastAttemptAt: state.lastAttemptAt ?? new Date().toISOString(),
        };
      }
      if (state.backendSyncing) {
        return {
          phase: "idle",
          syncLock: false,
          backendSyncing: false,
          lastSyncAt: lastSyncAt || state.lastSyncAt,
          syncingAccountIds: new Set(),
        };
      }
      return { lastSyncAt: lastSyncAt || state.lastSyncAt };
    }),

  updateSyncingAccountIds: (ids) =>
    set({ syncingAccountIds: ids }),

  reset: () =>
    set({
      phase: "idle",
      syncLock: false,
      backendSyncing: false,
      lastAttemptAt: null,
      errorMessage: null,
      syncingAccountIds: new Set(),
    }),
}));
