const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const projectPromptEl = document.getElementById("project-prompt");
const projectNameEl = document.getElementById("project-name");
const projectStartBtn = document.getElementById("project-start");
const projectErrorEl = document.getElementById("project-error");
const chatFooterEl = document.getElementById("chat-footer");
const newProjectBtn = document.getElementById("new-project-btn");
const fileInputEl = document.getElementById("file-input");
const imagePreviewEl = document.getElementById("image-preview");
const modeToggleEl = document.getElementById("mode-toggle");
const modeHintEl = document.getElementById("mode-hint");
const projectDropdown = document.getElementById("project-dropdown");

let ws;
let inputEnabled = true;
let projectSet = false;
let currentMode = "plan";
let currentProjectName = null;
let pendingImages = []; // { data: base64, mimeType: string }
let existingProjects = [];

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
      currentProjectName = msg.name;
      projectPromptEl.style.display = "none";
      chatFooterEl.style.display = "";
      newProjectBtn.style.display = "";
      document.getElementById("spec-btn").style.display = "";
      document.getElementById("m-spec-btn").style.display = "";
      document.getElementById("m-new-project-btn").style.display = "";
      const label = document.getElementById("project-label");
      label.textContent = msg.name;
      label.style.display = "";
      refreshUsage();
      if (usageInterval) clearInterval(usageInterval);
      usageInterval = setInterval(refreshUsage, 60000);
      updateModeUI(msg.mode || "plan");
      inputEl.focus();
      if (msg.existing && msg.hasSpec) {
        appendAssistant(`Opened existing project: ${msg.name} — SPEC.md found, switching to Code mode. You can ask me to work on the existing files, add features, fix bugs, or continue building.`);
      } else if (msg.existing) {
        appendAssistant(`Opened existing project: ${msg.name} — No SPEC.md found. Starting in Plan mode — describe what you want to build and I'll create a spec.`);
      } else {
        appendAssistant(`Created new project: ${msg.name} — Starting in Plan mode. Describe what you want to build and I'll create a specification before writing any code.`);
      }
      break;
    case "project_error":
      projectErrorEl.textContent = msg.error;
      projectStartBtn.disabled = false;
      projectNameEl.disabled = false;
      break;
    case "mode_set":
      updateModeUI(msg.mode);
      appendAssistant(msg.mode === "code"
        ? "Switched to Code mode — I now have full access to create files, write code, and run commands."
        : "Switched to Plan mode — I'll focus on understanding requirements and updating SPEC.md.");
      break;
    case "mode_denied":
      showModal();
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

function appendUser(text, images) {
  const el = document.createElement("div");
  el.className = "msg user";
  if (text) {
    const textNode = document.createElement("div");
    textNode.textContent = text;
    el.appendChild(textNode);
  }
  if (images && images.length > 0) {
    const strip = document.createElement("div");
    strip.className = "msg-images";
    for (const img of images) {
      const thumb = document.createElement("img");
      thumb.src = `data:${img.mimeType};base64,${img.data}`;
      thumb.alt = "Attached image";
      strip.appendChild(thumb);
    }
    el.appendChild(strip);
  }
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
  if (!text && pendingImages.length === 0) return;
  if (!inputEnabled) return;

  appendUser(text, pendingImages);

  const msg = { type: "chat", content: text || "(see attached images)" };
  if (pendingImages.length > 0) {
    msg.images = pendingImages;
  }
  ws.send(JSON.stringify(msg));

  inputEl.value = "";
  pendingImages = [];
  imagePreviewEl.innerHTML = "";
  imagePreviewEl.style.display = "none";
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
  hideDropdown();
  ws.send(JSON.stringify({ type: "set_project", name }));
}

// Project autocomplete
async function fetchProjects() {
  try {
    const res = await fetch("/api/projects");
    existingProjects = await res.json();
  } catch {
    existingProjects = [];
  }
}

function showDropdown(filter) {
  const matches = existingProjects.filter((p) =>
    p.toLowerCase().includes(filter.toLowerCase())
  );
  if (matches.length === 0 || (matches.length === 1 && matches[0] === filter)) {
    hideDropdown();
    return;
  }
  projectDropdown.innerHTML = "";
  for (const name of matches.slice(0, 8)) {
    const item = document.createElement("div");
    item.className = "dropdown-item";
    item.textContent = name;
    item.onclick = () => {
      projectNameEl.value = name;
      hideDropdown();
      projectNameEl.focus();
    };
    projectDropdown.appendChild(item);
  }
  projectDropdown.style.display = "block";
}

function hideDropdown() {
  projectDropdown.style.display = "none";
}

projectNameEl.addEventListener("input", () => {
  const val = projectNameEl.value.trim();
  if (val.length > 0) {
    showDropdown(val);
  } else {
    hideDropdown();
  }
});

projectNameEl.addEventListener("focus", () => {
  fetchProjects().then(() => {
    const val = projectNameEl.value.trim();
    if (val.length > 0) showDropdown(val);
    else if (existingProjects.length > 0) showDropdown("");
  });
});

projectNameEl.addEventListener("blur", () => {
  // Delay to allow click on dropdown item
  setTimeout(hideDropdown, 150);
});

projectNameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    hideDropdown();
    setProject();
  }
  if (e.key === "Escape") {
    hideDropdown();
  }
});

// Send on Enter (Shift+Enter for newline)
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Mobile menu
function toggleMenu() {
  document.getElementById("mobile-menu").classList.toggle("open");
}

