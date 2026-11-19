// Figma B1 "New bot": a big avatar, its colour and shape, a name, what it helps with, its model and how
// independently it works. Suggestions fill the form in.

import { type ApiBot, AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape, type Level } from "@covo/api";
import { useState } from "react";
import { api } from "../api.ts";
import { type Data, LEVEL_LABEL, type View } from "../model.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { Button } from "./Pill.tsx";

/** The 18 colours of the picker, in the design's order (two rows of nine). */
const PALETTE: AvatarColor[] = [
  "purple",
  "red",
  "orange",
  "gold",
  "lime",
  "mint",
  "teal",
  "sky",
  "blue",
  "navy",
  "indigo",
  "violet",
  "magenta",
  "rose",
  "wine",
  "brown",
  "sand",
  "silver",
];

const TEMPLATES: { name: string; purpose: string; shape: AvatarShape; color: AvatarColor }[] = [
  {
    name: "Inbox helper",
    purpose: "Sorts email, drafts replies in your voice, and chases follow-ups.",
    shape: "Squircle",
    color: "magenta",
  },
  {
    name: "Research assistant",
    purpose: "Reads sources and writes short, linked summaries.",
    shape: "Triangle",
    color: "blue",
  },
  {
    name: "Daily planner",
    purpose: "Turns notes and errands into a plan for the day.",
    shape: "Hexagon",
    color: "gold",
  },
];

const LEVEL_NOTE: Record<Level, string> = {
  supervised: "You review its changes before they reach your files",
  automatic: "Keeps its own work; you can undo it",
  full: "Never asks; stops at its spending limit",
};

export function NewBot({ data, go, refresh }: { data: Data; go: (v: View) => void; refresh: () => void }) {
  const [color, setColor] = useState<AvatarColor>("purple");
  const [shape, setShape] = useState<AvatarShape>("Squircle");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [model, setModel] = useState("");
  const [level, setLevel] = useState<Level>("supervised");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const b = await api<ApiBot>("/bots", {
        method: "POST",
        body: { name, purpose, shape, color, level, ...(model ? { models: [model] } : {}) },
      });
      refresh();
      go({ name: "bot", id: b.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="new-bot-page" aria-label="New bot">
      <form
        className="create-bot"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void create();
        }}
      >
        <Avatar shape={shape} color={color} size={120} />
        {[PALETTE.slice(0, 9), PALETTE.slice(9)].map((row) => (
          <div className="swatches" key={row[0]}>
            {row.map((c) => (
              <button
                type="button"
                key={c}
                className={color === c ? "swatch on" : "swatch"}
                style={{ background: AVATAR_COLORS[c] }}
                aria-label={`Colour: ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        ))}
        <div className="shapes">
          {AVATAR_SHAPES.map((s) => (
            <button
              type="button"
              key={s}
              className={shape === s ? "shape on" : "shape"}
              aria-label={`Shape: ${s}`}
              aria-pressed={shape === s}
              onClick={() => setShape(s)}
            >
              <Avatar shape={s} color={color} size={34} />
            </button>
          ))}
        </div>

        <div className="fields">
          <label className="t-body-m-strong" htmlFor="bot-name">
            Name <span className="danger">*</span>
          </label>
          <input
            id="bot-name"
            className="input t-body-m"
            value={name}
            maxLength={40}
            placeholder="New bot"
            onChange={(e) => setName(e.target.value)}
          />
          <label className="t-body-m-strong" htmlFor="bot-purpose">
            What should this bot help with?
          </label>
          <textarea
            id="bot-purpose"
            className="input area t-body-m"
            value={purpose}
            placeholder="Plan trips, compare options, or help with everyday work."
            onChange={(e) => setPurpose(e.target.value)}
          />
          <label className="select-row">
            <span className="t-body-m secondary">Model</span>
            <span className="grow" />
            <select className="t-body-m" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{data.models.find((m) => m.isDefault)?.name ?? "local"} (your default)</option>
              {data.models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} · {m.engine ? "subscription" : m.model}
                </option>
              ))}
            </select>
            <Icon name="chevron-lg" />
          </label>
          <label className="select-row">
            <span className="t-body-m secondary">Works</span>
            <span className="grow" />
            <select className="t-body-m" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              {(Object.keys(LEVEL_LABEL) as Level[]).map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABEL[l]}: {LEVEL_NOTE[l]}
                </option>
              ))}
            </select>
            <Icon name="chevron-lg" />
          </label>
        </div>
        {error && <p className="t-body-s danger">{error}</p>}
        <Button kind="primary" type="submit" disabled={busy || !name.trim()}>
          Create bot
        </Button>

        <div className="templates">
          <span className="t-body-m muted">Suggestions</span>
          <div className="template-row">
            {TEMPLATES.map((t) => (
              <button
                type="button"
                key={t.name}
                className="template"
                onClick={() => {
                  setName(t.name);
                  setPurpose(t.purpose);
                  setShape(t.shape);
                  setColor(t.color);
                }}
              >
                <Avatar shape={t.shape} color={t.color} size={56} />
                <span className="file-text">
                  <span className="t-title-m">{t.name}</span>
                  <span className="t-body-s muted">{t.purpose}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </form>
    </section>
  );
}
