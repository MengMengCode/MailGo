import { forwardRef, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, className, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s+/g, "-");
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-label-13"
            style={{ color: "var(--geist-secondary)" }}
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={cn(
            "input py-2 min-h-[80px] leading-[20px]",
            error && "!border-[var(--geist-red-500)]",
            className,
          )}
          style={{ height: "auto" }}
          {...props}
        />
        {error ? (
          <p className="text-label-12" style={{ color: "var(--geist-red-500)" }}>
            {error}
          </p>
        ) : hint ? (
          <p className="text-label-12 text-disabled">{hint}</p>
        ) : null}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
