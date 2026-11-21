// The Mac app (apps/mac) shows this web app in its window and its menu bar panel. When it does, it
// adds a message handler named "covo"; these helpers talk to it. In a plain browser they do nothing.

type Native = { postMessage(m: unknown): void };

function native(): Native | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: { covo?: Native } } }).webkit?.messageHandlers?.covo;
}

export const inMacApp = () => native() !== undefined;

/** Asks the Mac app to show its main window at a screen (e.g. "#/needs-you"). */
export function openInWindow(route: string): boolean {
  const n = native();
  if (!n) return false;
  n.postMessage({ type: "open", route });
  return true;
}

/** Tells the Mac app how tall the menu bar panel's content is. */
export function reportHeight(px: number): void {
  native()?.postMessage({ type: "height", value: Math.ceil(px) });
}

/** Tells the Mac app which theme you chose ("system", "light" or "dark"), so its frame matches. */
export function reportTheme(choice: string): void {
  native()?.postMessage({ type: "theme", value: choice });
}

/** Tells the Mac app which parts of the window frame can be dragged, and which are buttons. */
export function reportDragRegions(): void {
  const n = native();
  if (!n) return;
  const rect = (e: Element) => {
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height];
  };
  const drag = [...document.querySelectorAll(".rail")].map(rect);
  const keep = [...document.querySelectorAll(".rail button")].map(rect);
  n.postMessage({ type: "drag", drag, keep });
}

/**
 * Asks the Mac app to sign this page in again (its sign-in ran out, or Covo's service was reset):
 * it gets a fresh one-time code with its token and reloads the page at `route`.
 */
export function requestSignIn(route: string): boolean {
  const n = native();
  if (!n) return false;
  n.postMessage({ type: "signIn", route });
  return true;
}

/** The app build this page runs ("chunk-ab12cd34.js"), to compare with what the service serves now. */
export function loadedBuild(): string | null {
  const src = document.querySelector('script[type="module"][src*="chunk-"]')?.getAttribute("src") ?? "";
  return src.match(/chunk-[a-z0-9]+\.js/)?.[0] ?? null;
}
