import { Icon, type IconName } from "./Icon.tsx";

export type Tone = "neutral" | "accent" | "warning" | "success";

const DOT: Record<Tone, IconName> = {
  neutral: "dot",
  accent: "dot-accent",
  warning: "dot-warning",
  success: "dot-success",
};

/** Figma "Pill": a status chip. Success and Warning are semantic; Accent is for highlights. */
export function Pill({ label, tone = "neutral", dot = true }: { label: string; tone?: Tone; dot?: boolean }) {
  return (
    <span className={`pill pill-${tone} t-caption`}>
      {dot && <Icon name={DOT[tone]} />}
      {label}
    </span>
  );
}

/** Figma "Toggle", drawn from its exported on and off states. */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className="toggle"
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <Icon name={on ? "toggle-on" : "toggle-off"} />
    </button>
  );
}

/** Figma "Button": primary (the main action), secondary, ghost and danger. */
export function Button({
  kind = "ghost",
  icon,
  children,
  onClick,
  disabled,
  small,
  type = "button",
}: {
  kind?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  small?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      className={`btn btn-${kind}${small ? " btn-small t-caption" : " t-body-m-strong"}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}
