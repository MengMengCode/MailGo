import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "@/hooks/useBreakpoint";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  hideClose?: boolean;
}

const sizeClass = {
  sm: "max-w-[400px]",
  md: "max-w-[520px]",
  lg: "max-w-[720px]",
  xl: "max-w-[960px]",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  hideClose,
}: ModalProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = original;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex items-center justify-center animate-fade-in-fast",
        isMobile ? "p-0" : "p-6",
      )}
      style={{ backgroundColor: "rgba(0, 0, 0, 0.32)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "w-full bg-geist-bg-100 shadow-modal border border-default flex flex-col animate-fade-in",
          isMobile
            ? "h-full max-h-full rounded-none"
            : "rounded-geist-md max-h-[calc(100vh-64px)]",
          !isMobile && sizeClass[size],
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-default">
            <div>
              {title && <h2 className="text-heading-16">{title}</h2>}
              {description && (
                <p className="text-copy-13 text-secondary mt-1">{description}</p>
              )}
            </div>
            {!hideClose && (
              <button
                onClick={onClose}
                aria-label={t("common.close")}
                className="h-8 w-8 flex items-center justify-center rounded-geist text-secondary hover:bg-[var(--mailgo-sidebar-hover)] transition-colors"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <div className={cn("flex-1 overflow-y-auto", isMobile ? "px-4 py-4" : "px-6 py-5")}>{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-default flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
