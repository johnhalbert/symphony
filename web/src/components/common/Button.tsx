import type { ButtonHTMLAttributes, ReactNode } from "react";

const DEFAULT_UNAVAILABLE_REASON = "no backend command path exists yet";

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

type UnavailableButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "type" | "aria-disabled"> & {
  children: ReactNode;
  unavailableLabel: string;
  unavailableReason?: string;
};

export function UnavailableButton({
  children,
  className = "btn",
  title,
  unavailableLabel,
  unavailableReason = DEFAULT_UNAVAILABLE_REASON,
  "aria-label": ariaLabel,
  ...props
}: UnavailableButtonProps) {
  const unavailableTitle = title ?? `${unavailableLabel} unavailable: ${unavailableReason}.`;
  return (
    <button
      {...props}
      aria-disabled="true"
      aria-label={ariaLabel ?? `${unavailableLabel} unavailable`}
      className={[className, "is-unavailable"].filter(Boolean).join(" ")}
      data-unavailable-action={unavailableLabel}
      disabled
      title={unavailableTitle}
      type="button"
    >
      {children}
    </button>
  );
}
