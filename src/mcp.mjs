import { createInterface } from "node:readline";
import { DEFAULT_PROTOCOL, SUPPORTED_PROTOCOLS, VERSION } from "./constants.mjs";
import { callTool, TOOL_DEFINITIONS } from "./tools.mjs";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcError(id, code, message, data = undefined) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function handleRequest(request, context) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return jsonRpcError(request?.id ?? null, -32600, "Invalid Request");
  }
  const id = request.id;
  const isNotification = id === undefined;
  try {
    let result;
    switch (request.method) {
      case "initialize": {
        const requested = request.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
        result = {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "graphward", title: "Graphward Code Memory", version: VERSION },
          instructions: "Use Graphward directly from any project. On the first repository-scoped call, Graphward indexes a missing current project, reports progress when supported, waits for completion, and then returns the requested result. Use find_symbol/find_code followed by get_symbol_context or get_impact. Record durable rationale with record_decision.",
        };
        break;
      }
      case "server/discover":
        result = {
          resultType: "complete",
          supportedVersions: SUPPORTED_PROTOCOLS,
          capabilities: { tools: {} },
          serverInfo: { name: "graphward", title: "Graphward Code Memory", version: VERSION },
          instructions: "Local-only code indexing, graph analysis, change episodes, and decision memory.",
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOL_DEFINITIONS };
        break;
      case "tools/call": {
        const name = request.params?.name;
        if (typeof name !== "string") return jsonRpcError(id ?? null, -32602, "tools/call requires params.name");
        try {
          const progressToken = request.params?._meta?.progressToken;
          const reportProgress = ({ stage, message }) => {
            console.error(`[graphward] ${message}`);
            if (progressToken == null) return;
            const progressByStage = { starting: 0, scanned: 1, parsed: 2, complete: 3 };
            writeMessage({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken,
                progress: progressByStage[stage] ?? 2,
                total: 3,
                message,
              },
            });
          };
          const output = await callTool(name, request.params?.arguments ?? {}, { ...context, reportProgress });
          result = {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
            isError: false,
          };
        } catch (error) {
          result = {
            content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
            isError: true,
          };
        }
        break;
      }
      case "logging/setLevel":
        result = {};
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      default:
        if (isNotification) return null;
        return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (isNotification) return null;
    return jsonRpcError(id, -32603, "Internal error", { message: error.message });
  }
}

export async function serveMcp(context) {
  const mcpContext = { ...context, surface: "mcp", autoIndexJobs: new Map() };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  console.error(`Graphward ${VERSION} MCP server running on stdio (offline)`);
  for await (const line of input) {
    if (!line.trim()) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      writeMessage(jsonRpcError(null, -32700, "Parse error"));
      continue;
    }
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((item) => handleRequest(item, mcpContext)))).filter(Boolean);
      if (responses.length) writeMessage(responses);
    } else {
      const response = await handleRequest(payload, mcpContext);
      if (response) writeMessage(response);
    }
  }
}
