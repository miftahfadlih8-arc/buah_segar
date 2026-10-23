import Link from "next/link";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Icon, type IconName } from "./icons";

export type ButtonVariant = "primary" | "fresh" | "secondary" | "warning" | "danger" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-slate-900 text-white hover:bg-slate-800 border border-slate-900 shadow-2xs",
  fresh:
    "bg-emerald-600 text-white hover:bg-emerald-700 border border-emerald-600 shadow-2xs",
  secondary:
    "bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 border border-slate-200/90 shadow-2xs",
  warning:
    "bg-amber-600 text-white hover:bg-amber-700 border border-amber-600 shadow-2xs",
  danger:
    "bg-red-50 text-red-700 hover:bg-red-100 border border-red-200",
  ghost:
    "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-transparent",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-xs rounded-lg gap-1.5 min-h-[32px]",
  md: "px-3.5 py-2 text-sm rounded-lg gap-2 min-h-[38px]",
  lg: "px-4 py-2.5 text-sm rounded-xl gap-2 min-h-[42px]",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  loading?: boolean;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  loading = false,
  disabled,
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${className}`}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : icon ? (
        <Icon name={icon} size={size === "sm" ? 14 : 16} />
      ) : null}
      {children}
    </button>
  );
}

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "navy";

const BADGE_STYLES: Record<BadgeTone, { pill: string; dot: string }> = {
  neutral: {
    pill: "bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200/80",
    dot: "bg-slate-500",
  },
  success: {
    pill: "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200/80",
    dot: "bg-emerald-600",
  },
  warning: {
    pill: "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200/80",
    dot: "bg-amber-500",
  },
  danger: {
    pill: "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200/80",
    dot: "bg-red-600",
  },
  info: {
    pill: "bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200/80",
    dot: "bg-blue-600",
  },
  navy: {
    pill: "bg-slate-900 text-white ring-1 ring-inset ring-slate-800",
    dot: "bg-emerald-400",
  },
};

export function Badge({
  tone = "neutral",
  dot = false,
  children,
  className = "",
}: {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const style = BADGE_STYLES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${style.pill} ${className}`}
    >
      {dot && <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />}
      {children}
    </span>
  );
}

export function statusToBadgeTone(status: string): BadgeTone {
  const normalized = status.toLowerCase();
  if (
    [
      "active",
      "approved",
      "confirmed",
      "posted",
      "received",
      "delivered",
      "paid",
      "verified",
      "available",
      "accepted",
    ].includes(normalized)
  ) {
    return "success";
  }
  if (
    [
      "pending",
      "pending_approval",
      "pending_verification",
      "partially_received",
      "partially_paid",
      "reserved",
      "quarantine",
      "conditional_accept",
    ].includes(normalized)
  ) {
    return "warning";
  }
  if (
    [
      "Submitted".toLowerCase(),
      "picking",
      "packed",
      "shipped",
      "invoiced",
      "issued",
      "converted",
    ].includes(normalized)
  ) {
    return "info";
  }
  if (
    [
      "rejected",
      "cancelled",
      "suspended",
      "expired",
      "overdue",
      "recalled",
      "blocked",
    ].includes(normalized)
  ) {
    return "danger";
  }
  return "neutral";
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description: string;
  eyebrow?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col justify-between gap-4 border-b border-slate-200/80 pb-5 sm:flex-row sm:items-center">
      <div className="space-y-1">
        {eyebrow && <div className="mb-1">{eyebrow}</div>}
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
        <p className="max-w-3xl text-sm text-slate-500">{description}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{actions}</div>}
    </div>
  );
}

export function KpiCard({
  label,
  value,
  icon,
  iconTone = "info",
  badgeText,
  badgeTone = "neutral",
  caption,
  href,
}: {
  label: string;
  value: string;
  icon: IconName;
  iconTone?: "info" | "fresh" | "warning" | "danger" | "navy";
  badgeText?: string;
  badgeTone?: BadgeTone;
  caption: string;
  href?: string;
}) {
  const iconToneMap = {
    info: "bg-blue-50 text-blue-600 ring-1 ring-blue-100",
    fresh: "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-100",
    warning: "bg-amber-50 text-amber-600 ring-1 ring-amber-100",
    danger: "bg-red-50 text-red-600 ring-1 ring-red-100",
    navy: "bg-slate-100 text-slate-800 ring-1 ring-slate-200",
  };

  const inner = (
    <div className="flex h-full flex-col justify-between rounded-xl border border-slate-200/90 bg-white p-5 shadow-2xs transition hover:border-slate-300">
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
          {label}
        </span>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconToneMap[iconTone]}`}
        >
          <Icon name={icon} size={16} />
        </span>
      </div>

      <div className="my-3">
        <div className="tabular-nums text-2xl font-bold tracking-tight text-slate-900 sm:text-[26px]">
          {value}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {badgeText && <Badge tone={badgeTone}>{badgeText}</Badge>}
        <span className="truncate">{caption}</span>
      </div>
    </div>
  );

  if (href) {
    return (
      <Link href={href} className="block h-full rounded-xl">
        {inner}
      </Link>
    );
  }
  return inner;
}

export function Card({
  children,
  className = "",
  noPadding = false,
}: {
  children: ReactNode;
  className?: string;
  noPadding?: boolean;
}) {
  return (
    <section
      className={`rounded-xl border border-slate-200/90 bg-white shadow-2xs ${
        noPadding ? "" : "p-5 sm:p-6"
      } ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  id,
  title,
  subtitle,
  meta,
  actions,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
      <div>
        <div className="flex items-center gap-2.5">
          <h2 id={id} className="text-base font-bold text-slate-900">
            {title}
          </h2>
          {meta}
        </div>
        {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon = "fileText",
  title,
  description,
  action,
}: {
  icon?: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
        <Icon name={icon} size={20} />
      </div>
      <h3 className="mt-3 text-sm font-bold text-slate-900">{title}</h3>
      <p className="mt-1 max-w-md text-xs text-slate-500">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-semibold text-slate-700">
        {label} {required && <span className="text-red-600">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition focus:border-emerald-600 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 transition focus:border-emerald-600 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition focus:border-emerald-600 ${className}`}
      {...props}
    />
  );
}
