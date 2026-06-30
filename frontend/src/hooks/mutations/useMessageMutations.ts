import { useMutation, useQueryClient } from "@tanstack/react-query";
import { messagesApi, type Folder } from "@/lib/api";
import { showToast } from "@/stores/toast.store";
import { messageKeys } from "@/hooks/queries/useMessages";
import i18n from "@/lib/i18n";

/**
 * Refetch all message and folder queries so the sidebar unread counts
 * and the message list stay in sync after every mutation.
 */
function invalidateMessages(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: messageKeys.all });
  qc.invalidateQueries({ queryKey: ["folders"] });
  // Force an immediate refetch for active queries — invalidateQueries only
  // marks them stale; refetchQueries guarantees a network round-trip now.
  void qc.refetchQueries({ queryKey: messageKeys.all, type: "active" });
  void qc.refetchQueries({ queryKey: ["folders"], type: "active" });
}

/**
 * Optimistically bump / decrement the unread_count on every cached folder
 * query so the sidebar badge updates instantly without waiting for a
 * network round-trip.
 */
function patchFolderUnreadCount(
  qc: ReturnType<typeof useQueryClient>,
  folderId: number,
  delta: number,
) {
  qc.setQueriesData<Folder[]>({ queryKey: ["folders"] }, (old) => {
    if (!old) return old;
    return old.map((f) =>
      f.id === folderId
        ? { ...f, unread_count: Math.max(0, f.unread_count + delta) }
        : f,
    );
  });
}

/** Look up whether a message is currently marked as read in any cached list. */
function findMessageReadState(
  qc: ReturnType<typeof useQueryClient>,
  id: number,
): boolean {
  const caches = qc.getQueriesData<{ messages?: { id: number; is_read: boolean }[] }>({
    queryKey: ["messages", "list"],
  });
  for (const [, data] of caches) {
    const msg = data?.messages?.find((m) => m.id === id);
    if (msg) return msg.is_read;
  }
  return true; // default to "read" if not found
}

/** Look up a message's folder_id from any cached list or infinite query. */
function findMessageFolderId(
  qc: ReturnType<typeof useQueryClient>,
  id: number,
): number | undefined {
  // Try flat list caches first.
  const listCaches = qc.getQueriesData<{ messages?: { id: number; folder_id?: number }[] }>({
    queryKey: ["messages", "list"],
  });
  for (const [, data] of listCaches) {
    const msg = data?.messages?.find((m) => m.id === id);
    if (msg?.folder_id != null) return msg.folder_id;
  }
  // Try infinite query caches.
  const infCaches = qc.getQueriesData<{ pages?: { messages: { id: number; folder_id?: number }[] }[] }>({
    queryKey: ["messages", "infinite"],
  });
  for (const [, data] of infCaches) {
    for (const page of data?.pages ?? []) {
      const msg = page.messages?.find((m) => m.id === id);
      if (msg?.folder_id != null) return msg.folder_id;
    }
  }
  return undefined;
}

/**
 * Patch a single message field across every shape the messages cache can
 * take. The list query (used by SearchView) stores `{ messages: [...] }`,
 * while the infinite query (used by MailFolderView) stores
 * `{ pages: [{ messages: [...] }, ...], pageParams }`. We update both so
 * the UI reflects the change instantly regardless of which view is mounted.
 */
function patchMessageInCache(
  qc: ReturnType<typeof useQueryClient>,
  id: number,
  patch: (m: { id: number } & Record<string, unknown>) => Record<string, unknown>,
) {
  // Flat list queries: data shape = { messages, total, ... }
  qc.setQueriesData<{
    messages: { id: number }[];
  }>({ queryKey: ["messages", "list"] }, (old) => {
    if (!old || !Array.isArray(old.messages)) return old;
    return {
      ...old,
      messages: old.messages.map((m) =>
        m.id === id ? { ...m, ...patch(m) } : m,
      ),
    };
  });
  // Infinite queries: data shape = { pages: [{ messages, total, ... }], pageParams }
  qc.setQueriesData<{
    pages: { messages: { id: number }[] }[];
  }>({ queryKey: ["messages", "infinite"] }, (old) => {
    if (!old || !Array.isArray(old.pages)) return old;
    return {
      ...old,
      pages: old.pages.map((page) => {
        if (!page || !Array.isArray(page.messages)) return page;
        return {
          ...page,
          messages: page.messages.map((m) =>
            m.id === id ? { ...m, ...patch(m) } : m,
          ),
        };
      }),
    };
  });
}

export function useStarMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => messagesApi.star(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });
      patchMessageInCache(qc, id, (m) => ({
        is_starred: !(m.is_starred as boolean),
      }));
      // Also update the single-message detail cache so MessageDetail
      // reflects the change immediately.
      qc.setQueriesData<{ id: number; is_starred: boolean }>(
        { queryKey: messageKeys.detail(id) },
        (old) => (old ? { ...old, is_starred: !old.is_starred } : old),
      );
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => invalidateMessages(qc),
  });
}

