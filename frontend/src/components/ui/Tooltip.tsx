import { useState, useRef, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  className?: string;
}

export function Tooltip({
  content,
  children,
  position = "bottom",
  delay = 200,
  className,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Calculate position from the trigger element.
      const el = triggerRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        let top = 0;
        let left = 0;
        switch (position) {
          case "right":
            top = rect.top + rect.height / 2;
            left = rect.right + 8;
            break;
          case "left":
            top = rect.top + rect.height / 2;
            left = rect.left - 8;
            break;
          case "top":
            top = rect.top - 8;
            left = rect.left + rect.width / 2;
            break;
          case "bottom":
          default:
            top = rect.bottom + 8;
            left = rect.left + rect.width / 2;
            break;
        }
        setPos({ top, left });
      }
      setVisible(true);
    }, delay);
  };

  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const positionStyle: React.CSSProperties =
    position === "right"
      ? { top: pos.top, left: pos.left, transform: "translateY(-50%)" }
      : position === "left"
        ? { top: pos.top, left: pos.left, transform: "translate(-100%, -50%)" }
        : position === "top"
          ? { top: pos.top, left: pos.left, transform: "translate(-50%, -100%)" }
          : { top: pos.top, left: pos.left, transform: "translateX(-50%)" };

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible &&
        createPortal(
          <span
            role="tooltip"
            className={cn(
              "fixed z-[99999] px-2 py-1 rounded-geist text-label-12 whitespace-nowrap pointer-events-none",
              "shadow-popover animate-fade-in-fast",
              className,
            )}
            style={{
              ...positionStyle,
              backgroundColor: "var(--geist-primary)",
              color: "var(--geist-bg-100)",
            }}
          >
            {content}
          </span>,
          document.body,
        )}
    </span>
  );
}
