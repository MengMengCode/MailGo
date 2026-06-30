import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface MenuPosition {
  x: number;
  y: number;
}

interface ContextMenuState {
  position: MenuPosition | null;
  /** The id of the ContextMenu instance that opened. Only that instance
   *  renders its menu content. This prevents every list item from
   *  showing a duplicate menu when one item is right-clicked. */
  activeId: string | null;
  open: (x: number, y: number, id: string) => void;
  close: () => void;
}

const ContextMenuContext = createContext<ContextMenuState | null>(null);

/**
 * ContextMenuProvider wraps a tree and exposes `useContextMenu()`. A
 * consumer renders `<ContextMenu>` somewhere inside the provider and
 * fills it with `<MenuItem>` children; the items are shown at the
 * cursor position when `open()` is called (typically from an
 * `onContextMenu` handler).
 *
 * To support list views where many `<ContextMenu>` instances exist
 * (one per row), `open()` takes an `id` — only the instance whose `id`
 * matches renders. Use the `useContextMenuMenuId()` hook inside a
 * `<ContextMenu>` to get that instance's id, or pass `menuId` to
 * `<ContextMenu>` to use a custom one.
 *
 * Clicking outside, pressing Escape, or choosing an item closes the menu.
 */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const open = useCallback((x: number, y: number, id: string) => {
    setPosition({ x, y });
    setActiveId(id);
  }, []);
  const close = useCallback(() => {
    setPosition(null);
    setActiveId(null);
  }, []);
  return (
    <ContextMenuContext.Provider value={{ position, activeId, open, close }}>
      {children}
    </ContextMenuContext.Provider>
  );
}

export function useContextMenu() {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenuProvider");
  return ctx;
}

let contextMenuIdCounter = 0;

interface ContextMenuProps {
  children: ReactNode;
  /** Optional explicit id. When omitted a stable auto-id is generated. */
  menuId?: string;
}

/**
 * ContextMenu renders the popup menu. In a list of items each item can
 * have its own `<ContextMenu>` — only the one whose `menuId` was passed
 * to `open()` will actually render.
 */
export function ContextMenu({ children, menuId }: ContextMenuProps) {
  const { position, activeId, close } = useContextMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [autoId] = useState(() => `ctx-${++contextMenuIdCounter}`);
  const id = menuId || autoId;

  useEffect(() => {
    if (!position || activeId !== id) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Use mousedown to detect outside-clicks so the menu closes before a
    // background element reacts to the click. The menu's own buttons still
    // work because their click fires after mousedown and the menu content
    // is inside `ref.current` (so onDown does NOT close for in-menu clicks).
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // NOTE: we intentionally do NOT close on `scroll`. The previous
    // implementation registered a capture-phase scroll listener which
    // fired on *any* scroll event — including programmatic scrolls the
    // virtual list emits while re-measuring after a re-render. That made
    // the menu close almost immediately after opening (the virtualizer
    // scrolled during the context-state update), so menu items became
    // unclickable. The menu is position:fixed so it stays put visually
    // when the underlying list scrolls; closing on scroll is a nice-to-
    // have but not worth breaking clicks over.
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [position, activeId, id, close]);

  if (!position || activeId !== id) return null;

  // Keep the menu inside the viewport.
  const x = Math.min(position.x, window.innerWidth - 200);
  const y = Math.min(position.y, window.innerHeight - 260);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 9999,
      }}
      className="min-w-[160px] py-1 rounded-geist border bg-geist-bg-100 shadow-popover animate-fade-in-fast"
      // Stop the document-level mousedown listener from treating clicks on
      // the menu as "outside" clicks (defensive — the contains() check
      // already covers this, but stopPropagation makes it bulletproof).
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      // Prevent pointer events from bubbling to the virtual list's scroll
      // container. The list calls setPointerCapture on pointerdown for drag-
      // to-select; if that capture activates while the user is interacting
      // with the context menu, subsequent mouse events can be misdirected
      // and menu item clicks silently fail.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

interface MenuItemProps {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function MenuItem({ icon, label, onClick, danger, disabled }: MenuItemProps) {
  const { close } = useContextMenu();
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onClick();
        close();
      }}
      className="w-full flex items-center gap-2.5 px-3 h-8 text-left text-label-13 transition-colors disabled:opacity-50 disabled:cursor-default"
      style={{
        color: danger ? "var(--geist-red-500)" : "var(--geist-primary)",
      }}
      onMouseEnter={(e) => {
        if (!disabled)
          e.currentTarget.style.backgroundColor = "var(--mailgo-sidebar-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "transparent";
      }}
    >
      {icon && (
        <span className="inline-flex items-center justify-center w-4 shrink-0">
          {icon}
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function MenuDivider() {
  return (
    <div
      className="my-1 h-px"
      style={{ backgroundColor: "var(--geist-border)" }}
    />
  );
}