export function useToggleRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => messagesApi.toggleRead(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });
      // Determine whether the message was read BEFORE the toggle so we
      // can compute the correct unread delta for the sidebar badge.
      const wasRead = findMessageReadState(qc, id);
      patchMessageInCache(qc, id, (m) => ({
        is_read: !(m.is_read as boolean),
      }));
      qc.setQueriesData<{ id: number; is_read: boolean }>(
        { queryKey: messageKeys.detail(id) },
        (old) => (old ? { ...old, is_read: !old.is_read } : old),
      );
      // Optimistically update the sidebar folder unread count: if the
      // message was read and is now unread, delta = +1; if it was unread
      // and is now read, delta = -1.
      const folderId = findMessageFolderId(qc, id);
      if (folderId != null) {
        patchFolderUnreadCount(qc, folderId, wasRead ? 1 : -1);
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
    },
    onSettled: () => invalidateMessages(qc),
  });
}

/**
 * Remove a message from all list/infinite caches (optimistic delete).
 */
function removeMessageFromCache(
  qc: ReturnType<typeof useQueryClient>,
  id: number,
) {
  qc.setQueriesData<{
    messages: { id: number }[];
  }>({ queryKey: ["messages", "list"] }, (old) => {
    if (!old || !Array.isArray(old.messages)) return old;
    return { ...old, messages: old.messages.filter((m) => m.id !== id) };
  });
  qc.setQueriesData<{
    pages: { messages: { id: number }[] }[];
  }>({ queryKey: ["messages", "infinite"] }, (old) => {
    if (!old || !Array.isArray(old.pages)) return old;
    return {
      ...old,
      pages: old.pages.map((page) => {
        if (!page || !Array.isArray(page.messages)) return page;
        return { ...page, messages: page.messages.filter((m) => m.id !== id) };
      }),
    };
  });
}

export function useDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => messagesApi.delete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });
      removeMessageFromCache(qc, id);
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      showToast(i18n.t("mutations.messageDeleteFailed"), "error");
    },
    onSettled: () => invalidateMessages(qc),
    onSuccess: () => showToast(i18n.t("mutations.messageDeleted"), "success"),
  });
}

export function useRestoreMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => messagesApi.restore(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });
      // Remove from current (trash) view immediately.
      removeMessageFromCache(qc, id);
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      showToast(i18n.t("mutations.messageRestoreFailed"), "error");
    },
    onSettled: () => invalidateMessages(qc),
    onSuccess: () => showToast(i18n.t("mutations.messageRestored"), "success"),
  });
}

export function usePermanentDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => messagesApi.permanentDelete(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });
      removeMessageFromCache(qc, id);
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      showToast(i18n.t("mutations.messagePermanentDeleteFailed"), "error");
    },
    onSettled: () => invalidateMessages(qc),
    onSuccess: () => showToast(i18n.t("mutations.messagePermanentlyDeleted"), "success"),
  });
}

export function useMoveMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, folderId }: { id: number; folderId: number }) =>
      messagesApi.move(id, folderId),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });
      // Remove from current folder view immediately.
      removeMessageFromCache(qc, id);
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      showToast(i18n.t("mutations.messageMovedFailed"), "error");
    },
    onSettled: () => invalidateMessages(qc),
  });
}

export function useBatchMessageAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      action,
      ids,
    }: {
      action:
        | "archive"
        | "delete"
        | "restore"
        | "permanent_delete"
        | "mark_read"
        | "mark_unread"
        | "star"
        | "unstar";
      ids: number[];
    }) => messagesApi.batch(action, ids),
    onMutate: async ({ action, ids }) => {
      await qc.cancelQueries({ queryKey: messageKeys.all });
      const snapshots = qc.getQueriesData({ queryKey: messageKeys.all });

      // Optimistic updates based on action type.
      if (action === "mark_read" || action === "mark_unread") {
        const isRead = action === "mark_read";
        for (const id of ids) {
          const wasRead = findMessageReadState(qc, id);
          patchMessageInCache(qc, id, () => ({ is_read: isRead }));
          // Update sidebar unread count: mark_read makes read (delta -1 if was unread),
          // mark_unread makes unread (delta +1 if was read).
          const folderId = findMessageFolderId(qc, id);
          if (folderId != null) {
            patchFolderUnreadCount(qc, folderId, isRead ? (wasRead ? 0 : -1) : (wasRead ? 1 : 0));
          }
        }
      } else if (action === "star" || action === "unstar") {
        const isStarred = action === "star";
        for (const id of ids) {
          patchMessageInCache(qc, id, () => ({ is_starred: isStarred }));
        }
      } else {
        // delete / restore / permanent_delete / archive — remove from view.
        for (const id of ids) {
          removeMessageFromCache(qc, id);
        }
      }
      return { snapshots };
    },
    onError: (_e, _v, ctx) => {
      ctx?.snapshots.forEach(([key, data]) => qc.setQueryData(key, data));
      showToast(i18n.t("batch.failed"), "error");
    },
    onSettled: () => invalidateMessages(qc),
    onSuccess: (_data, vars) => showToast(i18n.t("batch.success", { count: vars.ids.length }), "success"),
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: messagesApi.send,
    onSuccess: () => {
      invalidateMessages(qc);
      showToast(i18n.t("mutations.messageSent"), "success");
    },
    onError: (error: Error) => showToast(error.message, "error"),
  });
}
