import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export type SelectSize = "small" | "medium" | "large";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  inputSize?: SelectSize;
  label?: string;
  error?: string;
  hint?: string;
}

const sizeClass: Record<SelectSize, string> = {
  small: "input-small",
  medium: "input",
  large: "input-large",
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    { inputSize = "medium", label, error, hint, className, id, children, ...props },
    ref,
  ) => {
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
        <select
          ref={ref}
          id={inputId}
          className={cn(
            sizeClass[inputSize],
            "cursor-pointer appearance-none",
            "bg-no-repeat bg-[right_10px_center]",
            className,
          )}
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238f8f8f' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
            paddingRight: 32,
          }}
          {...props}
        >
          {children}
        </select>
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
Select.displayName = "Select";
