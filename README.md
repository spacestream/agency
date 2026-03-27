# Agency

A web-based coding agent that can read, write, and delete files, execute commands, and generate standalone applications. It runs in your browser and talks to Claude (Anthropic) or GPT (OpenAI) to build projects for you.

## Install

```bash
git clone <your-repo-url>
cd agency
npm install
```

Copy the example environment file and add your API key:

```bash
cp .env.example .env
```

Edit `.env` and set your provider and key:

```env
# Use Anthropic (default)
PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Or use OpenAI with an API key
PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# Or use OpenAI with ChatGPT subscription (OAuth)
PROVIDER=openai
OPENAI_AUTH=oauth
OPENAI_MODEL=gpt-5.2-codex
```

When using `OPENAI_AUTH=oauth`, the server will open a browser for ChatGPT sign-in on startup. This uses your ChatGPT subscription (Plus/Pro/Team) instead of API credits. No API key needed.

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

The agent operates on files inside the `projects/` directory (configurable via `PROJECT_DIR` in `.env`). Everything it creates, edits, or deletes lives there — your agent code is never touched.

## Usage

Type a message in the chat box and the agent will respond. It can use tools to interact with files and run commands. Some operations require your approval — you'll see an Approve/Deny prompt in the chat when that happens.

### Example: Build a countdown timer

Paste this into the chat:

```
Plan and build a single-page HTML countdown timer app. The user should be able to
set a number of minutes, click Start, and see the countdown tick down every second.
When it reaches zero, show an alert. Use vanilla HTML, CSS, and JavaScript in one file.
```

The agent will:

1. Write a `SPEC.md` describing the project structure and ask if you'd like to proceed.
2. After you confirm, create an `index.html` file in the `projects/` folder.
3. Offer to open or serve it for testing (approve the command when prompted).

You can then check the result at `projects/index.html`.

### Other things to try

- `"Create a Node.js CLI tool that converts CSV files to JSON"`
- `"Build a Python script that fetches the top 5 Hacker News stories"`
- `"List the files in the project"` — see what's already there
- `"Delete all files and start fresh"` — you'll be asked to approve each deletion
