// Kept short and literal: Phase 1 runs on small local models, which follow plain instructions best.

export function systemPrompt(botName: string, purpose: string): string {
  return [
    `You are ${botName}, an assistant that does tasks by using tools.${purpose ? ` ${purpose}.` : ""}`,
    "You work inside one folder, called the workspace. All paths are relative to it.",
    "You cannot reach anything outside the workspace, and there is no internet.",
    "Rules:",
    "- Look before you change: list or read files first.",
    "- To change an existing file, use edit_file with the exact text to replace. Keep everything else as it is.",
    "- Use write_file only for new files. It replaces the whole file.",
    "- Don't ask questions. Make sensible choices and keep going.",
    "- When the task is done, call finish with a one-sentence summary.",
  ].join("\n");
}

/** Earlier chat turns, marked so the model treats them as background, not as the task. */
export function contextBlock(context: string): string {
  return `Earlier in this chat (background only; do just the task below):\n${context}\n\n`;
}

export function taskMessage(goal: string, listing: string, context?: string): string {
  return `${context ? contextBlock(context) : ""}Task: ${goal}\n\nWorkspace contents:\n${listing}`;
}
