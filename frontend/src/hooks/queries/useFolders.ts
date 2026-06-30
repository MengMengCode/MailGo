import { useQuery } from "@tanstack/react-query";
import { foldersApi, type Folder } from "@/lib/api";

export const folderKeys = {
  all: ["folders"] as const,
  forAccount: (accountId: number | null | undefined) =>
    ["folders", accountId ?? "all"] as const,
  detail: (id: number) => ["folders", id] as const,
};

export function useFoldersForAccountsQuery(
  accountIds: (number | null)[] | number | null | undefined,
) {
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds];
  // Query each account's folders in parallel and merge.
  const enabled =
    Array.isArray(accountIds) && accountIds.length > 0
      ? true
      : !!accountIds;

  const queries = useQuery<Folder[]>({
    queryKey: ["folders", "list", ids],
    queryFn: async () => {
      if (ids.length === 0) return [];
      if (ids.length === 1 && ids[0] == null) {
        return foldersApi.list();
      }
      const results = await Promise.all(
        ids.filter((x): x is number => x != null).map((id) => foldersApi.list(id)),
      );
      return results.flat();
    },
    enabled,
    staleTime: 30_000,
  });

  return queries;
}

export function useFolderQuery(id: number | null | undefined) {
  return useQuery<Folder>({
    queryKey: id ? folderKeys.detail(id) : ["folders", "none"],
    queryFn: () => foldersApi.get(id!),
    enabled: !!id,
  });
}
