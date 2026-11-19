import type { ApiModel } from "@covo/api";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { Pill } from "./Pill.tsx";
import { LATER } from "./Sidebar.tsx";

/** Figma "Composer": the message box at the bottom of every chat, with the section tab and model picker. */
export function Composer({
  botName,
  section,
  level,
  models,
  model,
  onModel,
  text,
  onText,
  onSend,
  busy,
}: {
  botName: string;
  section: string;
  level: string;
  models: ApiModel[];
  model: ApiModel | undefined;
  onModel: (name: string) => void;
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
          <div className="model-picker" ref={menu}>
            <button
              type="button"
              className="model-button t-body-s"
              aria-haspopup="listbox"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              disabled={models.length === 0}
            >
              {model ? (
                <>
                  <span>{model.name}</span>
                  <span className="muted">{model.engine ? "subscription" : model.model}</span>
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
              <div className="menu" role="listbox" aria-label="Model for this message">
                {models.map((m) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={m.name === model?.name}
                    key={m.name}
                    className="menu-item"
                    onClick={() => {
                      onModel(m.name);
                      setOpen(false);
                    }}
                  >
                    <span className="t-body-m">{m.name}</span>
                    <span className="t-caption muted">
                      {m.providerLabel} · {m.model}
                      {m.isDefault ? " · default" : ""}
                    </span>
                  </button>
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
