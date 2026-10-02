# pisuite-subagents

Delegate arbitrary tasks to subagents with fresh conversations. The calling agent supplies instructions and can select a model for each task. No agent Markdown files or role presets are needed. Requires Pi 0.99.1 or newer.

## Install

```sh
pi install npm:pisuite-subagents
```

Restart Pi or run `/reload`. Alternatively, install `npm:pisuite-setup`, restart Pi, run `/pisuite-setup`, then `/reload`. Rerun setup after updating the suite to install newly added packages.

The npm commands require publication. For local development, run `pi -e ./packages/subagents` from the repository root.

## Use

Ask the main agent to delegate, for example:

```text
Use two subagents to audit the current changes. Have one check correctness
and the other check unnecessary complexity. Return findings without editing.
```

The extension adds three model-callable tools:

- `spawn_subagent`: accepts `task`, optional `model`, optional `thinking`, and optional `background`. Foreground is the default and returns the final result. `background: true` returns a subagent ID immediately; completion or failure delivers a message to the main agent and requests a follow-up turn, including when it is idle.
- `subagent_status`: omit `id` to list subagents, or provide an ID to retrieve its current status and result. Add `wait: true` to wait for that subagent to settle.
- `stop_subagent`: provide an ID to cancel that subagent and its descendants. Omit the ID to cancel all subagents.

Model names can be `provider/model-id` or an unambiguous model ID from the host's configured catalogue. Omission inherits the calling agent's model and thinking level. Subagents use the host's credentials and providers; no separate authentication is needed.

Subagents can spawn subagents. All subagents and descendants share four slots, excluding the main agent. A spawn fails immediately when all slots are occupied; the caller can wait for a subagent to finish and retry. Waiting subagents still occupy their slots, so the extension never queues additional spawns behind them.

When Pi uses sequential tool execution, call foreground `spawn_subagent` and `subagent_status(wait: true)` directly. Inside `codemode` or a custom tool, use `background: true` and return without waiting; completion triggers a follow-up automatically. Those enclosing calls can hold Pi's serial tool queue while waiting, blocking calls that other subagents need to finish. Polling status without `wait` is also safe.

Run `/subagents` to see status or `/subagents stop [subagent-id]` to cancel work yourself. In the terminal, Escape or Ctrl+C stops all subagents, including background work. Cancelling an active main-agent run also cancels every subagent. Pi's SDK/RPC abort does not emit a signal when the main agent is idle; use `stop_subagent` for idle background work in those interfaces. Cancelled subagents do not deliver completion messages. Closing Pi, switching sessions, or reloading the extension cancels the session's subagents; subagents are not restored after restart.

## Access and configuration

Subagents use Pi's agent loop inside the host process. They receive the effective system prompt, including project instructions and skill descriptions, but no conversation history. The task must include any decisions or requirements from the conversation that matter to the subagent.

Subagents share the host's working directory and files. They may edit or run commands, with no role-based restrictions. Subagent calls use the host's callable tools through `executeTool`, preserving validation, extension hooks, and permission checks, including configured MCP tools. Pi tools marked `model-only`, including `codemode` and `tool_search`, cannot be called through that API; subagents receive the underlying callable tools directly. Nested foreground spawns and waits release the host's serial tool queue before waiting, so other subagents can finish their tools. The original call's result hook sees the initial status. The bridge then retrieves the final result through `subagent_status`, applying its permission and result hooks. Extensions that filter nested tool results should cover `subagent_status` as well as `spawn_subagent`.

The main agent is responsible for assigning file scopes and resolving concurrent edits. There are no worktrees or automatic merges. Cancellation is cooperative, as in the main Pi agent: a tool or provider must honor its abort signal. Subagents do not have session-level automatic compaction or recovery; provider failures are reported to the caller.

Pi 0.99.2 reserves 4,096 tokens when budgeting model output. An 8K model with a large host prompt or tool list can therefore truncate replies and background follow-ups. Use a larger context window, shorten the host prompt, or enable fewer tools.

The footer shows the active subagent count. Results include each subagent's token and cost totals. Main-agent subagent tool calls also report new model usage to Pi's session totals, including descendants. Background completion messages cannot report session usage through Pi's message API; that usage is included the next time the main agent calls a subagent tool. Subagent output in foreground results and background messages is capped at 50,000 characters; `subagent_status` retrieves the complete output.

No package-specific configuration is required. In `pi config`, disable the package's single `index.ts` entry, then `/reload`. This disables all subagent tools, the `/subagents` command, status updates, and completion delivery together.

## Verification and release

Run `npm test --workspace pisuite-subagents` and `npm run typecheck` from the repository root. Tests cover model selection and virtual routing, fresh context, foreground and background execution, nested delegation, the shared limit, cancellation, real Pi tool permission hooks, serial execution, idle completion delivery, and the package toggle.

Publish this package before the setup version that lists it. Versions are independent.
