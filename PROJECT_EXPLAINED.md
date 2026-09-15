# Cline - MaStar Edition — Project Explained for a Newbie Techie

> One-page brain map: what Cline is, how folders fit, how a prompt becomes file edits.

## 1. What is Cline in one sentence?

**Cline is an open-source AI coding agent** — you give it a goal ("add login with tests"),
it plans, reads/writes files, runs terminal commands, browses, and asks before risky steps.

Same "brain" runs everywhere:

| You use it as... | Where that lives | Install / run |
|---|---|---|
| VS Code extension (sidebar chat) | `apps/vscode/` | VS Marketplace "Cline" |
| Terminal (interactive or headless/CI) | `apps/cli/` | `npm i -g cline` or `bun run cli` |
| Desktop app (Tauri + Next.js + Bun) | `apps/examples/desktop-app/` | GitHub releases |
| Your own app/bot (Slack, Telegram) | `sdk/` | `npm install @cline/sdk` |

Think: **one engine (SDK), many bodies (apps).**

## 2. Repo map — top level

```
cline_MaStar/            <- monorepo root (Bun workspaces)
|-- sdk/                 <- THE ENGINE. All reusable logic.
|   └── packages/
|       |-- shared/      <- types, schemas, tool contracts, hooks, paths
|       |-- llms/        <- talks to AI models (Anthropic, OpenAI, Gemini...)
|       |-- agents/      <- the loop: prompt -> model -> tool -> repeat
|       |-- core/        <- manager: sessions, storage, tools, hub daemon
|       |-- sdk/         <- pretty wrapper: import { Agent } from "@cline/sdk"
|       └── ui/          <- shared UI bits
|-- apps/
|   |-- vscode/          <- VS Code extension (sidebar + React webview + gRPC)
|   |-- cli/             <- terminal UI, headless mode, `cline` commands
|   |-- cline-hub/       <- background daemon: schedules, teams, connectors
|   └── examples/        <- desktop-app (Tauri), plugin examples
|-- docs/                <- user docs site (docs.cline.bot)
|-- evals/               <- quality benchmarks
|-- package.json         <- root scripts (Bun!), workspaces list
|-- AGENTS.md            <- contributor survival guide
└── bun.lock             <- THE lockfile (only Bun, no npm/yarn)
```

**Golden rule:** `sdk/` = reusable, host-agnostic. `apps/` = host-specific UX
(VS Code APIs, terminal rendering, Tauri window). Never put VS Code imports in `sdk/`.

## 3. The layered cake (dependencies point DOWN only)

```
Host Apps (vscode / cli / desktop / your code)
   │ uses
@cline/core   stateful: sessions, storage, config, plugins, hub
   │ uses
@cline/agents stateless: iteration loop, tool orchestration, streaming
   │ uses
@cline/llms   provider gateway: model catalogs, API handlers
   │ uses
@cline/shared foundation: types, schemas, paths, hooks, tool helpers
```

`shared` never imports `core`. This keeps the engine embeddable anywhere.

## 4. What each SDK package does

- **`@cline/shared`** — the dictionary. Types, Zod schemas, `createTool` helper,
  hook engine, MCP types, storage-path helpers (`~/.cline/...`). No network/sessions.
- **`@cline/llms`** — the translators. Every provider (Anthropic, OpenAI, Gemini,
  Bedrock, Mistral, OpenRouter, Ollama/LM Studio, any OpenAI-compatible).
  Model catalogs + handler creation. Provider hacks live ONLY here.
- **`@cline/agents`** — the hamster wheel. `agent-runtime.ts`: build messages,
  call model, stream, execute tool, feed result, repeat. Holds NOTHING on disk.
- **`@cline/core`** — the adult. Sessions (`ClineCore.ts`, `src/session/`), default
  tools, config watching, plugins/hooks, cron (`src/cron/`, Markdown in
  `~/.cline/cron/` to SQLite queue), hub daemon (`src/hub/`), telemetry.
- **`@cline/sdk`** — the front door. Re-exports all: `new Agent({...}).run("...")`.

## 5. How a prompt becomes code

```
You type "fix failing tests"
  -> Host App (webview / CLI TUI) sends prompt to core
  -> core/ClineCore loads session + config + tools + plugins
  -> agents loop -> llms provider -> Claude/GPT streams back
  -> "call readFile(...)" -> execute -> feed result -> loop again
  -> tools (edit file? run `bun test`? ask MCP?) + approval gate
  -> files changed, answer streamed, session saved to disk
```

Safety nets: **approval gates** (you approve risky actions) + **checkpoints**
(Git snapshots to undo).

## 6. Apps in brief

- **`apps/vscode/`**: `src/extension.ts` entry, WebviewProvider -> Controller ->
  Task chain. `webview-ui/` = React sidebar. `proto/cline/*.proto` = gRPC contract
  (`bun run protos` regenerates `src/generated/`). Build: `build:webview` + esbuild.
- **`apps/cli/`**: same engine, terminal face. `bun run cli -i`, `cline "do X"`,
  `--json` for CI, `cline mcp/schedule/connect` subs.
- **`apps/cline-hub/`**: always-on daemon. Schedules, teams, chat connectors
  (each thread = agent session) over WebSocket.
- **`apps/examples/desktop-app/`**: Tauri Rust window + Next.js UI + Bun sidecar.

## 7. Glossary

| Word | Means | Look in |
|---|---|---|
| Agent | loop calling LLM + tools until done | `sdk/packages/agents/src/agent-runtime.ts` |
| Session | one conversation, saved, resumable | `sdk/packages/core/src/session/` |
| Tool | function AI can call; write with `createTool` | `sdk/packages/shared/src/tools/` |
| Provider | AI backend + model | `sdk/packages/llms/` |
| MCP | plugin protocol for DB/API/cloud powers | `docs/mcp/` |
| Plugin/Hook | your code at lifecycle points | `sdk/packages/core/src/extensions/` |
| Hub | background daemon | `sdk/packages/core/src/hub/` |
| Storage | JSON under `~/.cline/data/` | `sdk/packages/shared/src/storage/` |
| Plan vs Act | Plan = talk, Act = do | vscode `src/core/` |

## 8. Toolchain

- **Bun 1.3.13** = install/run (`bun install`, `bun run X`, `bunx`). Never npm/npx.
- **Node >=22** = runtime (extension host). `platform:"node"`, `node:` imports
  are CORRECT, don't "fix" to Bun.
- After editing SDK source: `bun run build:sdk` before testing apps
  (siblings resolve via `dist/`). Restart running processes.
- Lint: Biome (`bun run check`). Tests: `bun:test` -> `bun test`,
  `mocha` -> VS Code host. Never mix in one file.

## 9. Where to start

```bash
bun install --frozen-lockfile
bun run build:sdk
bun run cli -i    # needs ANTHROPIC_API_KEY etc.
bun run cli doctor
```

Read order: `README.md` -> `sdk/README.md` -> `sdk/ARCHITECTURE.md` ->
`agent-runtime.ts` -> `ClineCore.ts`.

> Mental model: Cline = chat UI + agent loop + tools + memory.
> Lost? Ask "UI, loop, memory, or model-talk?" That tells you which folder to open.
