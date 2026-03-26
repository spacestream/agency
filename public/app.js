const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const projectPromptEl = document.getElementById("project-prompt");
const projectNameEl = document.getElementById("project-name");
const projectStartBtn = document.getElementById("project-start");
const projectErrorEl = document.getElementById("project-error");
const chatFooterEl = document.getElementById("chat-footer");

let ws;
let inputEnabled = true;
let projectSet = false;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    setStatus("connected", "Connected");
  };

  ws.onclose = () => {
    setStatus("disconnected", "Disconnected");
    setTimeout(connect, 2000);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleMessage(msg);
  };
}

function setStatus(cls, text) {
  statusEl.className = `status ${cls}`;
  statusEl.textContent = text;
}

function handleMessage(msg) {
  switch (msg.type) {
    case "assistant":
      appendAssistant(msg.content);
      break;
    case "tool_call":
      appendToolCall(msg.tool, msg.input);
      break;
    case "tool_result":
      appendToolResult(msg.tool, msg.result);
      break;
    case "approval_request":
      showApprovalDialog(msg.tool, msg.input);
      break;
    case "status":
      if (msg.status === "thinking") {
        setStatus("thinking", "Thinking...");
        setInputEnabled(false);
      } else {
        setStatus("connected", "Connected");
        setInputEnabled(true);
      }
      break;
    case "project_set":
      projectSet = true;
      projectPromptEl.style.display = "none";
      chatFooterEl.style.display = "";
      inputEl.focus();
      if (msg.existing) {
        appendAssistant(`Opened existing project: ${msg.name} — You can ask me to work on the existing files, add features, fix bugs, or continue building.`);
      } else {
        appendAssistant(`Created new project: ${msg.name}`);
      }
      break;
    case "project_error":
      projectErrorEl.textContent = msg.error;
      projectStartBtn.disabled = false;
      projectNameEl.disabled = false;
      break;
    case "error":
      appendError(msg.content);
      break;
  }
}

function setInputEnabled(enabled) {
  inputEnabled = enabled;
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

function appendUser(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendAssistant(text) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendError(text) {
  const el = document.createElement("div");
  el.className = "msg error";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function appendToolCall(tool, input) {
  const details = document.createElement("details");
  details.className = "tool-activity";

  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="tool-name">${tool}</span> ${toolInputSummary(tool, input)}`;
  details.appendChild(summary);

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(input, null, 2);
  details.appendChild(pre);

  messagesEl.appendChild(details);
  scrollToBottom();
}

function appendToolResult(tool, result) {
  const details = document.createElement("details");
  details.className = "tool-activity result";

  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="tool-name">${tool}</span> result`;
  details.appendChild(summary);

  const pre = document.createElement("pre");
  pre.textContent = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  details.appendChild(pre);

  messagesEl.appendChild(details);
  scrollToBottom();
}

function showApprovalDialog(tool, input) {
  const card = document.createElement("div");
  card.className = "approval-card";

  const heading = document.createElement("h3");
  heading.textContent = "Approval Required";
  card.appendChild(heading);

  const detail = document.createElement("div");
  detail.className = "detail";
  if (tool === "execute_command") {
    detail.textContent = `Command: ${input.command}`;
  } else if (tool === "delete_file") {
    detail.textContent = `Delete: ${input.path}`;
  } else if (tool === "increase_token_limit") {
    detail.textContent = `${input.reason} Double the token limit from ${input.current_limit} to ${input.new_limit} and retry?`;
  } else {
    detail.textContent = JSON.stringify(input, null, 2);
  }
  card.appendChild(detail);

  const buttons = document.createElement("div");
  buttons.className = "buttons";

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn-approve";
  approveBtn.textContent = "Approve";
  approveBtn.onclick = () => respond(true);

  const denyBtn = document.createElement("button");
  denyBtn.className = "btn-deny";
  denyBtn.textContent = "Deny";
  denyBtn.onclick = () => respond(false);

  buttons.appendChild(approveBtn);
  buttons.appendChild(denyBtn);
  card.appendChild(buttons);

  messagesEl.appendChild(card);
  scrollToBottom();

  function respond(approved) {
    ws.send(JSON.stringify({ type: "approval", approved }));
    card.classList.add("resolved");
    buttons.innerHTML = approved
      ? '<span style="color:#6fdd8b">Approved</span>'
      : '<span style="color:#f85149">Denied</span>';
  }
}

function toolInputSummary(tool, input) {
  switch (tool) {
    case "read_file":
    case "delete_file":
      return input.path || "";
    case "write_file":
      return input.path || "";
    case "list_files":
      return input.path || ".";
    case "execute_command":
      return input.command || "";
    case "search_files":
      return `"${input.pattern}"`;
    case "write_spec":
      return "SPEC.md";
    default:
      return "";
  }
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || !inputEnabled) return;

  appendUser(text);
  ws.send(JSON.stringify({ type: "chat", content: text }));
  inputEl.value = "";
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setProject() {
  const name = projectNameEl.value.trim();
  if (!name) return;
  projectErrorEl.textContent = "";
  projectStartBtn.disabled = true;
  projectNameEl.disabled = true;
  ws.send(JSON.stringify({ type: "set_project", name }));
}

projectNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    setProject();
  }
});

// Send on Enter (Shift+Enter for newline)
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

connect();
