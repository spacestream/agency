# Agency — Project Specification

## Overview

Agency is a web-based coding agent that generates and modifies standalone software projects through a chat interface. The user describes what they want built, and the agent reads, writes, and deletes files, runs shell commands, and produces working code — all within a sandboxed project directory.

The backend is a Node.js server. The frontend is a vanilla HTML/CSS/JS chat UI with a "Mission Control" aesthetic. Communication happens over a single WebSocket connection. The agent supports Anthropic (Claude), OpenAI (Chat Completions), and OpenAI Codex (ChatGPT subscription via OAuth), selectable via environment variable.

## Goals

- Let a non-technical or semi-technical user describe an app in plain language and get a working project on disk.
- Enforce a plan-first workflow: new projects start in Plan mode, producing a SPEC.md before any code is written.
- Keep the codebase minimal: no build tools, no frontend framework, no ORM — just ES modules and standard libraries.
- Support multiple AI providers behind a single agent loop so adding a new provider is a contained change.
- Give the user control over dangerous operations (file deletion, shell commands, token limit increases) through an approval flow.

## Architecture

```
Browser (public/)            Server (Node.js)            AI Provider
┌──────────────┐    WS     ┌──────────────┐    HTTP    ┌───────────┐
│  index.html  │◄─────────►│  server.js   │◄──────────►│ Anthropic │
│  login.html  │           │              │            │   or      │
│  app.js      │           │  agent.js    │            │  OpenAI   │
│  style.css   │           │  tools.js    │            │   or      │
└──────────────┘           │  oauth.js    │            │  Codex    │
                           └──────┬───────┘            └───────────┘
                                  │ fs / exec
                                  ▼
                           ┌──────────────┐
                           │  projects/   │
                           │  └─ my-app/  │
                           └──────────────┘
```

### Source Files

| File | Role |
|---|---|
| `server.js` | Express static server + WebSocket handler. Manages per-connection conversation state, mode (plan/code), and the approval Promise. Routes `chat`, `approval`, `set_project`, and `set_mode` messages. Gates OAuth login page when not authenticated. |
| `agent.js` | Provider-agnostic agent loop. Calls the AI model, processes tool-use responses, and repeats until the model stops requesting tools. Contains provider-specific call functions (`callAnthropic`, `callOpenAI`, `callCodex`) and message format converters. Accepts mode parameter to select system prompt and available tools. Supports multimodal messages (text + images). |
| `oauth.js` | OpenAI Codex OAuth flow (Authorization Code + PKCE). Browser-initiated: `/auth/start` redirects to OpenAI, temporary callback server on port 1455 handles the return. Tokens persisted to `.agency/tokens.json` and restored on startup. Auto-refreshes tokens before expiry. Exports `logout()` to clear session. |
| `tools.js` | Tool definitions (Anthropic schema format) and execution logic. Seven tools: `read_file`, `write_file`, `delete_file`, `list_files`, `search_files`, `execute_command`, `write_spec`. All file paths validated by `safePath()`. `getToolDefinitions(mode)` filters tools by mode — Plan mode only exposes read-only tools plus `write_spec`. |
| `public/index.html` | Main app shell: header with status badge/new project/logout buttons, project name prompt, message list, mode toggle, image attachment, chat input. Mission Control aesthetic. |
| `public/login.html` | OAuth login page shown when not authenticated. Explains the 3-step flow and links to `/auth/start`. |
| `public/app.js` | WebSocket client. Renders chat bubbles, tool activity (collapsible `<details>`), approval cards, error messages, and image thumbnails. Handles mode toggle, image attach/paste/drag-drop, and project reset. |
| `public/style.css` | Mission Control UI: dot-grid background, JetBrains Mono + DM Sans typography, phosphor green/amber/red palette, telemetry-style status badges, modal dialogs. |

### Supporting Files

| File | Role |
|---|---|
| `package.json` | Project metadata, `npm start` script, five dependencies. |
| `.env.example` | Template for environment variables. |
| `CLAUDE.md` | Instructions for Claude Code when working on this repo. |
| `.agency/tokens.json` | Persisted OAuth tokens (gitignored). |

## Key Design Decisions

### Plan and Code modes

New projects start in Plan mode, where the agent can only read files, list directories, search, and write `SPEC.md`. This ensures requirements are understood before code is written. Code mode unlocks when `SPEC.md` exists. The mode toggle in the UI sends a `set_mode` message; the server validates that a spec exists before allowing Code mode. Each mode has its own system prompt and tool set.

### Internal message format

All conversation messages are stored in Anthropic's block format (arrays of `text` / `tool_use` / `tool_result` / `image` blocks). When the OpenAI provider is selected, messages are converted to OpenAI's chat format on each API call (`toOpenAIMessages`) and responses are normalized back to block format. For the Codex Responses API, `toCodexInput` converts to the flat item format. This keeps the agent loop, tool processing, and conversation state provider-agnostic.

### Provider abstraction

