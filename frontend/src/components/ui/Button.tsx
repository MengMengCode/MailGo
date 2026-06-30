import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "tertiary" | "error";
export type ButtonSize = "small" | "medium" | "large";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: "btn-primary",
  secondary: "btn-secondary",
  tertiary: "btn-tertiary",
  error: "btn-error",
};

const sizeClass: Record<ButtonSize, string> = {
  small: "btn-small",
  medium: "",
  large: "btn-large",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "medium",
      loading = false,
      leadingIcon,
      trailingIcon,
      fullWidth,
      className,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        className={cn(
          variantClass[variant],
          sizeClass[size],
          fullWidth && "w-full",
          className,
        )}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 spinner" />
        ) : leadingIcon ? (
          <span className="inline-flex items-center">{leadingIcon}</span>
        ) : null}
        {children}
        {trailingIcon && !loading ? (
          <span className="inline-flex items-center">{trailingIcon}</span>
        ) : null}
      </button>
    );
  },
);
Button.displayName = "Button";
