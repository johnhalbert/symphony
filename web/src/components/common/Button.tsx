import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  children,
  variant,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost"; children: ReactNode }) {
  const variantClass = variant === "primary" ? "btn--primary" : variant === "ghost" ? "btn--ghost" : "";
  return (
    <button className={["btn", variantClass, className].filter(Boolean).join(" ")} type="button" {...props}>
      {children}
    </button>
  );
}
