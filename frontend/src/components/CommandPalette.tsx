import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Inbox, Star, Settings, Plus, Search as SearchIcon, FileEdit } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { cn } from "@/lib/utils";

interface Command {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const openCompose = useAppStore((s) => s.openCompose);

  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const commands: Command[] = useMemo(
    () => [
      {
        id: "inbox",
        label: t("sidebar.inbox"),
        description: t("commandPalette.inboxDesc"),
        icon: <Inbox size={15} />,
        shortcut: "G I",
        action: () => setActiveView("inbox"),
      },
      {
        id: "drafts",
        label: t("drafts.title"),
        description: t("commandPalette.draftsDesc"),
        icon: <FileEdit size={15} />,
        shortcut: "G D",
        action: () => setActiveView("drafts"),
      },
      {
        id: "starred",
        label: t("sidebar.starred"),
        description: t("commandPalette.starredDesc"),
        icon: <Star size={15} />,
        shortcut: "G S",
        action: () => setActiveView("starred"),
      },
      {
        id: "search",
        label: t("search.title"),
        description: t("commandPalette.searchDesc"),
        icon: <SearchIcon size={15} />,
        shortcut: "/",
        action: () => setActiveView("search"),
      },
      {
        id: "settings",
        label: t("sidebar.settings"),
        description: t("commandPalette.settingsDesc"),
        icon: <Settings size={15} />,
        action: () => setActiveView("settings"),
      },
      {
        id: "compose",
        label: t("compose.new"),
        description: t("commandPalette.composeDesc"),
        icon: <Plus size={15} />,
        shortcut: "C",
        action: () => openCompose(),
      },
    ],
    [t, setActiveView, openCompose],
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.description && c.description.toLowerCase().includes(q)),
    );
  }, [commands, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const execute = (cmd: Command) => {
    setOpen(false);
    cmd.action();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[index];
      if (cmd) execute(cmd);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-start justify-center pt-[14vh] animate-fade-in-fast"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.32)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-[560px] rounded-geist-md bg-geist-bg-100 border border-default shadow-modal overflow-hidden animate-fade-in">
        <div
          className="flex items-center gap-3 px-4 h-12 border-b"
          style={{ borderColor: "var(--geist-border)" }}
        >
          <Search size={16} className="text-secondary shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("commandPalette.placeholder")}
            className="flex-1 bg-transparent text-label-14 outline-none placeholder:text-disabled"
          />
          <kbd
            className="inline-flex items-center px-1.5 h-5 rounded text-label-12 border"
            style={{
              background: "var(--geist-gray-100)",
              color: "var(--geist-secondary)",
              borderColor: "var(--geist-border)",
            }}
          >
            esc
          </kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="text-label-13 text-secondary text-center py-6">
              No commands found
            </p>
          ) : (
            filtered.map((cmd, i) => (
              <button
                key={cmd.id}
                onClick={() => execute(cmd)}
                onMouseEnter={() => setIndex(i)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 h-10 rounded-geist text-left transition-colors",
                  i === index
                    ? "text-[var(--geist-primary)]"
                    : "text-secondary",
                )}
                style={
                  i === index
                    ? { backgroundColor: "var(--geist-gray-100)" }
                    : undefined
                }
              >
                <span
                  className="inline-flex items-center justify-center w-5 h-5"
                  style={{ color: "var(--geist-secondary)" }}
                >
                  {cmd.icon}
                </span>
                <span className="text-label-14 flex-1 truncate">
                  {cmd.label}
                </span>
                {cmd.shortcut && (
                  <kbd
                    className="inline-flex items-center px-1.5 h-5 rounded text-label-12 border"
                    style={{
                      background: "var(--geist-bg-100)",
                      color: "var(--geist-secondary)",
                      borderColor: "var(--geist-border)",
                    }}
                  >
                    {cmd.shortcut}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
