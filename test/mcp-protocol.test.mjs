import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "..", "src", "cli.mjs");
const MESSAGE_TIMEOUT_MS = 8_000;
const EXIT_TIMEOUT_MS = 4_000;

function waitForExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`MCP process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function startServer(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-mcp-protocol-"));
  const child = spawn(process.execPath, [cli, "serve", "--root", root], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      GRAPHWARD_STATE_DIR: path.join(root, ".graphward-state"),
    },
  });
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const buffered = [];
  const waiters = [];
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  output.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error(`Non-JSON stdout from MCP: ${line}\n${error.message}`));
      }
      return;
    }
    const matchingIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (matchingIndex === -1) {
      buffered.push(message);
      return;
    }
    const [waiter] = waiters.splice(matchingIndex, 1);
    waiter.resolve(message);
  });

  function waitForMessage(predicate = () => true, timeoutMs = MESSAGE_TIMEOUT_MS) {
    const bufferedIndex = buffered.findIndex(predicate);
    if (bufferedIndex !== -1) {
      return Promise.resolve(buffered.splice(bufferedIndex, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for MCP response. stderr:\n${stderr}`));
      }, timeoutMs);
      timeout.unref();
      waiters.push(waiter);
    });
  }

  function send(payload) {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.stdin.destroyed) child.stdin.end();
    try {
      await waitForExit(child);
    } catch (error) {
      child.kill();
      try {
        await waitForExit(child, 2_000);
      } catch {
        throw error;
      }
    }
  }

  t.after(async () => {
    try {
      await stop();
    } finally {
      output.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  return {
    root,
    child,
    send,
    stop,
    waitForMessage,
    bufferedMessages: () => [...buffered],
  };
}

test("recovers from malformed JSON and accepts a request split across writes", async (t) => {
  const server = await startServer(t);

  server.child.stdin.write('{"jsonrpc":"2.0",\n');
  const parseError = await server.waitForMessage();
  assert.deepEqual(parseError, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });

  const request = JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" });
  const split = Math.floor(request.length / 2);
  server.child.stdin.write(request.slice(0, split));
  await new Promise((resolve) => setImmediate(resolve));
  server.child.stdin.write(`${request.slice(split)}\n`);
  const response = await server.waitForMessage((message) => message.id === 11);
  assert.deepEqual(response, { jsonrpc: "2.0", id: 11, result: {} });
});

test("rejects invalid JSON-RPC envelopes without dropping the connection", async (t) => {
  const server = await startServer(t);
  const invalid = [
    null,
    {},
    { jsonrpc: "1.0", id: 21, method: "ping" },
    { jsonrpc: "2.0", id: 22, method: 42 },
    { jsonrpc: "2.0", id: true, method: "ping" },
    { jsonrpc: "2.0", id: 24, method: "ping", params: 42 },
  ];

  for (const payload of invalid) server.send(payload);
  for (let index = 0; index < invalid.length; index += 1) {
    const response = await server.waitForMessage();
    assert.equal(response.error?.code, -32600, `expected Invalid Request for ${JSON.stringify(invalid[index])}`);
  }

  server.child.stdin.write("[]\n");
  server.send({ jsonrpc: "2.0", id: 25, method: "ping" });
  const emptyBatchResponse = await server.waitForMessage();
  assert.deepEqual(emptyBatchResponse, {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request" },
  });
  const recovered = await server.waitForMessage((message) => message.id === 25);
  assert.deepEqual(recovered.result, {});
});

test("notifications never produce responses, including invalid tools/call params", async (t) => {
  const server = await startServer(t);
  server.child.stdin.write([
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", method: "unknown/notification" }),
    JSON.stringify({ jsonrpc: "2.0", id: 31, method: "ping" }),
  ].join("\n") + "\n");

  const barrier = await server.waitForMessage();
  assert.deepEqual(barrier, { jsonrpc: "2.0", id: 31, result: {} });
  assert.deepEqual(server.bufferedMessages(), []);

  server.send([
    { jsonrpc: "2.0", method: "ping" },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
  ]);
  server.send({ jsonrpc: "2.0", id: 32, method: "ping" });
  const batchBarrier = await server.waitForMessage();
  assert.deepEqual(batchBarrier, { jsonrpc: "2.0", id: 32, result: {} });
  assert.deepEqual(server.bufferedMessages(), []);
});

test("returns actionable errors for unknown methods and tools", async (t) => {
  const server = await startServer(t);

  server.send({ jsonrpc: "2.0", id: 41, method: "unknown/method" });
  const unknownMethod = await server.waitForMessage((message) => message.id === 41);
  assert.deepEqual(unknownMethod.error, {
    code: -32601,
    message: "Method not found: unknown/method",
  });

  server.send({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "definitely_not_a_graphward_tool", arguments: {} },
  });
  const unknownTool = await server.waitForMessage((message) => message.id === 42);
  assert.equal(unknownTool.result.isError, true);
  assert.match(unknownTool.result.content[0].text, /Unknown tool: definitely_not_a_graphward_tool/);
});

test("does not let a long tool call head-of-line block a later ping", async (t) => {
  const server = await startServer(t);
  await Promise.all(Array.from({ length: 160 }, (_, index) => (
    writeFile(path.join(server.root, `source-${index}.js`), `export const value${index} = ${index};\n`)
  )));

  server.child.stdin.write([
    JSON.stringify({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: { name: "list_indexed_repositories", arguments: {} },
    }),
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
  ].join("\n") + "\n");

  const firstResponse = await server.waitForMessage((message) => message.id !== undefined);
  assert.equal(firstResponse.id, 7, "ping should not wait behind repository indexing");
  assert.deepEqual(firstResponse.result, {});
  const indexed = await server.waitForMessage((message) => message.id === 51);
  assert.equal(indexed.result.isError, false);
  assert.equal(indexed.result.structuredContent.repositories.length, 1);
});

test("flushes a final partial line and exits cleanly when stdin closes", async (t) => {
  const server = await startServer(t);
  const responsePromise = server.waitForMessage((message) => message.id === 61);
  const exitPromise = waitForExit(server.child);
  server.child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 61, method: "ping" }));

  const [response, exit] = await Promise.all([responsePromise, exitPromise]);
  assert.deepEqual(response, { jsonrpc: "2.0", id: 61, result: {} });
  assert.deepEqual(exit, { code: 0, signal: null });
});
