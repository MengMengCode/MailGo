import { useTranslation } from "react-i18next";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { useConfirmStore } from "@/stores/confirm.store";

export function ConfirmDialog() {
  const { t } = useTranslation();
  const {
    isOpen,
    title,
    message,
    destructive,
    confirmVariant,
    confirmLabel,
    cancelLabel,
    handleConfirm,
    handleCancel,
  } = useConfirmStore();

  const variant = destructive
    ? "error"
    : confirmVariant === "error"
    ? "error"
    : "primary";

  return (
    <Modal
      open={isOpen}
      onClose={handleCancel}
      title={title || undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="small" onClick={handleCancel}>
            {cancelLabel || t("common.cancel")}
          </Button>
          <Button variant={variant} size="small" onClick={handleConfirm}>
            {confirmLabel || t("common.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-copy-14 text-secondary whitespace-pre-line">
        {message}
      </p>
    </Modal>
  );
}
