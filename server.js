import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import "dotenv/config";

import { runAgentLoop } from "./agent.js";
import { startAuthFlow, isAuthenticated, tryRestoreSession, logout } from "./oauth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PROJECT_DIR = resolve(process.env.PROJECT_DIR || "./projects");
const PROVIDER = (process.env.PROVIDER || "openai").toLowerCase();
const OPENAI_AUTH = (process.env.OPENAI_AUTH || "oauth").toLowerCase();
const NEEDS_OAUTH = PROVIDER === "openai" && OPENAI_AUTH === "oauth";

const app = express();

// --- OAuth routes (before static middleware) ---

if (NEEDS_OAUTH) {
  // Start OAuth flow — spin up callback server and redirect to OpenAI
  app.get("/auth/start", (req, res) => {
    const url = startAuthFlow(PORT);
    res.redirect(url);
  });

  // Logout — clear tokens and redirect to login
  app.get("/auth/logout", (req, res) => {
    logout().then(() => {
      console.log("OAuth session cleared.");
      res.redirect("/");
    }).catch((err) => {
      console.error("Logout error:", err.message);
      res.redirect("/");
    });
  });

  // Gate: serve login page if not authenticated
  app.get("/", (req, res, next) => {
    if (!isAuthenticated()) {
      res.sendFile(join(__dirname, "public", "login.html"));
      return;
    }
    next();
  });
}

// Read SPEC.md from a project
app.get("/api/spec", async (req, res) => {
  const name = req.query.project;
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    res.status(400).json({ error: "Invalid project name" });
    return;
  }
  try {
    const { readFile } = await import("fs/promises");
    const specPath = join(resolve(PROJECT_DIR, name), "SPEC.md");
    const content = await readFile(specPath, "utf8");
    res.json({ content });
  } catch {
    res.json({ content: null });
  }
});

// List existing project folders
app.get("/api/projects", async (req, res) => {
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(PROJECT_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    res.json(dirs);
  } catch {
    res.json([]);
  }
});

app.use(express.static(join(__dirname, "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  const conversationMessages = [];
  let pendingApproval = null;
  let sessionProjectDir = null;
  let sessionMode = "plan";

  function send(msg) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      send({ type: "error", content: "Invalid JSON" });
      return;
    }

    if (msg.type === "approval" && pendingApproval) {
      const resolve = pendingApproval;
      pendingApproval = null;
      resolve(msg.approved);
      return;
    }

    if (msg.type === "set_project" && msg.name) {
      const name = msg.name.trim();
      // Validate: only alphanumeric, hyphens, underscores, no path separators
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        send({ type: "project_error", error: "Invalid name. Use only letters, numbers, hyphens, and underscores." });
        return;
      }
      const target = resolve(PROJECT_DIR, name);
      const isExisting = existsSync(target);
      await mkdir(target, { recursive: true });
      sessionProjectDir = target;
      const specPath = join(target, "SPEC.md");
      const hasSpec = existsSync(specPath);
      console.log(`SPEC.md check: ${specPath} → ${hasSpec}`);
      sessionMode = hasSpec ? "code" : "plan";
      console.log(`Project directory set: ${target} (mode: ${sessionMode})`);
      send({ type: "project_set", name, existing: isExisting, mode: sessionMode, hasSpec });
      return;
    }

    if (msg.type === "set_mode" && (msg.mode === "plan" || msg.mode === "code")) {
      if (msg.mode === "code") {
        const hasSpec = sessionProjectDir && existsSync(join(sessionProjectDir, "SPEC.md"));
        if (!hasSpec) {
          send({ type: "mode_denied", reason: "no_spec" });
          return;
        }
      }
      sessionMode = msg.mode;
      console.log(`Mode switched to: ${sessionMode}`);
      send({ type: "mode_set", mode: sessionMode });
      return;
    }

    if (msg.type === "chat" && msg.content) {
      if (!sessionProjectDir) {
        send({ type: "error", content: "Set a project folder first." });
        return;
      }

      send({ type: "status", status: "thinking" });

      try {
        await runAgentLoop(msg.content, msg.images || [], conversationMessages, sessionProjectDir, sessionMode, {
          onText: (text) => send({ type: "assistant", content: text }),
          onToolCall: (tool, input) => send({ type: "tool_call", tool, input }),
          onToolResult: (tool, result) => send({ type: "tool_result", tool, result }),
          onError: (err) => send({ type: "error", content: err }),
          requestApproval: (tool, input) => {
            return new Promise((resolve) => {
              pendingApproval = resolve;
              send({ type: "approval_request", tool, input });
            });
          },
        });
      } catch (err) {
        send({ type: "error", content: err.message });
      }

      send({ type: "status", status: "ready" });
    }
  });

  ws.on("close", () => console.log("Client disconnected"));
});

await mkdir(PROJECT_DIR, { recursive: true });

if (NEEDS_OAUTH) {
  await tryRestoreSession();
}

server.listen(PORT, () => {
  console.log(`Agency running at http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER}${PROVIDER === "openai" ? ` (auth: ${OPENAI_AUTH})` : ""}`);
  if (NEEDS_OAUTH && !isAuthenticated()) console.log("OAuth: waiting for browser login at /");
  if (NEEDS_OAUTH && isAuthenticated()) console.log("OAuth: session restored");
  console.log(`Project directory: ${PROJECT_DIR}`);
});
