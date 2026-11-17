# Coworker

Open-source AI coworkers that run on your own Mac. Bots work on instant copies of your files, inside the macOS sandbox, using AI models you bring yourself. They ask before anything risky, and only your fingerprint can change their limits.

> **Status:** early development. Phase 1 (the safe runner core) is in progress. Nothing here is ready for real use yet.

## Plan

- [Engineering blueprint](docs/BLUEPRINT.md): architecture, data model and the 6-phase roadmap
- [Phase 1 plan](docs/PHASE1.md): milestones M0–M6 for the sandboxed runner
- [Screen map](design/screen-map.html): every screen in the app and where each button goes

## Development

Requirements: macOS on Apple Silicon, [Bun](https://bun.sh) 1.4+, and optionally [Ollama](https://ollama.com) for free local models.

```bash
bun install
bun run check     # lint + type-check + tests
bun run cw --help
```

| Command             | What it does                            |
| ------------------- | --------------------------------------- |
| `bun test`          | Run the tests                           |
| `bun run lint`      | Check formatting and lint rules (Biome) |
| `bun run format`    | Fix formatting                          |
| `bun run typecheck` | Type-check with TypeScript              |

## Layout

```
apps/cli         the `cw` command
packages/core    shared types, IDs, canonical JSON, data-folder paths
packages/db      SQLite schema, migrations, tamper-evident activity log
```

More packages (`platform`, `sandbox`, `models`, `engine`) arrive with milestones M2–M5.

Try it with a throwaway data folder:

```bash
CW_HOME=/tmp/cw-try bun run cw init
CW_HOME=/tmp/cw-try bun run cw audit verify
```

## License

Apache-2.0. See [LICENSE](LICENSE).
