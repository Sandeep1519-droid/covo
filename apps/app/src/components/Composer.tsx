import type { ApiModelGroup } from "@covo/api";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Pill } from "./Pill.tsx";
import { LATER } from "./Sidebar.tsx";

/** Where a model comes from, in a word or two, for the picker's button. */
function shortSource(g: ApiModelGroup): string {
  if (g.subscription === "codex") return "Codex";
  if (g.subscription === "claude-code") return "Claude Code";
  if (g.subscription === "chatgpt") return "ChatGPT plan";
  if (g.connection === "local" || g.label.startsWith("On this Mac")) return "on this Mac";
  return g.connection;
}

/** Figma "Composer": the message box at the bottom of every chat, with the section tab and model picker. */
export function Composer({
  botName,
  section,
  level,
  groups,
  pick,
  onPick,
  text,
  onText,
  onSend,
  busy,
}: {
  botName: string;
  section: string;
  level: string;
  /** Every model you can pick, grouped by where it comes from (GET /api/model-choices). */
  groups: ApiModelGroup[];
  /** The picked model for the next message: its group and option. */
  pick: { group: ApiModelGroup; option: ApiModelGroup["options"][number] } | undefined;
  onPick: (value: string) => void;
  text: string;
  onText: (t: string) => void;
  onSend: () => void;
  busy: boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!text) {
      el.style.height = ""; // one row
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  // With no saved model, tasks use the local model (Ollama), as on the command line.
  const canSend = text.trim().length > 0 && !busy;

  return (
    <div className="composer">
      <div className="composer-tab-row">
        <div className="composer-tab t-body-s">
          <Icon name="folder" />
          {section}
          <Icon name="chevron" />
        </div>
      </div>
      <form
        className="composer-box"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSend();
        }}
      >
        <textarea
          ref={box}
          className="composer-input t-body-m"
          rows={1}
          placeholder={`Message ${botName}…`}
          aria-label={`Message ${botName}`}
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <div className="composer-tools">
          <span className="icon-btn" title={`Attach files: ${LATER}`}>
            <Icon name="plus" />
          </span>
          <Pill label={level} dot={false} />
          <span className="grow" />
          {pick?.group.subscription === "chatgpt" && (
            // OpenAI's rule for Sign in with ChatGPT: say it near the model picker, with a way to manage usage.
            <span className="plan-note t-caption muted">
              Using ChatGPT plan ·{" "}
              <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">
                Manage usage
              </a>
            </span>
          )}
          <div className="model-picker" ref={menu}>
            <button
              type="button"
              className="model-button t-body-s"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              disabled={groups.length === 0}
            >
              {pick ? (
                <>
                  <span>{pick.option.label}</span>
                  <span className="muted">{shortSource(pick.group)}</span>
                </>
              ) : (
                <>
                  <span>local</span>
                  <span className="muted">Ollama</span>
                </>
              )}
              <Icon name="chevron" />
            </button>
            {open && (
              <div className="menu menu-wide" role="listbox" aria-label="Model for this message">
                {groups.map((g) => (
                  <fieldset key={g.connection} className="menu-group" aria-label={g.label}>
                    <span className="menu-heading t-overline muted">
                      {g.label}
                      {g.isDefault ? " · default" : ""}
                    </span>
                    {g.options.map((o) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={o.value === pick?.option.value}
                        key={o.value}
                        className="menu-item menu-row"
                        onClick={() => {
                          onPick(o.value);
                          setOpen(false);
                        }}
                      >
                        <span className="t-body-m">{o.label}</span>
                        {o.current && <span className="t-caption muted">its usual</span>}
                      </button>
                    ))}
                  </fieldset>
                ))}
              </div>
            )}
          </div>
          <span className="icon-btn" title={`Voice: ${LATER}`}>
            <Icon name="mic" />
          </span>
          <button type="submit" className="send" aria-label="Send" disabled={!canSend}>
            <Icon name="send" />
          </button>
        </div>
      </form>
    </div>
  );
}
