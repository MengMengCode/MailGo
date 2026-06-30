import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center h-full gap-3 text-center px-6 py-10",
        className,
      )}
    >
      {icon && (
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center"
          style={{
            backgroundColor: "var(--geist-gray-100)",
            color: "var(--geist-gray-500)",
          }}
        >
          {icon}
        </div>
      )}
      <p className="text-heading-14">{title}</p>
      {description && (
        <p className="text-copy-13 text-secondary max-w-[320px]">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
