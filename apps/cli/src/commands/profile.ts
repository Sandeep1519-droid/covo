import {
  type Capacity,
  capacity,
  type LocalModel,
  PROFILES,
  type ProfileName,
  paramsOf,
  suggestLocalModel,
} from "@covo/engine";
import { DEFAULT_MODEL, getProfileChoice, listOllamaModels, ModelConfigError, setProfileChoice } from "@covo/models";
import { type SystemInfo, systemInfo } from "@covo/platform";
import type { CliResult, Ctx } from "../main.ts";

// covo profile: how Covo sizes itself to this Mac (ADR-011).

export function readSystem(ctx: Ctx): SystemInfo {
  return (ctx.system ?? systemInfo)();
}

/** This Mac's profile (or the one you chose), adjusted for how the Mac is doing right now. */
export function currentCapacity(ctx: Ctx, sys = readSystem(ctx)): Capacity {
  const chosen = getProfileChoice(ctx.home);
  return capacity(sys, chosen && chosen in PROFILES ? (chosen as ProfileName) : undefined);
}

export async function localModels(ctx: Ctx): Promise<LocalModel[] | null> {
  try {
    const list = await (ctx.ollamaModels ?? (() => listOllamaModels(undefined, AbortSignal.timeout(2_000))))();
    return list.map((m) => ({ name: m.name, paramsB: paramsOf(m.name, m.parameterSize) }));
  } catch {
    return null;
  }
}

const power = (s: SystemInfo) =>
  s.power.source === "battery"
    ? `on battery${s.power.percent !== null ? ` (${s.power.percent}%)` : ""}`
    : s.power.source === "ac"
      ? "plugged in"
      : "unknown";

/** Lines describing this Mac and its profile, for `covo profile` and `covo doctor`. */
export async function describeProfile(ctx: Ctx): Promise<{ lines: string[]; cap: Capacity }> {
  const sys = readSystem(ctx);
  const cap = currentCapacity(ctx, sys);
  const p = cap.profile;
  const lines = [
    `  Mac        ${sys.chip}, ${sys.memoryGB} GB memory, ${sys.performanceCores} performance cores of ${sys.cores}`,
    `  Right now  memory ${sys.memoryPressure}, ${power(sys)}, heat ${sys.thermal}`,
    `  Profile    ${p.label}${cap.chosen ? " (chosen by you)" : " (detected)"}`,
    `  Tasks      ${cap.maxRuns} at a time${cap.maxRuns < p.maxRuns ? ` (normally ${p.maxRuns})` : ""}`,
    `  Local AI   models up to about ${p.localParamsB}B parameters, ${p.contextTokens.toLocaleString("en-US")}-token context, unloaded ${p.keepAlive} after use`,
  ];
  for (const n of cap.notes) lines.push(`  Note       ${n}`);
  const models = await localModels(ctx);
  if (models) {
    const s = suggestLocalModel(p, models, DEFAULT_MODEL);
    if (s.best) lines.push(`  Best fit   ${s.best.name} (${s.best.paramsB}B) of the models you have`);
    if (s.tooBig.length) {
      lines.push(
        `  Too big    ${s.tooBig.map((m) => `${m.name} (${m.paramsB}B)`).join(", ")}: likely slow or out of memory here`,
      );
    }
    if (s.roomForBigger && p.localParamsB > 4) {
      lines.push(
        `  Tip        this Mac can run larger local models (up to about ${p.localParamsB}B) for better results`,
      );
    }
  }
  return { lines, cap };
}

export async function profileCommand(ctx: Ctx, args: string[]): Promise<CliResult> {
  const [sub, name] = args;
  try {
    if (sub === "set") {
      const n = name?.toLowerCase();
      if (n === "auto") setProfileChoice(ctx.home, undefined);
      else if (n && n in PROFILES) setProfileChoice(ctx.home, n);
      else return { code: 2, out: `Usage: covo profile set <${Object.keys(PROFILES).join(" | ")} | auto>\n` };
    } else if (sub) {
      return { code: 2, out: "Usage: covo profile [set <profile | auto>]\n" };
    }
    const { lines } = await describeProfile(ctx);
    return {
      code: 0,
      out: [
        "This Mac",
        ...lines,
        "",
        `Choose another profile with: covo profile set <${Object.keys(PROFILES).join(" | ")}>, or "auto" to detect it.`,
        "",
      ].join("\n"),
    };
  } catch (e) {
    if (e instanceof ModelConfigError) return { code: 1, out: `${e.message}\n` };
    throw e;
  }
}