// Spec viewer
async function showSpec() {
  const modal = document.getElementById("spec-modal");
  const contentEl = document.getElementById("spec-content");
  contentEl.innerHTML = "<p>Loading...</p>";
  modal.style.display = "flex";

  try {
    const res = await fetch(`/api/spec?project=${encodeURIComponent(currentProjectName)}`);
    const data = await res.json();
    if (!data.content) {
      contentEl.innerHTML = "<p>No SPEC.md found in this project.</p>";
      return;
    }
    contentEl.innerHTML = renderMarkdown(data.content);
  } catch {
    contentEl.innerHTML = "<p>Failed to load SPEC.md</p>";
  }
}

function dismissSpec() {
  document.getElementById("spec-modal").style.display = "none";
}

function renderMarkdown(md) {
  return md
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    // Tables
    .replace(/^(\|.+\|)\n(\|[-| :]+\|)\n((?:\|.+\|\n?)*)/gm, (_, header, sep, body) => {
      const ths = header.split("|").filter(c => c.trim()).map(c => `<th>${c.trim()}</th>`).join("");
      const rows = body.trim().split("\n").map(row => {
        const tds = row.split("|").filter(c => c.trim()).map(c => `<td>${c.trim()}</td>`).join("");
        return `<tr>${tds}</tr>`;
      }).join("");
      return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    // Headers
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Unordered lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Paragraphs (lines not already wrapped)
    .replace(/^(?!<[hupltd]|$)(.+)$/gm, '<p>$1</p>')
    // Clean up extra whitespace
    .replace(/\n{2,}/g, '\n');
}

// Plan-first modal
function showModal() {
  document.getElementById("plan-modal").style.display = "flex";
}
function dismissModal() {
  document.getElementById("plan-modal").style.display = "none";
}

// Mode switching
function setMode(mode) {
  ws.send(JSON.stringify({ type: "set_mode", mode }));
}

function updateModeUI(mode) {
  currentMode = mode;
  for (const btn of modeToggleEl.querySelectorAll(".mode-btn")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  modeHintEl.textContent = mode === "plan" ? "SPEC.md only" : "All files";
  document.body.setAttribute("data-mode", mode);
}

// Image attachment handling
fileInputEl.addEventListener("change", () => {
  for (const file of fileInputEl.files) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1];
      pendingImages.push({ data: base64, mimeType: file.type });
      renderImagePreview();
    };
    reader.readAsDataURL(file);
  }
  fileInputEl.value = "";
});

function renderImagePreview() {
  imagePreviewEl.innerHTML = "";
  if (pendingImages.length === 0) {
    imagePreviewEl.style.display = "none";
    return;
  }
  imagePreviewEl.style.display = "";
  pendingImages.forEach((img, i) => {
    const wrap = document.createElement("div");
    wrap.className = "preview-thumb";
    const thumb = document.createElement("img");
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    wrap.appendChild(thumb);
    const removeBtn = document.createElement("button");
    removeBtn.className = "preview-remove";
    removeBtn.textContent = "×";
    removeBtn.onclick = () => {
      pendingImages.splice(i, 1);
      renderImagePreview();
    };
    wrap.appendChild(removeBtn);
    imagePreviewEl.appendChild(wrap);
  });
}

// Paste images from clipboard
inputEl.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    e.preventDefault();
    const file = item.getAsFile();
    const reader = new FileReader();
    reader.onload = () => {
      pendingImages.push({ data: reader.result.split(",")[1], mimeType: file.type });
      renderImagePreview();
    };
    reader.readAsDataURL(file);
  }
});

// Drag and drop images
const dropZone = document.getElementById("chat-footer");
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  for (const file of e.dataTransfer.files) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      pendingImages.push({ data: reader.result.split(",")[1], mimeType: file.type });
      renderImagePreview();
    };
    reader.readAsDataURL(file);
  }
});

function resetProject() {
  // Clear chat
  messagesEl.innerHTML = "";
  // Reset project state
  projectSet = false;
  projectNameEl.value = "";
  projectNameEl.disabled = false;
  projectStartBtn.disabled = false;
  projectErrorEl.textContent = "";
  // Show project prompt, hide chat footer and buttons
  projectPromptEl.style.display = "";
  chatFooterEl.style.display = "none";
  newProjectBtn.style.display = "none";
  document.getElementById("spec-btn").style.display = "none";
  document.getElementById("m-spec-btn").style.display = "none";
  document.getElementById("m-new-project-btn").style.display = "none";
  document.getElementById("project-label").style.display = "none";
  document.getElementById("usage-block").style.display = "none";
  if (usageInterval) { clearInterval(usageInterval); usageInterval = null; }
  currentProjectName = null;
  // Reset to plan mode
  updateModeUI("plan");
  // Reconnect to get a fresh server-side session
  ws.close();
}

// Usage display
let oauthEnabled = null;

async function refreshUsage() {
  if (oauthEnabled === false) return;
  if (oauthEnabled === null) {
    try {
      const cfg = await fetch("/api/config");
      oauthEnabled = cfg.ok && (await cfg.json()).oauth === true;
    } catch {
      oauthEnabled = false;
    }
    if (!oauthEnabled) return;
  }
  try {
    const res = await fetch("/api/usage");
    const data = await res.json();
    const block = document.getElementById("usage-block");
    if (!data.windows || data.windows.length === 0) {
      block.style.display = "none";
      return;
    }
    block.style.display = "";
    block.innerHTML = data.windows.map((w) => {
      const pct = Math.round(w.usedPercent);
      const color = pct > 80 ? "var(--red)" : pct > 50 ? "var(--amber)" : "var(--green)";
      return `<div class="usage-item">
        <span class="usage-label">${w.label}</span>
        <div class="usage-bar"><div class="usage-fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="usage-pct">${pct}%</span>
      </div>`;
    }).join("");
  } catch {}
}

let usageInterval = null;

connect();
