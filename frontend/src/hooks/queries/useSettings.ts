import { useQuery } from "@tanstack/react-query";
import { settingsApi } from "@/lib/api";

export const settingsKeys = {
  all: ["settings"] as const,
};

export function useSettingsQuery() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: () => settingsApi.list(),
    staleTime: 60_000,
  });
}
