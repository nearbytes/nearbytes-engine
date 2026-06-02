# AGENT.md — nearbytes-engine

The shared NearBytes **core**. Everything reusable between the terminal shell
(`nearbytes-cli`) and the UI shell (`nearbytes-app`) lives here: the runtime
(skeleton + log + sync), the reactive-volume cache, filesystem watchers, sync
inbound-refresh, and the high-level profile / hub / friend / file / chat
operations. **Both shells MUST reuse this — neither re-implements core logic.**

Out of scope (belongs to the shells): argument parsing, command bookkeeping,
REPL/terminal rendering, Electron/IPC, and UI.

## Read before editing
Follow **[SWE/CODING.md](./SWE/CODING.md)**. Do not invent domain models —
consume `nearbytes-files` / `nearbytes-chat` / `nearbytes-skeleton`.

## Surface
- `createEngineRuntime`, `openAndWatch`, `reloadVolumeFromDisk`, `refreshIfOpen`,
  `closeVolume`, `attachSyncInboundRefresh` — the runtime, ported verbatim from
  the CLI's former `context.ts` so sync behaviour is identical.
- `NearbytesEngine` — high-level operations + an `on(listener)` change stream
  (`status` / `volume` / `chat`). The CLI renders these as text; the app pushes
  them to the renderer.

## Commands
`yarn build` / `yarn type-check` (tsc). `prepare` builds on git install.
