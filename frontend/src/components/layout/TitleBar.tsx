import { Search, Command } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "@/stores/appStore";

interface TitleBarProps {
  /** Optional search bar in the middle — when set, becomes the centerpiece. */
  searchSlot?: React.ReactNode;
}

/**
 * Web-style top bar. Replaces the old desktop-window chrome (traffic
 * lights, minimize/maximize/close). The brand on the left, a global
 * search input in the middle, and account/settings shortcuts on the
 * right are the conventions used by every modern webmail.
 */
export function TitleBar({ searchSlot }: TitleBarProps) {
  const { t } = useTranslation();
  const togglePalette = useAppStore((s) => s.togglePalette);

  return (
    <div
      className="flex items-center gap-3 h-12 select-none shrink-0 border-b px-3"
      style={{
        backgroundColor: "var(--mailgo-titlebar-bg)",
        borderColor: "var(--geist-border)",
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2 shrink-0">
        <img
          src="/icon.png"
          alt="MailGo"
          className="h-6 w-6 rounded-geist object-contain"
          draggable={false}
        />
        <span className="text-label-14 font-semibold tracking-tight">
          {t("app.name")}
        </span>
      </div>

      {/* Center: global search / command palette trigger */}
      <div className="flex-1 min-w-0 flex items-center justify-center">
        {searchSlot ?? (
          <button
            onClick={togglePalette}
            aria-label={t("titleBar.openCommandPalette")}
            className="group w-full max-w-[520px] inline-flex items-center gap-2 h-8 px-3 rounded-geist border text-left transition-colors"
            style={{
              backgroundColor: "var(--geist-gray-100)",
              borderColor: "transparent",
              color: "var(--geist-secondary)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--geist-bg-100)";
              e.currentTarget.style.borderColor = "var(--geist-border)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "var(--geist-gray-100)";
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            <Search size={14} />
            <span className="text-label-13 flex-1 truncate">
              {t("titleBar.search")}…
            </span>
            <kbd
              className="hidden sm:inline-flex items-center gap-0.5 px-1.5 h-5 rounded text-label-12 border"
              style={{
                background: "var(--geist-bg-100)",
                color: "var(--geist-secondary)",
                borderColor: "var(--geist-border)",
              }}
            >
              <Command size={10} />K
            </kbd>
          </button>
        )}
      </div>

      <div className="w-[72px] shrink-0" aria-hidden />
    </div>
  );
}
