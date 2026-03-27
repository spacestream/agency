import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { TOOLS, getToolDefinitions, executeTool } from "./tools.js";
import { getAccessToken, getAccountId } from "./oauth.js";

// --- Provider setup ---

const PROVIDER = (process.env.PROVIDER || "anthropic").toLowerCase();
const OPENAI_AUTH = (process.env.OPENAI_AUTH || "apikey").toLowerCase();

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

function getProvider() {
  if (PROVIDER === "openai") {
    if (OPENAI_AUTH === "oauth") {
      if (!getAccessToken()) throw new Error("OpenAI OAuth not initialized. Set OPENAI_AUTH=oauth and restart.");
      return "codex";
    }
    if (!openai) throw new Error("OpenAI client not initialized. Set OPENAI_API_KEY or use OPENAI_AUTH=oauth.");
    return "openai";
  }
  if (!anthropic) throw new Error("ANTHROPIC_API_KEY not set");
  return "anthropic";
}

// --- Tool definition conversion ---

// Anthropic format: { name, description, input_schema }
// OpenAI format:    { type: "function", function: { name, description, parameters } }
function toolDefsForOpenAI(anthropicDefs) {
  return anthropicDefs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

// Responses API format: { type: "function", name, description, parameters }
function toolDefsForCodex(anthropicDefs) {
  return anthropicDefs.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

// --- Message format conversion ---

// Convert Anthropic-style messages to OpenAI chat format for the API call.
// Anthropic stores assistant content as an array of blocks; OpenAI uses
// content string + tool_calls. Tool results in Anthropic are a user message
// with tool_result blocks; OpenAI uses role:"tool" messages.
function toOpenAIMessages(systemPrompt, messages) {
  const out = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === "user") {
      // Could be a plain string, an array with tool_results, or mixed
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // Check if these are tool_result blocks
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            out.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          // Plain text blocks
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          out.push({ role: "user", content: text || "" });
        }
      }
    } else if (msg.role === "assistant") {
      // Convert Anthropic block format to OpenAI format
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((b) => b.type === "text").map((b) => b.text);
        const toolUses = msg.content.filter((b) => b.type === "tool_use");

        const assistantMsg = {
          role: "assistant",
          content: textParts.join("\n") || "",
        };

        if (toolUses.length > 0) {
          assistantMsg.tool_calls = toolUses.map((tu) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: JSON.stringify(tu.input),
            },
          }));
        }

        out.push(assistantMsg);
      }
    }
  }

  return out;
}

// Convert Anthropic-style messages to Codex Responses API input items.
// The Responses API uses a flat array of typed items rather than role-grouped messages.
function toCodexInput(messages) {
  const input = [];
  let msgIndex = 0;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: msg.content }],
        });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b) => b.type === "tool_result");
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            input.push({
              type: "function_call_output",
              call_id: tr.tool_use_id,
              output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          const text = msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          input.push({
            role: "user",
            content: [{ type: "input_text", text: text || "" }],
          });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: msg.content, annotations: [] }],
          status: "completed",
          id: `msg_${msgIndex}`,
        });
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((b) => b.type === "text");
        const toolUses = msg.content.filter((b) => b.type === "tool_use");

        if (textParts.length > 0) {
          const text = textParts.map((b) => b.text).join("\n");
          input.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }],
            status: "completed",
            id: `msg_${msgIndex}`,
          });
        }

        for (const tu of toolUses) {
          input.push({
            type: "function_call",
            call_id: tu.id,
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          });
        }
      }
    }
    msgIndex++;
  }

  return input;
}

// --- System prompt ---

function buildSystemPrompt(projectDir) {
  return `You are a coding agent that helps users build software projects. You operate on a project directory at: ${projectDir}

## Your Capabilities
You can read, write, and delete files, list directory contents, search file contents, execute shell commands, and write project specifications.

## Guidelines
- Always use list_files first to understand the current project state before making changes.
- When creating new projects, start by understanding what already exists.
- Use write_file to create or update files. Use delete_file only when necessary.
- Use execute_command to run shell commands like npm install, python scripts, node scripts, etc.
- Show your reasoning before taking actions.
- After writing code, offer to run it for testing.

## Planning Mode
When the user asks you to plan, design, or spec out a project:
1. First use list_files to see if the project already has files.
2. Think about the architecture, files needed, and dependencies.
3. Use write_spec to create a SPEC.md document with:
   - Project overview and purpose
   - Architecture and design decisions
   - File structure
   - Key dependencies
   - Implementation steps (ordered)
4. After writing the spec, ask the user if they want to proceed with implementation.
5. Only start coding after the user confirms.

When implementing, check if SPEC.md exists and follow it.

## Safety
- delete_file and execute_command require user approval — the user will be prompted.
- If the user denies an operation, respect that and find alternatives.
- Never execute destructive commands without explanation.
- Keep all file operations within the project directory.`;
}

// --- SSE stream parser ---

async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const dataLines = chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());

        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            try { yield JSON.parse(data); } catch {}
          }
        }

        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

// --- Provider-specific API calls ---

async function callAnthropic(systemPrompt, toolDefs, messages, maxTokens) {
  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: toolDefs,
    messages,
  });

  const stopReason =
    response.stop_reason === "tool_use" ? "tool_use"
    : response.stop_reason === "max_tokens" ? "length"
    : "end_turn";

  return { content: response.content, stopReason };
}

