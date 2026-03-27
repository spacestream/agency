import { readFile, writeFile, unlink, mkdir, readdir, stat } from "fs/promises";
import { join, resolve, relative } from "path";
import { exec } from "child_process";

// Security: ensure path stays within project directory
function safePath(projectDir, relativePath) {
  const resolved = resolve(projectDir, relativePath);
  if (!resolved.startsWith(resolve(projectDir))) {
    throw new Error("Path escapes project directory");
  }
  return resolved;
}

// Recursive directory listing
async function listDir(dir, base) {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const rel = relative(base, join(dir, entry.name));
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) {
      results.push(rel + "/");
      results.push(...(await listDir(join(dir, entry.name), base)));
    } else {
      results.push(rel);
    }
  }
  return results;
}

// Simple recursive grep
async function searchDir(dir, pattern, glob, base, results) {
  const entries = await readdir(dir, { withFileTypes: true });
  const regex = new RegExp(pattern, "gi");
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await searchDir(full, pattern, glob, base, results);
    } else {
      if (glob && glob !== "*") {
        const ext = glob.replace("*", "");
        if (!entry.name.endsWith(ext)) continue;
      }
      try {
        const content = await readFile(full, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push(`${relative(base, full)}:${i + 1}: ${lines[i].trim()}`);
            regex.lastIndex = 0;
          }
        }
      } catch {
        // skip binary or unreadable files
      }
    }
  }
}

export const TOOLS = {
  read_file: {
    definition: {
      name: "read_file",
      description:
        "Read the contents of a file in the project directory. Returns the file content as text.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
        },
        required: ["path"],
      },
    },
    requiresApproval: false,
  },

  write_file: {
    definition: {
      name: "write_file",
      description:
        "Write content to a file in the project directory. Creates parent directories as needed. Overwrites existing files.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
          content: { type: "string", description: "The full file content to write" },
        },
        required: ["path", "content"],
      },
    },
    requiresApproval: false,
  },

  delete_file: {
    definition: {
      name: "delete_file",
      description:
        "Delete a file from the project directory. This requires user approval before executing.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from project root" },
        },
        required: ["path"],
      },
    },
    requiresApproval: true,
  },

  list_files: {
    definition: {
      name: "list_files",
      description:
        "List all files and directories in the project. Skips node_modules and .git. Returns paths relative to project root.",
      input_schema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path to list. Defaults to project root.",
            default: ".",
          },
        },
      },
    },
    requiresApproval: false,
  },

  search_files: {
    definition: {
      name: "search_files",
      description:
        "Search for a text pattern across project files. Returns matching lines with file paths and line numbers.",
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex pattern to search for" },
          glob: {
            type: "string",
            description: "File extension filter, e.g. '*.js' or '*.py'. Defaults to all files.",
            default: "*",
          },
        },
        required: ["pattern"],
      },
    },
    requiresApproval: false,
  },

  execute_command: {
    definition: {
      name: "execute_command",
      description:
        "Execute a shell command in the project directory. Use for running npm, node, python, git, etc. Requires user approval.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
        },
        required: ["command"],
      },
    },
    requiresApproval: true,
  },

  write_spec: {
    definition: {
      name: "write_spec",
      description:
        "Write or update the SPEC.md planning document in the project root. Use this during planning mode before writing code.",
      input_schema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The full markdown content for SPEC.md" },
        },
        required: ["content"],
      },
    },
    requiresApproval: false,
  },
};

const PLAN_TOOLS = ["read_file", "list_files", "search_files", "write_spec"];

export function getToolDefinitions(mode = "code") {
  if (mode === "plan") {
    return PLAN_TOOLS.map((name) => TOOLS[name].definition);
  }
  return Object.values(TOOLS).map((t) => t.definition);
}

export async function executeTool(name, input, projectDir) {
  switch (name) {
    case "read_file": {
      const filePath = safePath(projectDir, input.path);
      return await readFile(filePath, "utf8");
    }

    case "write_file": {
      const filePath = safePath(projectDir, input.path);
      await mkdir(resolve(filePath, ".."), { recursive: true });
      await writeFile(filePath, input.content, "utf8");
      return `File written: ${input.path}`;
    }

    case "delete_file": {
      const filePath = safePath(projectDir, input.path);
      await unlink(filePath);
      return `File deleted: ${input.path}`;
    }

    case "list_files": {
      const dirPath = safePath(projectDir, input.path || ".");
      const files = await listDir(dirPath, projectDir);
      return files.length ? files.join("\n") : "(empty directory)";
    }

    case "search_files": {
      const results = [];
      await searchDir(projectDir, input.pattern, input.glob, projectDir, results);
      return results.length ? results.join("\n") : "No matches found.";
    }

    case "execute_command": {
      return new Promise((resolve) => {
        exec(input.command, { cwd: projectDir, timeout: 30000 }, (err, stdout, stderr) => {
          const parts = [];
          if (stdout) parts.push(stdout);
          if (stderr) parts.push(`STDERR:\n${stderr}`);
          if (err && err.killed) parts.push("(command timed out after 30s)");
          else if (err) parts.push(`Exit code: ${err.code}`);
          resolve(parts.join("\n") || "(no output)");
        });
      });
    }

    case "write_spec": {
      const specPath = join(projectDir, "SPEC.md");
      await writeFile(specPath, input.content, "utf8");
      return "SPEC.md written successfully.";
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
