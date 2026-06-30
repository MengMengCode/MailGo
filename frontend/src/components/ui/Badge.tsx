import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeVariant =
  | "default"
  | "blue"
  | "red"
  | "amber"
  | "green"
  | "purple"
  | "pink"
  | "teal";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}

const variantClass: Record<BadgeVariant, string> = {
  default: "bg-[var(--geist-gray-100)] text-secondary",
  blue: "tag-blue",
  red: "tag-red",
  amber: "tag-amber",
  green: "tag-green",
  purple: "tag-purple",
  pink: "tag-blue",
  teal: "tag-blue",
};

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 h-[20px] rounded-full text-label-12 font-medium whitespace-nowrap",
        variantClass[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
