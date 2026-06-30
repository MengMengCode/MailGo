import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type InputSize = "small" | "medium" | "large";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  inputSize?: InputSize;
  label?: string;
  error?: string;
  hint?: string;
}

const sizeClass: Record<InputSize, string> = {
  small: "input-small",
  medium: "input",
  large: "input-large",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ inputSize = "medium", label, error, hint, className, id, ...props }, ref) => {
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
        <input
          ref={ref}
          id={inputId}
          className={cn(
            sizeClass[inputSize],
            error &&
              "!border-[var(--geist-red-500)] focus-visible:!shadow-[0_0_0_3px_color-mix(in_srgb,var(--geist-red-500)_18%,transparent)]",
            className,
          )}
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
Input.displayName = "Input";
