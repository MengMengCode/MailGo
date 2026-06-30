import { useEffect, useRef, useState } from "react";
import { healthApi } from "@/lib/api";

const PING_INTERVAL = 3000; // ping every 3 seconds
const TIMEOUT_MS = 5000; // considered disconnected after 5 s without a successful ping

/**
 * Lightweight heartbeat that probes `GET /api/v1/health` on a short
 * interval.  Returns `connected: false` when the last successful pong
 * is older than `TIMEOUT_MS`, meaning the backend (or network) is
 * unreachable.
 */
export function useHeartbeat() {
  const [connected, setConnected] = useState(true);
  const lastPongRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let alive = true;

    const ping = async () => {
      try {
        await healthApi.ping();
        if (!alive) return;
        lastPongRef.current = Date.now();
        setConnected(true);
      } catch {
        // ping failed — don't update lastPongRef; the staleness check
        // below will flip `connected` to false once TIMEOUT_MS elapses.
      }
    };

    // Run an immediate ping so the state is accurate on mount.
    void ping();

    timerRef.current = setInterval(() => {
      void ping();
    }, PING_INTERVAL);

    // A separate faster checker that flips the `connected` flag once
    // the last pong is stale.  Runs every second so the UI reacts
    // promptly without extra network traffic.
    const checker = setInterval(() => {
      if (!alive) return;
      const stale = Date.now() - lastPongRef.current > TIMEOUT_MS;
      setConnected((prev) => (prev === stale ? prev : !stale));
    }, 1000);

    return () => {
      alive = false;
      clearInterval(timerRef.current);
      clearInterval(checker);
    };
  }, []);

  return connected;
}
