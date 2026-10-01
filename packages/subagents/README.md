# pisuite-subagents

Delegate arbitrary tasks to workers with fresh conversations. The calling agent supplies instructions and can select a model for each task. No agent Markdown files or role presets are needed. Requires Pi 0.99.1 or newer.

## Install

```sh
pi install npm:pisuite-subagents
```

Restart Pi or run `/reload`. Alternatively, install `npm:pisuite-setup`, restart Pi, run `/pisuite-setup`, then `/reload`. Rerun setup after updating the suite to install newly added packages.

The npm commands require publication. For local development, run `pi -e ./packages/subagents` from the repository root.

## Use

Ask the main agent to delegate, for example:

```text
Use two workers to audit the current changes. Have one check correctness
and the other check unnecessary complexity. Return findings without editing.
```

The extension adds three model-callable tools:

- `spawn_worker`: accepts `task`, optional `model`, optional `thinking`, and optional `background`. Foreground is the default and returns the final result. `background: true` returns a worker ID immediately; completion or failure delivers a message to the main agent and requests a follow-up turn, including when it is idle.
- `worker_status`: omit `id` to list workers, or provide an ID to retrieve its current status and result. Add `wait: true` to wait for that worker to settle.
- `stop_worker`: provide an ID to cancel that worker and its descendants. Omit the ID to cancel all workers.

Model names can be `provider/model-id` or an unambiguous model ID from the host's configured catalogue. Omission inherits the calling agent's model and thinking level. Workers use the host's credentials and providers; no separate authentication is needed.

Workers can spawn workers. All workers and descendants share four slots, excluding the main agent. A spawn fails immediately when all slots are occupied; the caller can wait for a worker to finish and retry. Waiting workers still occupy their slots, so the extension never queues additional spawns behind them.

When Pi uses sequential tool execution, call foreground `spawn_worker` and `worker_status(wait: true)` directly. Inside `codemode` or a custom tool, use `background: true` and return without waiting; completion triggers a follow-up automatically. Those enclosing calls can hold Pi's serial tool queue while waiting, blocking calls that other workers need to finish. Polling status without `wait` is also safe.

Run `/workers` to see status or `/workers stop [worker-id]` to cancel work yourself. In the terminal, Escape or Ctrl+C stops all workers, including background work. Cancelling an active main-agent run also cancels every worker. Pi's SDK/RPC abort does not emit a signal when the main agent is idle; use `stop_worker` for idle background work in those interfaces. Cancelled workers do not deliver completion messages. Closing Pi, switching sessions, or reloading the extension cancels the session's workers; workers are not restored after restart.

## Access and configuration

Workers use Pi's agent loop inside the host process. They receive the effective system prompt, including project instructions and skill descriptions, but no conversation history. The task must include any decisions or requirements from the conversation that matter to the worker.

Workers share the host's working directory and files. They may edit or run commands, with no role-based restrictions. Worker calls use the host's callable tools through `executeTool`, preserving validation, extension hooks, and permission checks, including configured MCP tools. Pi tools marked `model-only`, including `codemode` and `tool_search`, cannot be called through that API; workers receive the underlying callable tools directly. For nested foreground spawns and waits, the host's result hook observes the initial status. Waiting happens after releasing the host's serial tool queue so children can finish their own calls.

The main agent is responsible for assigning file scopes and resolving concurrent edits. There are no worktrees or automatic merges. Cancellation is cooperative, as in the main Pi agent: a tool or provider must honor its abort signal. Workers do not have session-level automatic compaction or recovery; provider failures are reported to the caller.

The footer shows the active worker count. Results include token and cost totals. Foreground results and background messages are capped at 50,000 characters; `worker_status` retrieves the complete output.

No package-specific configuration is required. In `pi config`, disable the package's single `index.ts` entry, then `/reload`. This disables all worker tools, the `/workers` command, status updates, and completion delivery together.

## Verification and release

Run `npm test --workspace pisuite-subagents` and `npm run typecheck` from the repository root. Tests cover model selection and virtual routing, fresh context, foreground and background execution, nested delegation, the shared limit, cancellation, real Pi tool permission hooks, serial execution, idle completion delivery, and the package toggle.

Publish this package before the setup version that lists it. Versions are independent.
