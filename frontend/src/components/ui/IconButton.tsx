import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  ariaLabel: string;
  active?: boolean;
  size?: "sm" | "md" | "lg";
}

const sizeClass = {
  sm: "h-7 w-7",
  md: "h-8 w-8",
  lg: "h-10 w-10",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ children, ariaLabel, active, size = "md", className, ...props }, ref) => {
    return (
      <button
        ref={ref}
        aria-label={ariaLabel}
        className={cn(
          "inline-flex items-center justify-center rounded-geist transition-colors",
          sizeClass[size],
          active
            ? "text-[var(--geist-primary)] bg-[var(--mailgo-sidebar-active)]"
            : "text-secondary hover:bg-[var(--mailgo-sidebar-hover)] hover:text-[var(--geist-primary)]",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);
IconButton.displayName = "IconButton";
