const AGENT_URL = process.env.REMOTE_DEBUG_AGENT_URL || "http://127.0.0.1:3000";
const PROTOCOL_VERSION = "2024-11-05";

const tools = [
  {
    name: "remote_debug_run_command",
    description:
      "Run a whitelisted read-only Linux diagnostic command through the local Remote Debug Agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["cmd"],
      properties: {
        cmd: {
          type: "string",
          description: "Command such as 'netstat -tlnp' or 'tail -n 100 /var/log/nginx/error.log'.",
        },
        timeoutMs: {
          type: "number",
          description: "Optional timeout in milliseconds. The agent clamps it to the configured maximum.",
        },
      },
    },
  },
  {
    name: "remote_debug_read_file",
    description:
      "Read a remote file under /var/log, /etc/nginx, or /home/app through SFTP path checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote file path.",
        },
        maxBytes: {
          type: "number",
          description: "Optional maximum bytes to return. The agent clamps it to the configured maximum.",
        },
      },
    },
  },
  {
    name: "remote_debug_list_dir",
    description:
      "List a remote directory under /var/log, /etc/nginx, or /home/app through SFTP path checks.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute remote directory path.",
        },
      },
    },
  },
];

function sendMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function callAgent(path, payload) {
  const response = await fetch(new URL(path, AGENT_URL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Remote-Debug-Source": "codex-plugin",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { ok: false, raw: text };
  }

  if (!response.ok || parsed.ok === false) {
    const message = parsed.error?.message || `agent request failed with HTTP ${response.status}`;
    const code = parsed.error?.code || "AGENT_REQUEST_FAILED";
    const error = new Error(message);
    error.code = code;
    error.payload = parsed;
    throw error;
  }

  return parsed;
}

async function callTool(name, args) {
  if (name === "remote_debug_run_command") {
    return callAgent("/run", {
      cmd: args?.cmd,
      timeoutMs: args?.timeoutMs,
    });
  }

  if (name === "remote_debug_read_file") {
    return callAgent("/read-file", {
      path: args?.path,
      maxBytes: args?.maxBytes,
    });
  }

  if (name === "remote_debug_list_dir") {
    return callAgent("/list-dir", {
      path: args?.path,
    });
  }

  const error = new Error(`unknown tool: ${name}`);
  error.code = "UNKNOWN_TOOL";
  throw error;
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "remote-debug-agent",
        version: "1.0.0",
      },
    });
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      sendResult(id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      });
    } catch (error) {
      sendResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                ok: false,
                error: {
                  code: error.code || "TOOL_CALL_FAILED",
                  message: error.message,
                },
                details: error.payload,
              },
              null,
              2,
            ),
          },
        ],
      });
    }
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `method not found: ${method}`);
  }
}

let inputBuffer = Buffer.alloc(0);

function parseMessages() {
  while (true) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const contentLengthMatch = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!contentLengthMatch) {
      throw new Error("missing Content-Length header");
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (inputBuffer.length < bodyEnd) {
      return;
    }

    const body = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyEnd);
    const message = JSON.parse(body);

    if (message.method && message.id === undefined) {
      continue;
    }

    handleRequest(message).catch((error) => {
      if (message.id !== undefined) {
        sendError(message.id, -32603, error.message);
      }
    });
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  parseMessages();
});

process.stdin.on("error", (error) => {
  console.error(error);
});
