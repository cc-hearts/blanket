# blanket

English · [中文](README.zh.md)

A personal command library for AI coding agents, built with [Bun](https://bun.sh) and [mise](https://mise.jdx.dev).

| Command | What it does |
| --- | --- |
| `bun run agents` | Detect how each registered agent is installed and upgrade it through that **same** channel (mise / npm / bun / pnpm / Homebrew / native updater) |
| `bun run perm` | TUI for toggling each agent's "full access" / "trust all projects" settings in one pass |

Scripts run with zero runtime dependencies. `bun install` is only needed for type checking (`typescript` + `@types/bun`).

## Why

Most "upgrade all agents" scripts break the thing they manage: they run `npm install -g` on an agent you installed with mise, leave duplicate installs behind, or silently rewrite a `next` release channel to a pinned version.

blanket takes the opposite stance:

- **Scan, don't guess.** The agents to manage live in one registry (`pkg/agents.ts`).
- **Detect the real install.** Each agent's PATH entry is classified as mise, npm, bun, pnpm, Homebrew, native, or unknown.
- **Upgrade in place.** mise installs are upgraded by mise, npm installs by npm, Homebrew installs by `brew upgrade`, native installs by the agent's own updater. Never a different channel.
- **Touch only what wins on PATH.** When several copies coexist, shadowed ones are reported but never modified.
- **When unsure, stop.** Unknown wrappers, unavailable tooling, or an unknown latest version are reported only — never written to.

## Requirements

- [Bun](https://bun.sh) >= 1.1.0 (the only runtime requirement)
- Whatever package managers you already use: mise / npm / bun / pnpm / Homebrew
- Linux or macOS

## Quick start

```bash
git clone https://github.com/cc-hearts/blanket.git
cd blanket
bun run agents:check     # read-only scan; exit 3 if upgrades are available
bun run agents           # upgrade everything through its original channel
bun run perm             # toggle agent permissions in a TUI
```

### Upgrading agents

```bash
bun run agents              # upgrade all registered agents
bun run agents:check        # read-only check; exit 3 when outdated (cron / CI friendly)
bun run agents:dry          # report only, change nothing
bun run agents:json         # read-only JSON output (--json --dry-run)
bun run agents:mise         # also run mise self-update
```

Pass positional filters or options through:

```bash
bun run agents -- codex omp
bun run agents -- claude --dry-run
bun run agents -- --age 24h --no-bump
```

Or run the script directly: `./pkg/update-agents.ts`.

#### Options

| Option | Description |
| --- | --- |
| `-n, --dry-run` | Report only; change nothing |
| `-c, --check` | Read-only check (same as `--dry-run`); exit 3 when upgrades are available |
| `-j, --json` | JSON output with `agent / channel / identity / path / current / target / status / command / note / shadowed` |
| `--bump` / `--no-bump` | mise only: allow rewriting pinned versions in the config (default: bump) |
| `--age <duration>` | mise only: `minimum-release-age`, default `0`; e.g. `24h`, `7d` |
| `--mise` | Also run `mise self-update -y` |
| `--cd <dir>` | mise working directory, default `~` (global config only) |
| `--only a,b` | Only process the named agents |
| `--lenient` | Return exit code 0 even when some agents need manual attention |
| `-h, --help` | Help |

Exit codes: `0` everything OK / nothing to do · `1` an upgrade failed · `2` an agent needs manual attention (unknown channel / mise inactive / channel tool unavailable / latest version unknown) · `3` `--check` found upgrades.

> `--json` does not change whether upgrades run. For read-only JSON use `bun run agents:json` or `bun run agents -- --json --dry-run`.

#### How the channel is chosen

For each agent, the first match on PATH that actually takes effect is classified:

| Channel | Detected by | Upgrade command |
| --- | --- | --- |
| mise | install path / shim / selected tool's `install_path` | `mise upgrade <tool> [--bump] --minimum-release-age <age>` |
| mise named tag | `requested_version` is a tag such as `next` | `mise install <tool>@<tag> --force` (tag preserved) |
| npm | path under `npm root -g` | `npm install -g <pkg>@latest` |
| bun | path under bun's global `node_modules` | `bun add -g <pkg>@latest` |
| pnpm | path under `pnpm root -g` | `pnpm add -g <pkg>@latest` |
| Homebrew | path under the brew prefix | `brew upgrade <formula>` / `brew upgrade --cask <name>` |
| native | a real Mach-O / ELF binary in a known native directory, and the agent has an updater | `claude install latest` / `codex update` / `opencode upgrade` / `pi update self` / `omp update` |
| unknown | anything else | report only — never executed |

Detection order matters: npm global roots can live inside mise's own Node install (`.../mise/installs/node/24/lib/node_modules`), so npm is checked before mise.

Safety rules:

- **Only the PATH-effective install is upgraded.** Other copies are listed as `shadowed` but left alone.
- **Never cross channels.** A mise install never triggers npm; a brew install never triggers mise.
- **Stop when unsure.** Script wrappers, unknown shims, unavailable latest versions, and missing channel tooling are reported, not guessed at.
- **Never downgrade.** Upgrade only when the latest version is newer; a locally newer version is reported as `up-to-date (ahead)`.
- **Never switch release channels.** Named tags such as `next` are refreshed in place with `mise install --force`; `mise upgrade --bump` would rewrite the tag to a concrete version.
- An agent installed by mise but not selected by any mise config is skipped with a hint to run `mise use -g`.
- An agent that is not installed at all is shown as `not installed` and does not affect the exit code.

#### Registered agents

| Agent | Binary | mise tool | npm package | Native updater |
| --- | --- | --- | --- | --- |
| Claude Code | `claude` | `npm:@anthropic-ai/claude-code` | `@anthropic-ai/claude-code` | `claude install latest` |
| Codex | `codex` | `npm:@openai/codex` | `@openai/codex` | `codex update` |
| OpenCode | `opencode` | `npm:@opencode/cli` | `@opencode/cli` | `opencode upgrade` |
| pi | `pi` | `npm:@earendil-works/pi-coding-agent` | `@earendil-works/pi-coding-agent` | `pi update self` |
| omp | `omp` | `github:can1357/oh-my-pi` (alias `npm:@oh-my-pi/pi-coding-agent`) | `@oh-my-pi/pi-coding-agent` | `omp update` |
| DeepSeek Harness | `dsh` | `npm:@deepseek-ai/dsh` | `@deepseek-ai/dsh` | — |

Adding an agent is one row in `AGENTS` in `pkg/agents.ts`; detection, upgrading, and reporting pick it up automatically. Homebrew formulae are resolved dynamically with `brew which-formula`; cask names live in the registry's `brewCask` field. Native installs are only recognized for real binaries inside `nativeDirs`; script wrappers are always treated as `unknown`.

### Toggling permissions

> Every project asks for approval again. `perm` flips each agent's "don't ask again" settings once, across all of them.

```bash
bun run perm                 # TUI: ↑/↓ move · space toggle · a apply · r reload · q quit
```

Non-interactive usage (scripts / CI):

```bash
bun run perm -- --check                    # read-only; exit 3 if anything is not enabled
bun run perm -- --json                     # JSON output
bun run perm -- --on --yes                 # enable everything
bun run perm -- --on --dry-run             # print what would be written
bun run perm -- --on --yes --switch full-access --only claude,codex
bun run perm -- --off --yes                # disable (only reverts values this tool wrote)
```

`--switch` values: `full-access`, `trust-all`. `--only` accepts agent names or ids: `dsh` / `claude` / `codex` / `opencode` / `pi` / `omp`.

Safety design:

- **Two-step interaction.** `space` only stages a change; `a` opens a preview (with a real diff) for confirmation. No one-key direct writes.
- **Real line-level diffs, not line alignment.** Inserting one line does not make every later line show as changed. Distant unchanged lines collapse into `… N unchanged lines …`, so a 2,000-line `.claude.json` only shows the lines that actually change.
- **The confirmation prompt is always visible.** It is pinned to the bottom of the screen and never clipped; long content scrolls with `↑/↓`.
- **Backups before writes** to `~/.blanket/backups/<timestamp>/`; writes are atomic (temp file + rename).
- **Minimal text surgery.** Only the target line changes; comments, anchors, and key order are preserved. A file the parser does not understand is an error, never an overwrite.
- **Idempotent.** Already in the target state? Nothing is written and nothing is backed up.
- **Disabling only reverts what this tool wrote.** Values you set yourself (e.g. a `read-only` preset) are left untouched.
- Round trips "on → off" are verified byte-identical for every agent except `omp` (see below).

#### Per-agent mechanisms

| Agent | Full access | Trust all projects |
| --- | --- | --- |
| DeepSeek Harness | `permission.defaultPreset: danger-full-access` in `~/.dsh/settings.yaml`, applying to **new sessions** | Not applicable: DSH pins permissions per session; there is no per-project grant |
| Claude Code | `permissions.defaultMode: bypassPermissions` in `~/.claude/settings.json` **and** `bypassPermissionsModeAccepted: true` in `~/.claude.json` | `projects.<current dir>.hasTrustDialogAccepted: true` in `~/.claude.json` (no global switch; per directory only) |
| Codex | `approval_policy: "never"` + `sandbox_mode: "danger-full-access"` in `~/.codex/config.toml` | `trust_level = "trusted"` under `[projects."<current dir>"]` (no global switch) |
| OpenCode | top-level `permission: "allow"` in `~/.config/opencode/opencode.json` | Not applicable: there is no project-trust layer |
| pi | Not applicable: pi never asks for approval before tool calls | `defaultProjectTrust: "always"` in `~/.pi/agent/settings.json` (truly global) |
| omp | `tools.approvalMode: yolo` in `~/.omp/agent/config.yml` | Not applicable: omp has no project-trust gate |

Unsupported switches show as `– unsupported` in the TUI with the reason, instead of inventing a key to write.

Pitfalls (all verified on a real machine):

- **Claude Code needs both files.** Writing only `defaultMode` in `settings.json` can be downgraded back to `default`: the binary gates bypass on `bypassPermissionsModeAccepted` in `.claude.json`, and even prints a diagnostic saying "consent was accepted but user settings do not show it … so bypass is not passed on".
- **The widely repeated OpenCode `session.permissions: "autoaccept"` advice is wrong.** The schema silently drops that key. The correct setting is top-level `permission: "allow"` (`opencode debug config` echoes it back as a wildcard allow).
- **The claim that Codex rejects `never` + `danger-full-access` via requirements does not hold here.** That restriction only applies when a managed `requirements.toml` exists; this machine has none, and `codex doctor` reports `config loaded` in a clean `CODEX_HOME`.
- **omp already defaults to `yolo`.** "Disabling" therefore explicitly downgrades to `write` instead of deleting the key — deleting it would mean not disabling at all. This is the only agent whose on→off round trip is not byte-identical.
- **omp uses a strict schema and errors on unknown keys.** It also drops comments when it rewrites `config.yml`, so edit it while omp is not running.

#### `perm` options

| Option | Description |
| --- | --- |
| `--on` / `--off` | Non-interactive enable / disable (TUI when omitted) |
| `--switch a,b` | Only these switches: `full-access`, `trust-all` (default: all) |
| `--only a,b` | Only these agents (name or id, fuzzy matching) |
| `-y, --yes` | Skip confirmation in non-interactive mode |
| `-n, --dry-run` | Print what would be written; do not write |
| `-c, --check` | Read-only; exit 3 when something is not enabled |
| `-j, --json` | JSON output |
| `-h, --help` | Help |

Exit codes: `0` OK · `1` error · `3` `--check` with pending items.

## Development

```bash
bun install      # typescript + @types/bun only
bun run typecheck
bun test         # unit tests for channel detection, planning, and the permission engine
```

Project layout:

```
├── package.json              Bun script entry points
├── scripts/
│   ├── permissions.ts        Permission TUI + non-interactive CLI
│   └── perm/
│       ├── types.ts          Shared vocabulary (switches, plans, results)
│       ├── files.ts          Atomic writes, backups, minimal YAML/JSON surgery
│       ├── diff.ts           Real line-level diff with context folding
│       ├── engine.ts         Orchestration: plan → write
│       ├── tui.ts            Interactive UI
│       ├── registry.ts       Adapter registry
│       └── <agent>.ts        One adapter per agent
├── pkg/                      Shared modules (not scripts)
│   ├── agents.ts             Agent registry (edit this to manage a new agent)
│   ├── mise.ts               mise CLI wrapper (run + parse JSON)
│   ├── versions.ts           Version parsing and comparison
│   ├── ui.ts                 Colors / monospace tables
│   ├── update-agents.ts      Agent upgrade script (bun run agents)
│   └── channels/
│       ├── detect.ts         PATH path → install channel
│       ├── facts.ts          Channel facts, version probing
│       ├── inspect.ts        Per-agent inspection orchestration
│       ├── plan.ts           Upgrade decisions and command construction
│       ├── execute.ts        Run upgrades and verify the result
│       ├── latest.ts         npm registry / brew latest-version lookups
│       └── run.ts            Command execution
├── tests/
│   └── *.test.ts             Unit tests (bun test)
└── tsconfig.json             Editor and type-check configuration
```

The multi-channel design and its safety rules are documented in
[`docs/ryugi/specs/2026-11-10-multi-channel-agent-upgrades-design.md`](docs/ryugi/specs/2026-11-10-multi-channel-agent-upgrades-design.md).

The permission system has its own registry: `scripts/perm/registry.ts`. To add an agent, add a file under `scripts/perm/` that exports an `AgentTarget` and register it. Adapters only read the current state and compute what to write; writing, backups, and atomic file updates are handled centrally by `engine.ts`, so `--dry-run` comes for free and adapters are easy to unit test.

## Notes and caveats

- **`--bump` rewrites `~/.config/mise/config.toml`.** mise's `upgrade` can only move within the configured version range. A pinned entry such as `"npm:@openai/codex" = "0.153.2"` needs `--bump` to reach the latest version, and the version in the config is rewritten too (dry-run tells you which file will change). Pass `--no-bump` to keep pins, or change the config to `latest`.
- **`--age` defaults to `0`.** mise applies a 24h release cooldown (`minimum_release_age`) by default, which delays freshly published versions; this matches `minimum_release_age = "0"` explicitly set for claude-code / opencode. Pass `--age 24h` to keep the cooldown. Note that `mise outdated` does not accept `--minimum-release-age` and can miss the latest version, so this script treats `upgrade --dry-run` as the single source of truth.
- **Old versions are pruned after 24 hours.** During that window `mise ls` shows two entries with `(pruned in 24h)`; this is expected.
- **Your current shell may still run the old version after an upgrade.** mise activation bakes concrete version directories into PATH, and upgrading does not rewrite an already-open shell's PATH. The script reports "reopen your shell or re-activate mise"; use `mise x -- codex` or open a new shell.
- **Named tags are never rewritten to concrete versions.** dsh is pinned to the `next` tag, so upgrades run `mise install npm:@deepseek-ai/dsh@next --force` and leave `next` in the config untouched. `mise upgrade --bump` would turn the tag into a concrete version — a silent channel switch — so the script does not use it.
- **Two kinds of PATH wrappers.** If the wrapper is a symlink, `realpath` resolves to the real install directory and the real channel is used. If it is a script (e.g. a tool-provided shim), it is marked `unknown` and skipped — never guessed at.
- **Native installs are recognized only in explicit directories.** The binary must be a real Mach-O / ELF executable inside `nativeDirs` (typically `~/.local/bin`); a script manually dropped there is not treated as a native install.
- **mise is optional.** Without mise, npm / brew / native installs are still checked and upgraded normally.
- **mise runs in `~` by default**, so only global config is considered. Use `--cd <dir>` to target a repository's local `mise.toml`.
