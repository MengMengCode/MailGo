import { useMutation, useQueryClient } from "@tanstack/react-query";
import { draftsApi, type Draft } from "@/lib/api";
import { draftKeys } from "@/hooks/queries/useDrafts";

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Draft>) => draftsApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: draftKeys.all });
    },
  });
}

export function useUpdateDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Draft> }) =>
      draftsApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: draftKeys.all });
    },
  });
}

export function useDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => draftsApi.delete(id),
    onMutate: async (id) => {
      // Optimistic update so the row disappears from the list immediately.
      await qc.cancelQueries({ queryKey: draftKeys.list(false) });
      const previous = qc.getQueryData<Draft[]>(draftKeys.list(false));
      if (previous) {
        qc.setQueryData<Draft[]>(
          draftKeys.list(false),
          previous.filter((d) => d.id !== id),
        );
      }
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(draftKeys.list(), ctx.previous);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: draftKeys.all });
    },
  });
}

export function usePermanentDeleteDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => draftsApi.permanentDelete(id),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: draftKeys.all });
    },
  });
}
