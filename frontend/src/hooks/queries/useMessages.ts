import {
  useQuery,
  useInfiniteQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { messagesApi, type MessageListParams } from "@/lib/api";

export const messageKeys = {
  all: ["messages"] as const,
  list: (params?: MessageListParams) => ["messages", "list", params] as const,
  detail: (id: number | null | undefined) =>
    id ? (["messages", "detail", id] as const) : (["messages", "detail", "none"] as const),
  thread: (id: number | null | undefined) =>
    id ? (["messages", "thread", id] as const) : (["messages", "thread", "none"] as const),
  starred: ["messages", "starred"] as const,
};

export function useMessagesQuery(
  params?: MessageListParams,
  enabled = true,
) {
  return useQuery({
    queryKey: messageKeys.list(params),
    queryFn: () => messagesApi.list(params),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    enabled,
  });
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * Infinite (cursor-style) message list. Each page fetches `page_size`
 * messages; `getNextPageParam` derives the next page from `total`.
 * Used by MailFolderView so the list can grow as the user scrolls.
 */
export function useInfiniteMessagesQuery(
  params?: MessageListParams,
  enabled = true,
) {
  const pageSize = params?.page_size ?? DEFAULT_PAGE_SIZE;
  return useInfiniteQuery({
    queryKey: ["messages", "infinite", params],
    queryFn: ({ pageParam }) =>
      messagesApi.list({ ...params, page: pageParam, page_size: pageSize }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.page_size < last.total ? last.page + 1 : undefined,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    enabled,
  });
}

export function useMessageQuery(id: number | null | undefined) {
  const qc = useQueryClient();
  const prevIdRef = useRef<number | undefined>(undefined);
  const prevReadRef = useRef<boolean | undefined>(undefined);

  const query = useQuery({
    queryKey: messageKeys.detail(id),
    queryFn: () => messagesApi.get(id!),
    enabled: !!id,
  });

  // When the backend auto-marks a message as read on fetch,
  // invalidate folder queries so the sidebar badge updates.
  useEffect(() => {
    if (!query.data || !id) return;

    // Reset tracking when switching to a different message
    if (prevIdRef.current !== id) {
      prevIdRef.current = id;
      // On first load, check the list cache to see if this message was unread
      const listCaches = qc.getQueriesData<{ messages?: { id: number; is_read: boolean }[] }>({
        queryKey: ["messages", "list"],
      });
      let wasUnread = false;
      for (const [, data] of listCaches) {
        const msg = data?.messages?.find((m) => m.id === id);
        if (msg) {
          wasUnread = !msg.is_read;
          break;
        }
      }
      prevReadRef.current = query.data.is_read;
      if (wasUnread && query.data.is_read) {
        qc.invalidateQueries({ queryKey: ["folders"] });
        qc.invalidateQueries({ queryKey: messageKeys.all });
        void qc.refetchQueries({ queryKey: ["folders"], type: "active" });
        void qc.refetchQueries({ queryKey: messageKeys.all, type: "active" });
      }
      return;
    }

    // Subsequent updates: detect unread → read transition
    const wasUnread = prevReadRef.current === false;
    const isNowRead = query.data.is_read;
    prevReadRef.current = isNowRead;

    if (wasUnread && isNowRead) {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: messageKeys.all });
      void qc.refetchQueries({ queryKey: ["folders"], type: "active" });
      void qc.refetchQueries({ queryKey: messageKeys.all, type: "active" });
    }
  }, [query.data, id, qc]);

  return query;
}

export function useMessageThreadQuery(id: number | null | undefined) {
  return useQuery({
    queryKey: messageKeys.thread(id),
    queryFn: () => messagesApi.thread(id!),
    enabled: !!id,
  });
}

export function useStarredMessagesQuery() {
  return useQuery({
    queryKey: messageKeys.starred,
    queryFn: () =>
      messagesApi.list({ starred: true, page: 1, page_size: 100 }),
    staleTime: 30_000,
  });
}

/** Lightweight hook: returns the total count of starred messages. */
export function useStarredCountQuery() {
  return useQuery({
    queryKey: ["messages", "starred-count"] as const,
    queryFn: () =>
      messagesApi.list({ starred: true, page: 1, page_size: 1 }),
    select: (data) => data.total,
    staleTime: 30_000,
  });
}

/** Lightweight hook: returns the total count of starred messages for a given account. */
export function useStarredCountByAccountQuery(accountId: number) {
  return useQuery({
    queryKey: ["messages", "starred-count", accountId] as const,
    queryFn: () =>
      messagesApi.list({ starred: true, account_id: accountId, page: 1, page_size: 1 }),
    select: (data) => data.total,
    staleTime: 30_000,
  });
}
