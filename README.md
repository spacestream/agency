# Agency

A web-based coding agent that plans and builds software projects through a chat interface. It uses your ChatGPT subscription (or Anthropic/OpenAI API keys) to read, write, and delete files, execute commands, and generate standalone applications — all from your browser.

## Install

```bash
git clone <your-repo-url>
cd agency
npm install
```

No configuration needed for the default setup — just `npm start`. It will open a browser for ChatGPT sign-in and use your ChatGPT subscription (Plus/Pro/Team) with `gpt-5.2-codex`.

To use a different provider, create a `.env` file:

```bash
cp .env.example .env
```

```env
# Use Anthropic
PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Or use OpenAI with an API key instead of OAuth
PROVIDER=openai
OPENAI_AUTH=apikey
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

The agent operates on files inside the `projects/` directory (configurable via `PROJECT_DIR` in `.env`). Everything it creates, edits, or deletes lives there — your agent code is never touched.

## How It Works

### Plan First, Then Code

Agency enforces a plan-first workflow with two modes:

- **Plan mode** (default for new projects) — The agent can only read existing files and write `SPEC.md`. Describe what you want to build and it will produce a specification covering architecture, file structure, dependencies, and implementation steps.

- **Code mode** — Unlocks once `SPEC.md` exists. The agent has full access to create files, write code, and run commands, following the plan from the spec.

A toggle in the UI lets you switch between modes. Opening an existing project that already has a `SPEC.md` goes straight to Code mode.

### Image Support

You can attach screenshots, mockups, or diagrams to your messages. The agent will analyze them to understand design intent, layout issues, or bugs. Attach via:

- The paperclip button
- Paste from clipboard (Cmd+V / Ctrl+V)
- Drag and drop onto the input area

### Approval Flow

Some operations require your approval — you'll see an Approve/Deny prompt in the chat for file deletions and shell commands.

## Usage

### Example: Build a countdown timer

Paste this into the chat:

```
Build a single-page HTML countdown timer app. The user should be able to
set a number of minutes, click Start, and see the countdown tick down every second.
When it reaches zero, show an alert. Use vanilla HTML, CSS, and JavaScript in one file.
```

The agent will:

1. Write a `SPEC.md` describing the project structure (in Plan mode).
2. Once you switch to Code mode, create the files following the spec.
3. Offer to run or serve it for testing (approve the command when prompted).

### Other things to try

- `"Create a Node.js CLI tool that converts CSV files to JSON"`
- `"Build a Python script that fetches the top 5 Hacker News stories"`
- `"List the files in the project"` — see what's already there
- Attach a screenshot and say `"The layout is broken, fix the CSS"`
