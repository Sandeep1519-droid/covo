import type { SecretStore } from "../index.ts";

// API keys in the macOS login Keychain, through Apple's /usr/bin/security tool.
//
// The key is written to the tool's standard input (`security -i`), never passed as a command-line
// argument, so it doesn't show up in the process list. Items are "generic passwords" under the
// service "Covo Bot", one per saved model connection, named by a random id stored in Covo's config.
// Phase 4 adds a signed helper with Touch ID; until then the login Keychain's own protection applies.

const SECURITY = "/usr/bin/security";
export const KEYCHAIN_SERVICE = "Covo Bot";
const NOT_FOUND = 44;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export class SecretError extends Error {}

function checkId(id: string): void {
  if (!SAFE_ID.test(id)) throw new SecretError(`Invalid secret id: ${id}`);
}

async function run(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([SECURITY, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

export function macKeychain(service = KEYCHAIN_SERVICE): SecretStore {
  return {
    async get(id) {
      checkId(id);
      const r = await run(["find-generic-password", "-s", service, "-a", id, "-w"]);
      if (r.code === NOT_FOUND) return null;
      if (r.code !== 0) throw new SecretError(`Couldn't read from the Keychain: ${r.stderr.trim()}`);
      return r.stdout.replace(/\n$/, "");
    },
    async put(id, value, label) {
      checkId(id);
      // `security -i` splits on spaces and quotes; real API keys never contain these characters.
      if (!value || /["\\\s]/.test(value)) {
        throw new SecretError("That key contains spaces, quotes or backslashes, so it can't be a valid API key.");
      }
      const name = (label ?? id).replace(/["\\\n]/g, "");
      const r = await run(
        ["-i"],
        `add-generic-password -U -s "${service}" -a "${id}" -l "${service}: ${name}" -w "${value}"\n`,
      );
      if (r.code !== 0 || /error/i.test(r.stderr)) {
        throw new SecretError(`Couldn't save to the Keychain: ${r.stderr.trim() || `exit ${r.code}`}`);
      }
    },
    async delete(id) {
      checkId(id);
      const r = await run(["delete-generic-password", "-s", service, "-a", id]);
      if (r.code !== 0 && r.code !== NOT_FOUND) {
        throw new SecretError(`Couldn't remove it from the Keychain: ${r.stderr.trim()}`);
      }
    },
  };
}

/** In-memory store for tests and for systems without a keychain yet. */
export function memorySecrets(initial: Record<string, string> = {}): SecretStore & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    items,
    async get(id) {
      return items.get(id) ?? null;
    },
    async put(id, value) {
      items.set(id, value);
    },
    async delete(id) {
      items.delete(id);
    },
  };
}
