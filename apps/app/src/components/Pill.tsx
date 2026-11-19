import { Icon } from "./Icon.tsx";

/** Figma "Pill": a status chip. Neutral or Warning, with or without the dot. */
export function Pill({
  label,
  tone = "neutral",
  dot = true,
}: {
  label: string;
  tone?: "neutral" | "warning";
  dot?: boolean;
}) {
  return (
    <span className={`pill pill-${tone} t-caption`}>
      {dot && <Icon name={tone === "warning" ? "dot-warning" : "dot"} />}
      {label}
    </span>
  );
}
