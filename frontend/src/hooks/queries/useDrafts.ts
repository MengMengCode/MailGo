import { useQuery } from "@tanstack/react-query";
import { draftsApi, type Draft } from "@/lib/api";

export const draftKeys = {
  all: ["drafts"] as const,
  list: (trashed = false) => ["drafts", "list", { trashed }] as const,
  detail: (id: number | null) =>
    id ? (["drafts", "detail", id] as const) : (["drafts", "detail", "none"] as const),
};

export function useDraftsQuery(trashed = false, enabled = true) {
  return useQuery({
    queryKey: draftKeys.list(trashed),
    queryFn: () => draftsApi.list(trashed),
    staleTime: 10_000,
    enabled,
  });
}

export function useDraftQuery(id: number | null | undefined) {
  const safeId = id ?? null;
  return useQuery<Draft>({
    queryKey: draftKeys.detail(safeId),
    queryFn: () => draftsApi.get(safeId!),
    enabled: !!safeId,
  });
}
