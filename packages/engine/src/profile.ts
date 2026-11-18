import type { SystemInfo } from "@covo/platform";

// Power profiles (ADR-011): Covo sizes itself to the Mac it runs on. A profile sets how many tasks
// may run at once, how large a local model the Mac can comfortably hold, how much conversation a
// local model sees (context), and how long a local model stays in memory after use. Conditions
// right now (memory pressure, a low battery, heat) can lower the number of tasks, or pause new
// ones. Cloud models do their thinking elsewhere, so for them the limits are mostly about tools
// and spending.

export type ProfileName = "8gb" | "16gb" | "32gb" | "48gb" | "64gb";

export interface Profile {
  name: ProfileName;
  label: string;
  /** Tasks that may run at the same time. */
  maxRuns: number;
  /** Largest local model that fits comfortably, in billions of parameters (4-bit). */
  localParamsB: number;
  /** Context window for local models, in tokens. */
  contextTokens: number;
  /** How long Ollama keeps a model loaded after use. */
  keepAlive: string;
}

export const PROFILES: Record<ProfileName, Profile> = {
  "8gb": { name: "8gb", label: "8 GB", maxRuns: 1, localParamsB: 4, contextTokens: 8_192, keepAlive: "60s" },
  "16gb": { name: "16gb", label: "16 GB", maxRuns: 2, localParamsB: 8, contextTokens: 32_768, keepAlive: "5m" },
  "32gb": { name: "32gb", label: "32 GB", maxRuns: 3, localParamsB: 30, contextTokens: 65_536, keepAlive: "10m" },
  "48gb": { name: "48gb", label: "48 GB", maxRuns: 4, localParamsB: 32, contextTokens: 65_536, keepAlive: "10m" },
  "64gb": {
    name: "64gb",
    label: "64 GB or more",
    maxRuns: 6,
    localParamsB: 70,
    contextTokens: 131_072,
    keepAlive: "30m",
  },
};

export function profileForMemory(gb: number): Profile {
  if (gb < 12) return PROFILES["8gb"];
  if (gb < 24) return PROFILES["16gb"];
  if (gb < 40) return PROFILES["32gb"];
  if (gb < 56) return PROFILES["48gb"];
  return PROFILES["64gb"];
}

export interface Capacity {
  profile: Profile;
  /** Chosen by you (covo profile set) rather than detected. */
  chosen: boolean;
  /** Tasks allowed at once right now, after conditions. */
  maxRuns: number;
  /** False when a new task shouldn't start at all right now. */
  canStart: boolean;
  /** Plain-language reasons for any slowdown. */
  notes: string[];
}

const LOW_BATTERY = 20;

/** The profile for this Mac (or the one you chose), adjusted for how the Mac is doing right now. */
export function capacity(sys: SystemInfo, chosen?: ProfileName): Capacity {
  const profile = chosen ? PROFILES[chosen] : profileForMemory(sys.memoryGB);
  let maxRuns = profile.maxRuns;
  let canStart = true;
  const notes: string[] = [];
  if (sys.memoryPressure === "critical") {
    canStart = false;
    notes.push("macOS reports memory is critically low. Close some apps, then try again.");
  } else if (sys.memoryPressure === "warn" && maxRuns > 1) {
    maxRuns = 1;
    notes.push("Memory is getting tight, so only one task runs at a time for now.");
  }
  if (sys.power.source === "battery" && sys.power.percent !== null && sys.power.percent < LOW_BATTERY && maxRuns > 1) {
    maxRuns = 1;
    notes.push(`On battery at ${sys.power.percent}%, so only one task runs at a time.`);
  }
  if (sys.thermal === "warm" && maxRuns > 1) {
    maxRuns = 1;
    notes.push("The Mac is running hot, so only one task runs at a time until it cools.");
  }
  return { profile, chosen: chosen !== undefined, maxRuns, canStart, notes };
}

export interface LocalModel {
  name: string;
  /** Billions of parameters, if known. */
  paramsB: number | null;
}

/** Billions of parameters from Ollama's "4.0B" or a name like "qwen3.5:4b". */
export function paramsOf(name: string, parameterSize?: string): number | null {
  const fromSize = parameterSize?.match(/([\d.]+)\s*B/i);
  if (fromSize) return Number(fromSize[1]);
  const fromName = name.match(/[:\-_](\d+(?:\.\d+)?)b\b/i);
  return fromName ? Number(fromName[1]) : null;
}

/** The largest installed local model that fits this profile, and whether a bigger one would. */
export function suggestLocalModel(
  profile: Profile,
  installed: LocalModel[],
  /** Wins a tie (Covo's recommended local model). */
  prefer?: string,
): { best: LocalModel | null; tooBig: LocalModel[]; roomForBigger: boolean } {
  const known = installed.filter((m) => m.paramsB !== null) as (LocalModel & { paramsB: number })[];
  const fits = known
    .filter((m) => m.paramsB <= profile.localParamsB)
    .sort((a, b) => b.paramsB - a.paramsB || Number(b.name === prefer) - Number(a.name === prefer));
  const best = fits[0] ?? null;
  return {
    best,
    tooBig: known.filter((m) => m.paramsB > profile.localParamsB),
    roomForBigger: best === null || best.paramsB < profile.localParamsB * 0.6,
  };
}
