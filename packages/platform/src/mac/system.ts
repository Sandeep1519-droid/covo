// What this Mac is and how it's doing right now: memory, chip, cores, memory pressure, power and
// heat. Read with Apple's own tools (sysctl, pmset); nothing is installed or changed.

export interface SystemInfo {
  memoryGB: number;
  chip: string;
  performanceCores: number;
  cores: number;
  /** macOS memory pressure: normal, warn (getting tight) or critical. */
  memoryPressure: "normal" | "warn" | "critical" | "unknown";
  power: { source: "ac" | "battery" | "unknown"; percent: number | null };
  /** Heat: "normal", or "warm" when macOS has recorded a thermal or performance warning. */
  thermal: "normal" | "warm" | "unknown";
}

function run(cmd: string[]): string {
  try {
    const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString() : "";
  } catch {
    return "";
  }
}

const sysctl = (name: string) => run(["/usr/sbin/sysctl", "-n", name]).trim();

export function parsePressure(level: string): SystemInfo["memoryPressure"] {
  // kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical
  return level === "1" ? "normal" : level === "2" ? "warn" : level === "4" ? "critical" : "unknown";
}

export function parseBattery(out: string): SystemInfo["power"] {
  const source = /'AC Power'/.test(out) ? "ac" : /'Battery Power'/.test(out) ? "battery" : "unknown";
  const pct = out.match(/(\d{1,3})%/);
  return { source, percent: pct ? Number(pct[1]) : null };
}

export function parseThermal(out: string): SystemInfo["thermal"] {
  if (!out.trim()) return "unknown";
  // Apple Silicon prints "No thermal warning level has been recorded" when all is well; Intel
  // Macs print CPU_Speed_Limit = 100.
  const limit = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  if (limit) return Number(limit[1]) < 100 ? "warm" : "normal";
  const warned = /^(?!.*\bNo\b).*(thermal|performance) warning level/im.test(out);
  return warned ? "warm" : "normal";
}

export function macSystemInfo(): SystemInfo {
  const bytes = Number(sysctl("hw.memsize")) || 0;
  const cores = Number(sysctl("hw.ncpu")) || 0;
  return {
    memoryGB: Math.round(bytes / 1024 ** 3),
    chip: sysctl("machdep.cpu.brand_string") || "unknown",
    performanceCores: Number(sysctl("hw.perflevel0.physicalcpu")) || cores,
    cores,
    memoryPressure: parsePressure(sysctl("kern.memorystatus_vm_pressure_level")),
    power: parseBattery(run(["/usr/bin/pmset", "-g", "batt"])),
    thermal: parseThermal(run(["/usr/bin/pmset", "-g", "therm"])),
  };
}