async function callOpenAI(systemPrompt, toolDefs, messages, maxTokens) {
  const openaiTools = toolDefsForOpenAI(toolDefs);
  const openaiMessages = toOpenAIMessages(systemPrompt, messages);

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    max_completion_tokens: maxTokens,
    tools: openaiTools,
    messages: openaiMessages,
  });

  const choice = response.choices[0];
  const msg = choice.message;

  // Normalize OpenAI response into Anthropic-style content blocks
  // so the agent loop doesn't need to know the difference
  const content = [];

  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  const stopReason =
    choice.finish_reason === "tool_calls" ? "tool_use"
    : choice.finish_reason === "length" ? "length"
    : "end_turn";

  return { content, stopReason };
}

async function callCodex(systemPrompt, toolDefs, messages, maxTokens) {
  const token = getAccessToken();
  const accountId = getAccountId();
  if (!token || !accountId) throw new Error("OAuth credentials not available");

  const codexTools = toolDefsForCodex(toolDefs);
  const codexInput = toCodexInput(messages);

  const body = {
    model: OPENAI_MODEL,
    store: false,
    stream: true,
    instructions: systemPrompt,
    input: codexInput,
    tools: codexTools,
    tool_choice: "auto",
    parallel_tool_calls: true,
  };

  const response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex API error (${response.status}): ${text}`);
  }

  // Parse SSE stream into Anthropic-style content blocks
  const content = [];
  let stopReason = "end_turn";

  for await (const event of parseSSE(response)) {
    if (event.type === "response.output_item.done") {
      const item = event.item;
      if (item.type === "message") {
        const text = (item.content || [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("");
        if (text) content.push({ type: "text", text });
      } else if (item.type === "function_call") {
        content.push({
          type: "tool_use",
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments || "{}"),
        });
      }
    } else if (event.type === "response.completed") {
      const status = event.response?.status;
      if (status === "incomplete") {
        stopReason = "length";
      } else if (content.some((b) => b.type === "tool_use")) {
        stopReason = "tool_use";
      } else {
        stopReason = "end_turn";
      }
    } else if (event.type === "error") {
      throw new Error(`Codex error: ${event.message || event.code || JSON.stringify(event)}`);
    } else if (event.type === "response.failed") {
      const msg = event.response?.error?.message;
      throw new Error(msg || "Codex response failed");
    }
  }

  return { content, stopReason };
}

// --- Agent loop (provider-agnostic) ---

export async function runAgentLoop(userMessage, messages, projectDir, callbacks) {
  // Clean up any broken conversation state from a previous error.
  // If the last message is an assistant tool_use without a matching tool_result,
  // remove it so the API doesn't reject the conversation.
  while (messages.length > 0) {
    const last = messages[messages.length - 1];
    if (
      last.role === "assistant" &&
      Array.isArray(last.content) &&
      last.content.some((b) => b.type === "tool_use")
    ) {
      messages.pop();
    } else {
      break;
    }
  }

  messages.push({ role: "user", content: userMessage });

  const provider = getProvider();
  const toolDefs = getToolDefinitions();
  const systemPrompt = buildSystemPrompt(projectDir);
  let maxTokens = 16384;

  const callModel =
    provider === "codex"
      ? (msgs) => callCodex(systemPrompt, toolDefs, msgs, maxTokens)
      : provider === "openai"
        ? (msgs) => callOpenAI(systemPrompt, toolDefs, msgs, maxTokens)
        : (msgs) => callAnthropic(systemPrompt, toolDefs, msgs, maxTokens);

  while (true) {
    const response = await callModel(messages);

    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });

    // Extract text blocks and send them
    for (const block of assistantContent) {
      if (block.type === "text") {
        callbacks.onText(block.text);
      }
    }

    // If the response was truncated, ask the user whether to retry with a higher limit
    if (response.stopReason === "length") {
      const newLimit = maxTokens * 2;
      const approved = await callbacks.requestApproval("increase_token_limit", {
        reason: "Response was cut short due to length.",
        current_limit: maxTokens,
        new_limit: newLimit,
      });
      if (approved) {
        // Remove the truncated assistant message and retry
        messages.pop();
        maxTokens = newLimit;
        continue;
      }
      // User declined — stop the loop
      callbacks.onText("[Response was cut short due to length.]");
      break;
    }

    // If no tool use, we're done
    if (response.stopReason === "end_turn") {
      break;
    }

    // Process tool calls
    if (response.stopReason === "tool_use") {
      const toolResults = [];

      for (const block of assistantContent) {
        if (block.type !== "tool_use") continue;

        const tool = TOOLS[block.name];
        if (!tool) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Unknown tool: ${block.name}`,
          });
          continue;
        }

        callbacks.onToolCall(block.name, block.input);

        let result;
        try {
          if (tool.requiresApproval) {
            const approved = await callbacks.requestApproval(block.name, block.input);
            if (!approved) {
              result = "User denied this operation.";
            } else {
              result = await executeTool(block.name, block.input, projectDir);
            }
          } else {
            result = await executeTool(block.name, block.input, projectDir);
          }
        } catch (err) {
          result = `Error: ${err.message}`;
        }

        callbacks.onToolResult(block.name, result);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }
}
