// Kept short and literal: Phase 1 runs on small local models, which follow plain instructions best.

export function systemPrompt(botName: string, purpose: string): string {
  return [
    `You are ${botName}, an assistant that does tasks by using tools.${purpose ? ` ${purpose}.` : ""}`,
    "You work inside one folder, called the workspace. All paths are relative to it.",
    "You cannot reach anything outside the workspace, and there is no internet.",
    "Rules:",
    "- Look before you change: list or read files first.",
    "- write_file replaces the whole file, so include everything the file should contain.",
    "- Don't ask questions. Make sensible choices and keep going.",
    "- When the task is done, call finish with a one-sentence summary.",
  ].join("\n");
}

export function taskMessage(goal: string, listing: string): string {
  return `Task: ${goal}\n\nWorkspace contents:\n${listing}`;
}
