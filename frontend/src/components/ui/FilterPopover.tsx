import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { SlidersHorizontal, X } from "lucide-react";
import { useAppStore, type MessageFilters } from "@/stores/appStore";
import { cn } from "@/lib/utils";

interface FilterPopoverProps {
  /** Extra class for the trigger button. */
  className?: string;
}

/**
 * Filter button + popover for the message list toolbar.
 * Renders a trigger button; clicking it opens a fixed popover anchored to the
 * button.  Filter state lives in appStore so it persists across views.
 */
export function FilterPopover({ className }: FilterPopoverProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  const filters = useAppStore((s) => s.messageFilters);
  const setFilters = useAppStore((s) => s.setMessageFilters);
  const clearFilters = useAppStore((s) => s.clearMessageFilters);

  const hasActive =
    filters.hasAttachment ||
    filters.from !== "" ||
    filters.subject !== "" ||
    filters.dateAfter !== "" ||
    filters.dateBefore !== "";

  // Position the popover below the trigger button.
  const updatePos = useCallback(() => {
    const btn = anchorRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const popoverWidth = 300;
    let left = rect.right - popoverWidth;
    if (left < 8) left = 8;
    if (left + popoverWidth > window.innerWidth - 8) {
      left = window.innerWidth - popoverWidth - 8;
    }
    setPos({ top: rect.bottom + 6, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePos();
    const onResize = () => updatePos();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, updatePos]);

  // Close on click outside + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const update = (patch: Partial<MessageFilters>) => setFilters(patch);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "h-8 w-8 inline-flex items-center justify-center rounded-geist shrink-0 transition-colors",
          "text-secondary hover:text-[var(--geist-primary)] hover:bg-[var(--mailgo-sidebar-hover)]",
          hasActive && "text-[var(--geist-tertiary)]",
          className,
        )}
        title={t("filter.title")}
        aria-label={t("filter.title")}
      >
        <SlidersHorizontal size={15} />
      </button>

      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={t("filter.title")}
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: 9999,
              width: 300,
            }}
            className="rounded-geist border bg-geist-bg-100 shadow-popover animate-fade-in-fast flex flex-col"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-3 h-10 border-b shrink-0"
              style={{ borderColor: "var(--geist-border)" }}
            >
              <span
                className="text-label-13 font-medium"
                style={{ color: "var(--geist-primary)" }}
              >
                {t("filter.title")}
              </span>
              <div className="flex items-center gap-1">
                {hasActive && (
                  <button
                    type="button"
                    onClick={() => clearFilters()}
                    className="h-6 px-1.5 text-label-12 rounded transition-colors hover:bg-[var(--mailgo-sidebar-hover)]"
                    style={{ color: "var(--geist-red-500)" }}
                  >
                    {t("filter.clear")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="h-6 w-6 inline-flex items-center justify-center rounded transition-colors hover:bg-[var(--mailgo-sidebar-hover)] text-secondary"
                  aria-label={t("common.close")}
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="p-3 space-y-3">
              {/* Has attachment */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.hasAttachment}
                  onChange={(e) =>
                    update({ hasAttachment: e.target.checked })
                  }
                  className="h-3.5 w-3.5 rounded accent-[var(--geist-primary)]"
                />
                <span
                  className="text-label-13"
                  style={{ color: "var(--geist-primary)" }}
                >
                  {t("filter.hasAttachment")}
                </span>
              </label>

              {/* From */}
              <div>
                <label
                  className="text-label-12 mb-1 block"
                  style={{ color: "var(--geist-secondary)" }}
                >
                  {t("filter.from")}
                </label>
                <input
                  value={filters.from}
                  onChange={(e) => update({ from: e.target.value })}
                  placeholder={t("filter.placeholderFrom")}
                  className="input-small w-full"
                />
              </div>

              {/* Subject */}
              <div>
                <label
                  className="text-label-12 mb-1 block"
                  style={{ color: "var(--geist-secondary)" }}
                >
                  {t("filter.subject")}
                </label>
                <input
                  value={filters.subject}
                  onChange={(e) => update({ subject: e.target.value })}
                  placeholder={t("filter.placeholderSubject")}
                  className="input-small w-full"
                />
              </div>

              {/* Date range */}
              <div>
                <label
                  className="text-label-12 mb-1 block"
                  style={{ color: "var(--geist-secondary)" }}
                >
                  {t("filter.dateRange")}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={filters.dateAfter}
                    onChange={(e) => update({ dateAfter: e.target.value })}
                    className="input-small flex-1 min-w-0"
                    title={t("filter.after")}
                  />
                  <span className="text-label-12 text-secondary shrink-0">–</span>
                  <input
                    type="date"
                    value={filters.dateBefore}
                    onChange={(e) => update({ dateBefore: e.target.value })}
                    className="input-small flex-1 min-w-0"
                    title={t("filter.before")}
                  />
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
