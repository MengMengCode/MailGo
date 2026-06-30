import { useQuery } from "@tanstack/react-query";
import { accountsApi, type Account } from "@/lib/api";

export const accountKeys = {
  all: ["accounts"] as const,
  detail: (id: number) => ["accounts", id] as const,
};

export function useAccountsQuery() {
  return useQuery<Account[]>({
    queryKey: accountKeys.all,
    queryFn: () => accountsApi.list(),
    staleTime: 30_000,
  });
}

export function useAccountQuery(id: number | null | undefined) {
  return useQuery<Account>({
    queryKey: id ? accountKeys.detail(id) : ["accounts", "none"],
    queryFn: () => accountsApi.get(id!),
    enabled: !!id,
  });
}
