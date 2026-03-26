# Agency — Project Specification

## Overview

Agency is a web-based coding agent that generates and modifies standalone software projects through a chat interface. The user describes what they want built, and the agent reads, writes, and deletes files, runs shell commands, and produces working code — all within a sandboxed project directory.

The backend is a Node.js server. The frontend is a vanilla HTML/CSS/JS chat UI. Communication happens over a single WebSocket connection. The agent supports both Anthropic (Claude) and OpenAI models, selectable via environment variable.

## Goals

- Let a non-technical or semi-technical user describe an app in plain language and get a working project on disk.
- Keep the codebase minimal: no build tools, no frontend framework, no ORM — just ES modules and standard libraries.
- Support multiple AI providers behind a single agent loop so adding a new provider is a contained change.
- Give the user control over dangerous operations (file deletion, shell commands, token limit increases) through an approval flow.

## Architecture

```
Browser (public/)            Server (Node.js)            AI Provider
┌──────────────┐    WS     ┌──────────────┐    HTTP    ┌───────────┐
│  index.html  │◄─────────►│  server.js   │◄──────────►│ Anthropic │
│  app.js      │           │              │            │   or      │
│  style.css   │           │  agent.js    │            │  OpenAI   │
└──────────────┘           │  tools.js    │            └───────────┘
                           └──────┬───────┘
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
| `server.js` | Express static server + WebSocket handler. Manages per-connection conversation state and the approval Promise. Routes `chat`, `approval`, and `set_project` messages. |
| `agent.js` | Provider-agnostic agent loop. Calls the AI model, processes tool-use responses, and repeats until the model stops requesting tools. Contains provider-specific call functions (`callAnthropic`, `callOpenAI`) and message format converters. |
| `tools.js` | Tool definitions (Anthropic schema format) and execution logic. Seven tools: `read_file`, `write_file`, `delete_file`, `list_files`, `search_files`, `execute_command`, `write_spec`. All file paths validated by `safePath()`. |
| `public/index.html` | Single-page shell: header with status badge, project name prompt, message list, chat input. |
| `public/app.js` | WebSocket client. Renders chat bubbles, tool activity (collapsible `<details>`), approval cards, and error messages. Sends `chat`, `approval`, and `set_project` messages to server. |
| `public/style.css` | Dark-themed UI styles. GitHub-inspired colour palette. |

### Supporting Files

| File | Role |
|---|---|
| `package.json` | Project metadata, `npm start` script, five dependencies. |
| `.env.example` | Template for required environment variables. |
| `CLAUDE.md` | Instructions for Claude Code when working on this repo. |

## Key Design Decisions

### Internal message format

All conversation messages are stored in Anthropic's block format (arrays of `text` / `tool_use` / `tool_result` blocks). When the OpenAI provider is selected, messages are converted to OpenAI's chat format on each API call (`toOpenAIMessages`) and responses are normalized back to block format. This keeps the agent loop, tool processing, and conversation state provider-agnostic.

### Provider abstraction

`callAnthropic()` and `callOpenAI()` both return `{ content, stopReason }` where `stopReason` is one of `"tool_use"`, `"end_turn"`, or `"length"`. The agent loop switches provider once at the start based on the `PROVIDER` env var. Adding a new provider means writing one call function and one message converter.

### Approval flow

Dangerous tools (`delete_file`, `execute_command`) and the dynamic token-limit increase are gated by user approval. The server creates a `Promise`, sends an `approval_request` over WebSocket, and pauses the agent loop. The browser renders an Approve/Deny card. The user's click sends an `approval` message that resolves the Promise.

### Path security

`safePath()` resolves any relative path against `PROJECT_DIR` and rejects paths that escape it (directory traversal). Every file operation goes through this check.

### Token limit recovery

If the AI model's response is truncated (`finish_reason: "length"` / `stop_reason: "max_tokens"`), the agent asks the user whether to double `maxTokens` and retry. This avoids silent failures when the model tries to produce large file writes. The default limit is 16,384 tokens.

### Conversation state recovery

Before starting a new agent loop invocation, any dangling assistant `tool_use` messages (left over from a previous error mid-loop) are removed from the conversation array so the next API call sees a valid message sequence.

### Planning mode

The system prompt instructs the agent to use the `write_spec` tool to produce a `SPEC.md` in the project directory before writing code when the user asks to plan or design. Implementation only begins after the user confirms.

## Tools

| Tool | Description | Approval Required |
|---|---|---|
| `read_file` | Read a file's contents by relative path. | No |
| `write_file` | Write or overwrite a file. Creates parent directories. | No |
| `delete_file` | Delete a file. | Yes |
| `list_files` | Recursive directory listing (skips `node_modules`, `.git`). | No |
| `search_files` | Regex search across project files with optional glob filter. | No |
| `execute_command` | Run a shell command in the project directory (30s timeout). | Yes |
| `write_spec` | Write or update `SPEC.md` in the project root. | No |

## Dependencies

| Package | Purpose |
|---|---|
| `express` | Serves static frontend files |
| `ws` | WebSocket server for real-time client-server communication |
| `@anthropic-ai/sdk` | Anthropic API client |
| `openai` | OpenAI API client |
| `dotenv` | Loads `.env` configuration |

## Configuration

All configuration is via environment variables (`.env` file):

| Variable | Default | Description |
|---|---|---|
| `PROVIDER` | `anthropic` | Which AI provider to use (`anthropic` or `openai`) |
| `ANTHROPIC_API_KEY` | — | API key for Anthropic |
| `OPENAI_API_KEY` | — | API key for OpenAI |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model identifier |
| `PROJECT_DIR` | `./projects` | Root directory for all project folders |
| `PORT` | `3000` | Server port |

## WebSocket Message Protocol

### Client → Server

| Type | Fields | Purpose |
|---|---|---|
| `set_project` | `name` | Create or open a project folder |
| `chat` | `content` | Send a user message to the agent |
| `approval` | `approved` (boolean) | Respond to an approval request |

### Server → Client

| Type | Fields | Purpose |
|---|---|---|
| `project_set` | `name`, `existing` | Confirm project folder is ready |
| `project_error` | `error` | Project name validation failed |
| `assistant` | `content` | Agent text response |
| `tool_call` | `tool`, `input` | Agent is invoking a tool |
| `tool_result` | `tool`, `result` | Tool execution result |
| `approval_request` | `tool`, `input` | Agent needs user approval |
| `status` | `status` (`thinking` / `ready`) | Agent busy/idle state |
| `error` | `content` | Error message |
