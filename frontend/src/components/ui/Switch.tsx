import { cn } from "@/lib/utils";

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}

export function Switch({
  checked,
  onChange,
  disabled,
  size = "md",
  className,
  ariaLabel,
}: SwitchProps) {
  const trackSize = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const thumbSize = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const offsetOn = size === "sm" ? "translate-x-4" : "translate-x-5";
  const offsetOff = "translate-x-0.5";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex items-center rounded-full transition-colors shrink-0",
        trackSize,
        checked
          ? "bg-[var(--geist-primary)]"
          : "bg-[var(--geist-gray-200)]",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block rounded-full bg-white transition-transform shadow-sm",
          thumbSize,
          checked ? offsetOn : offsetOff,
        )}
      />
    </button>
  );
}
