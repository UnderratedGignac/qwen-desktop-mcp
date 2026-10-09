# Spec: auto-compact + subagents for Qwen Desktop

Status: draft, 2026-10-09. Builds on the context guard (`src/shared/context-guard.js`).

## Decisions (from the user)

- **Auto-compact is fully automatic.** When a task runs out of context, the work continues in a new chat
  without the user pressing anything.
- **Subagents run through the user's logged-in chat.qwen.ai session inside the app**, not through API keys.
  They share that account's chat quota.
- **Out of scope:** rotating between several Qwen accounts to get around per-account quotas. It breaks the
  provider's terms and risks bans on every account involved. A provider-failover router over the official
  APIs (DashScope → NVIDIA NIM → OpenRouter, keys the user owns) can be added later as a separate spec.

## 1. Auto-compact ("never lose work")

The trigger is any of:

- the guard reaches `stop` (the turn budget is exhausted and the model has been told to write a handover
  summary);
- a completion fails with a `context` error while a task is running. (Merely *opening* an old broken
  chat only shows the banner with the manual button, so browsing history never spawns chats.)
- a completion fails with `internal_error` **after** at least one tool ran in this turn.

What happens:

1. Wait for the current answer stream to finish (for `stop`, that answer is the model's own summary).
2. Build the handover from `buildHandover(chat)` plus the model's final answer, when there is one.
3. Open a new chat, put in the handover, and **send it automatically**.
4. A banner in the new chat says "Continued from <old title>" and links the old chat.

Safety:

- The handover carries a hop counter. Auto-compact stops after **3 hops without user input** and falls
  back to the banner and a manual button.
- Nothing runs while a stream or tool call is still active.

Testable core (pure, in `context-guard.js`):

- `shouldAutoCompact(event, state)`
- `buildHandover(chat, { summary, hop })`
- hop parsing and limit

## 2. Subagents

A built-in MCP server **`Subagents`**, served in-process by the main process, exposes these tools:

- `run_subagent({ task, context?, allow_tools? = ["Filesystem", "Terminal"] })`
  → `{ report, chat_id, tool_calls, ok }`
- `run_subagents({ tasks: [...] })`: runs several in parallel, capped at 3 at a time.

Execution (main process → the chat page via `executeJavaScript`, so cookies and the page's own request
signing apply):

1. `POST /api/v2/chats/new`, title `[subagent] <task, first 40 chars>`.
2. `POST /api/v2/chat/completions` with the task, a subagent system preamble ("work autonomously, keep tool
   output small, end with a short report"), and the allowed tools in `feature_config.local_mcp`.
3. Parse the SSE stream. For `local_tool` phases, run the calls through `McpManager.callTool` (results
   capped), send the `function` follow-up, and repeat.
4. Return the final answer, capped at 8,000 characters, plus metadata.

Limits:

- 40 tool calls or 10 minutes per subagent;
- the same turn budget as the main chat;
- subagents cannot spawn subagents.

Errors: a stuck chat gets the stop-and-retry release once. Quota or rate-limit errors return
`ok: false` with the server's message, and the parent model decides what to do.

Test plan:

- SSE parser and loop driver as pure functions, with unit tests on captured fixtures;
- one live end-to-end test: a subagent counts the files in a folder, and the parent sees only the report.

## Open protocol questions (to resolve from a live capture)

- Exact SSE events for a tool call (phase, status, `extra.local_mcp` shape, `response_id`).
- Which fields the `function` follow-up needs (`parent_id`, `fid`, `chat_type`, `model`...).
- `/api/v2/chats/new` response and required fields.
