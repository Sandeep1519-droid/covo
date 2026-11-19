import type { View } from "../model.ts";
import { Icon } from "./Icon.tsx";

/** Figma "App rail": Home (chats), Needs you, Library, More, Settings. */
export function Rail({ view, waiting, go }: { view: View; waiting: number; go: (v: View) => void }) {
  const item = (on: boolean, label: string, onClick: () => void, child: React.ReactNode) => (
    <button
      type="button"
      className={on ? "rail-item on" : "rail-item"}
      aria-label={label}
      aria-current={on ? "page" : undefined}
      title={label}
      onClick={onClick}
    >
      {child}
    </button>
  );
  return (
    <nav className="rail" aria-label="Covo">
      {item(view.name === "bot", "Home", () => go({ name: "bot", id: "" }), <Icon name="home" />)}
      {item(
        view.name === "needs-you",
        waiting ? `Needs you (${waiting})` : "Needs you",
        () => go({ name: "needs-you" }),
        <Icon name="rail-needs-you" className={waiting ? "rail-needs-you" : "rail-needs-you no-badge"} />,
      )}
      {item(view.name === "library", "Library", () => go({ name: "library" }), <Icon name="book" />)}
      {item(view.name === "more", "More", () => go({ name: "more" }), <Icon name="more" />)}
      <span className="grow" />
      {item(view.name === "settings", "Settings", () => go({ name: "settings" }), <Icon name="sliders" />)}
    </nav>
  );
}
