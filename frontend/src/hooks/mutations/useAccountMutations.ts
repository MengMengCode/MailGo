import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accountsApi } from "@/lib/api";
import { showToast } from "@/stores/toast.store";
import i18n from "@/lib/i18n";

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: accountsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
      showToast(i18n.t("mutations.accountCreated"), "success");
    },
    onError: () => showToast(i18n.t("mutations.accountCreateFailed"), "error"),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof accountsApi.update>[1] }) =>
      accountsApi.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      showToast(i18n.t("mutations.accountUpdated"), "success");
    },
    onError: () => showToast(i18n.t("mutations.accountUpdateFailed"), "error"),
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => accountsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
      qc.invalidateQueries({ queryKey: ["drafts"] });
      showToast(i18n.t("mutations.accountDeleted"), "success");
    },
    onError: () => showToast(i18n.t("mutations.accountDeleteFailed"), "error"),
  });
}