`callAnthropic()`, `callOpenAI()`, and `callCodex()` all return `{ content, stopReason }` where `stopReason` is one of `"tool_use"`, `"end_turn"`, or `"length"`. The agent loop switches provider once at the start based on the `PROVIDER` and `OPENAI_AUTH` env vars. Adding a new provider means writing one call function and one message converter.

### ChatGPT OAuth (Codex)

When `OPENAI_AUTH=oauth` (the default), the server serves a login page at `/`. Clicking "Connect with ChatGPT" redirects to `auth.openai.com` using the Codex CLI's registered client ID with PKCE. A temporary callback server on port 1455 receives the authorization code, exchanges it for tokens, and redirects back to the main app. Tokens are persisted to `.agency/tokens.json` and restored on startup via `tryRestoreSession()`. The access token is sent to `chatgpt.com/backend-api/codex/responses` (the Responses API), which uses the ChatGPT subscription instead of API credits. Logout clears tokens from memory and disk.

### Image support

Users can attach images via file picker, clipboard paste, or drag-and-drop. Images are base64-encoded on the client and sent in the WebSocket `chat` message. The agent loop stores them in Anthropic's `image` block format internally. Each provider converter transforms them to the appropriate format: `image` source blocks for Anthropic, `image_url` parts for OpenAI Chat Completions, and `input_image` items for the Codex Responses API.

### Approval flow

Dangerous tools (`delete_file`, `execute_command`) and the dynamic token-limit increase are gated by user approval. The server creates a `Promise`, sends an `approval_request` over WebSocket, and pauses the agent loop. The browser renders an Approve/Deny card. The user's click sends an `approval` message that resolves the Promise.

### Path security

`safePath()` resolves any relative path against `PROJECT_DIR` and rejects paths that escape it (directory traversal). Every file operation goes through this check.

### Token limit recovery

If the AI model's response is truncated (`finish_reason: "length"` / `stop_reason: "max_tokens"`), the agent asks the user whether to double `maxTokens` and retry. This avoids silent failures when the model tries to produce large file writes. The default limit is 16,384 tokens.

### Conversation state recovery

Before starting a new agent loop invocation, any dangling assistant `tool_use` messages (left over from a previous error mid-loop) are removed from the conversation array so the next API call sees a valid message sequence.

## Tools

| Tool | Description | Approval Required | Plan Mode |
|---|---|---|---|
| `read_file` | Read a file's contents by relative path. | No | Yes |
| `write_file` | Write or overwrite a file. Creates parent directories. | No | No |
| `delete_file` | Delete a file. | Yes | No |
| `list_files` | Recursive directory listing (skips `node_modules`, `.git`). | No | Yes |
| `search_files` | Regex search across project files with optional glob filter. | No | Yes |
| `execute_command` | Run a shell command in the project directory (30s timeout). | Yes | No |
| `write_spec` | Write or update `SPEC.md` in the project root. | No | Yes |

## Dependencies

| Package | Purpose |
|---|---|
| `express` | Serves static frontend files and OAuth routes |
| `ws` | WebSocket server for real-time client-server communication |
| `@anthropic-ai/sdk` | Anthropic API client |
| `openai` | OpenAI API client |
| `dotenv` | Loads `.env` configuration |

## Configuration

All configuration is via environment variables (`.env` file). Defaults to OpenAI OAuth with `gpt-5.2-codex` — no `.env` needed for the default setup.

| Variable | Default | Description |
|---|---|---|
| `PROVIDER` | `openai` | Which AI provider to use (`anthropic` or `openai`) |
| `OPENAI_AUTH` | `oauth` | OpenAI auth method: `oauth` (browser-based ChatGPT login) or `apikey` |
| `OPENAI_MODEL` | `gpt-5.2-codex` | OpenAI model identifier |
| `OPENAI_API_KEY` | — | API key for OpenAI (only when `OPENAI_AUTH=apikey`) |
| `ANTHROPIC_API_KEY` | — | API key for Anthropic (only when `PROVIDER=anthropic`) |
| `PROJECT_DIR` | `./projects` | Root directory for all project folders |
| `PORT` | `3000` | Server port |

## WebSocket Message Protocol

### Client → Server

| Type | Fields | Purpose |
|---|---|---|
| `set_project` | `name` | Create or open a project folder |
| `set_mode` | `mode` (`plan` / `code`) | Switch agent mode |
| `chat` | `content`, `images?` | Send a user message (with optional attached images) |
| `approval` | `approved` (boolean) | Respond to an approval request |

### Server → Client

| Type | Fields | Purpose |
|---|---|---|
| `project_set` | `name`, `existing`, `mode`, `hasSpec` | Confirm project folder is ready with initial mode |
| `project_error` | `error` | Project name validation failed |
| `mode_set` | `mode` | Confirm mode switch |
| `mode_denied` | `reason` | Mode switch rejected (e.g. no SPEC.md) |
| `assistant` | `content` | Agent text response |
| `tool_call` | `tool`, `input` | Agent is invoking a tool |
| `tool_result` | `tool`, `result` | Tool execution result |
| `approval_request` | `tool`, `input` | Agent needs user approval |
| `status` | `status` (`thinking` / `ready`) | Agent busy/idle state |
| `error` | `content` | Error message |
