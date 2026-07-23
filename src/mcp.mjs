import { createInterface } from "node:readline";
import { DEFAULT_PROTOCOL, SUPPORTED_PROTOCOLS, VERSION } from "./constants.mjs";
import { callTool, TOOL_DEFINITIONS } from "./tools.mjs";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function jsonRpcError(id, code, message, data = undefined) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function validRequestId(id) {
  return id === null || typeof id === "string" || typeof id === "number";
}

function requestIdForError(request) {
  return request && validRequestId(request.id) ? request.id : null;
}

function validRequestEnvelope(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") return false;
  if (request.id !== undefined && !validRequestId(request.id)) return false;
  if (request.params !== undefined && (!request.params || typeof request.params !== "object")) return false;
  return true;
}

function initializeResult(request) {
  const requested = request.params?.protocolVersion;
  const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "graphward", title: "Graphward Code Memory", version: VERSION },
    instructions: "Use Graphward directly from any project. On the first repository-scoped call, Graphward indexes a missing current project and waits for completion. Responses are compact by default; request response_detail=full only for ranking diagnostics. Use the smallest sufficient set of calls and stop once the task has enough evidence.",
  };
}

function discoveryResult() {
  return {
    resultType: "complete",
    supportedVersions: SUPPORTED_PROTOCOLS,
    capabilities: { tools: {} },
    serverInfo: { name: "graphward", title: "Graphward Code Memory", version: VERSION },
    instructions: "Local-only code indexing, graph analysis, change episodes, and decision memory.",
  };
}

function progressReporter(progressToken) {
  return ({ stage, message }) => {
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
}

async function toolCallResult(request, context) {
  const name = request.params?.name;
  if (typeof name !== "string") return { invalid: true };
  try {
    const reportProgress = progressReporter(request.params?._meta?.progressToken);
    const output = await callTool(name, request.params?.arguments ?? {}, { ...context, reportProgress });
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        isError: false,
      },
    };
  } catch (error) {
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true,
      },
    };
  }
}

function standardMethodResult(request) {
  const handlers = {
    initialize: () => initializeResult(request),
    "server/discover": discoveryResult,
    ping: () => ({}),
    "tools/list": () => ({ tools: TOOL_DEFINITIONS }),
    "logging/setLevel": () => ({}),
  };
  return handlers[request.method]?.();
}

const SILENT_NOTIFICATION_METHODS = new Set(["notifications/initialized", "notifications/cancelled"]);

function resultResponse(id, result) {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data = undefined) {
  if (id === undefined) return null;
  return jsonRpcError(id, code, message, data);
}

async function dispatchValidRequest(request, context) {
  const id = request.id;
  if (SILENT_NOTIFICATION_METHODS.has(request.method)) return null;
  if (request.method === "tools/call") {
    const toolCall = await toolCallResult(request, context);
    if (toolCall.invalid) return errorResponse(id, -32602, "tools/call requires params.name");
    return resultResponse(id, toolCall.result);
  }
  const result = standardMethodResult(request);
  if (result === undefined) return errorResponse(id, -32601, `Method not found: ${request.method}`);
  return resultResponse(id, result);
}

async function handleRequest(request, context) {
  if (!validRequestEnvelope(request)) return jsonRpcError(requestIdForError(request), -32600, "Invalid Request");
  try {
    return await dispatchValidRequest(request, context);
  } catch (error) {
    return errorResponse(request.id, -32603, "Internal error", { message: error.message });
  }
}

async function processLine(line, context) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    writeMessage(jsonRpcError(null, -32700, "Parse error"));
    return;
  }
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      writeMessage(jsonRpcError(null, -32600, "Invalid Request"));
      return;
    }
    const responses = (await Promise.all(payload.map((item) => handleRequest(item, context)))).filter(Boolean);
    if (responses.length) writeMessage(responses);
    return;
  }
  const response = await handleRequest(payload, context);
  if (response) writeMessage(response);
}

export async function serveMcp(context) {
  const mcpContext = {
    ...context,
    surface: "mcp",
    autoIndexJobs: new Map(),
    responseEvidenceHashes: new Set(),
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set();
  console.error(`Graphward ${VERSION} MCP server running on stdio (offline)`);
  for await (const line of input) {
    if (!line.trim()) continue;
    const work = processLine(line, mcpContext);
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
  }
  await Promise.allSettled(pending);
}
