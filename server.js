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

app.use(express.static(join(__dirname, "public")));

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Client connected");

  const conversationMessages = [];
  let pendingApproval = null;
  let sessionProjectDir = null;

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
      console.log(`Project directory set: ${target}`);
      send({ type: "project_set", name, existing: isExisting });
      return;
    }

    if (msg.type === "chat" && msg.content) {
      if (!sessionProjectDir) {
        send({ type: "error", content: "Set a project folder first." });
        return;
      }

      send({ type: "status", status: "thinking" });

      try {
        await runAgentLoop(msg.content, msg.images || [], conversationMessages, sessionProjectDir, {
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
