import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSystemResourcePlan, nodeHeapArgument } from "../src/system-resources.mjs";
import {
  buildGraphwardServiceArguments,
  getDefaultGraphwardDatabasePath,
  getGraphwardServiceStatus,
  startGraphwardService,
  stopGraphwardService,
} from "../src/service-lifecycle.mjs";

const GIB = 1024 ** 3;

test("sizes the Node heap from total and currently available memory", () => {
  const workstation = getSystemResourcePlan({
    totalMemoryBytes: 64 * GIB,
    availableMemoryBytes: 48 * GIB,
    environment: {},
  });
  assert.deepEqual(workstation, {
    total_memory_mb: 65_536,
    available_memory_mb: 49_152,
    reserve_memory_mb: 13_108,
    heap_limit_mb: 32_768,
    heap_source: "adaptive",
    override_variable: "GRAPHWARD_MAX_HEAP_MB",
  });
  assert.equal(nodeHeapArgument(workstation), "--max-old-space-size=32768");

  const laptop = getSystemResourcePlan({
    totalMemoryBytes: 16 * GIB,
    availableMemoryBytes: 12 * GIB,
    environment: {},
  });
  assert.equal(laptop.reserve_memory_mb, 3_277);
  assert.equal(laptop.heap_limit_mb, 8_960);
});

test("keeps a minimum heap under memory pressure and accepts an explicit override", () => {
  const pressured = getSystemResourcePlan({
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 2 * GIB,
    environment: {},
  });
  assert.equal(pressured.heap_limit_mb, 512);

  const overridden = getSystemResourcePlan({
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 2 * GIB,
    environment: { GRAPHWARD_MAX_HEAP_MB: "12288" },
  });
  assert.equal(overridden.heap_limit_mb, 12_288);
  assert.equal(overridden.heap_source, "environment");
  assert.equal(nodeHeapArgument(overridden), "--max-old-space-size=12288");

  assert.throws(() => getSystemResourcePlan({
    totalMemoryBytes: 8 * GIB,
    availableMemoryBytes: 2 * GIB,
    environment: { GRAPHWARD_MAX_HEAP_MB: "four gigs" },
  }), /GRAPHWARD_MAX_HEAP_MB/);
});

test("builds a user-scoped dashboard launch without indexing one repository", () => {
  const resourcePlan = getSystemResourcePlan({
    totalMemoryBytes: 16 * GIB,
    availableMemoryBytes: 12 * GIB,
    environment: {},
  });
  const args = buildGraphwardServiceArguments({
    cliPath: "C:\\graphward\\src\\cli.mjs",
    initialRoot: "C:\\Users\\example",
    databasePath: "C:\\Users\\example\\AppData\\Local\\Graphward\\index.sqlite",
    host: "127.0.0.1",
    port: 7331,
    resourcePlan,
  });
  assert.ok(args.includes("--watch-indexed"));
  assert.equal(args.includes("--index"), false);
  assert.equal(args.includes("--watch"), false);
});

test("rejects a missing initial browser folder before spawning Node", async () => {
  await assert.rejects(startGraphwardService({
    cliPath: "C:\\graphward\\src\\cli.mjs",
    initialRoot: "C:\\path\\that\\does\\not\\exist",
    databasePath: "C:\\path\\that\\does\\not\\exist\\.graphward\\index.sqlite",
  }), /initial folder does not exist or is not a directory/);
});

test("rejects a port already owned by another dashboard", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "graphward-resource-root-"));
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "graphward-resource-state-"));
  const previousStateDirectory = process.env.GRAPHWARD_STATE_DIR;
  process.env.GRAPHWARD_STATE_DIR = stateDirectory;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("occupied");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousStateDirectory == null) delete process.env.GRAPHWARD_STATE_DIR;
    else process.env.GRAPHWARD_STATE_DIR = previousStateDirectory;
    await rm(root, { recursive: true, force: true });
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const address = server.address();

  await assert.rejects(startGraphwardService({
    cliPath: path.resolve("src/cli.mjs"),
    initialRoot: root,
    databasePath: path.join(root, ".graphward", "index.sqlite"),
    port: address.port,
  }), /already serving another dashboard/);
});

test("uses one user-scoped database and service state regardless of the current folder", async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "graphward-global-state-"));
  const previousStateDirectory = process.env.GRAPHWARD_STATE_DIR;
  process.env.GRAPHWARD_STATE_DIR = stateDirectory;
  t.after(async () => {
    if (previousStateDirectory == null) delete process.env.GRAPHWARD_STATE_DIR;
    else process.env.GRAPHWARD_STATE_DIR = previousStateDirectory;
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const database = getDefaultGraphwardDatabasePath();
  assert.equal(database, path.join(stateDirectory, "index.sqlite"));
  const status = getGraphwardServiceStatus();
  assert.equal(status.running, false);
  assert.equal(status.scope, "user");
  assert.equal(status.state_file, path.join(stateDirectory, "service-7331.json"));
  assert.equal("root" in status, false);
});

test("plain status and stop discover a running legacy root-scoped service", async (t) => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "graphward-legacy-state-"));
  const previousStateDirectory = process.env.GRAPHWARD_STATE_DIR;
  process.env.GRAPHWARD_STATE_DIR = stateDirectory;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true });
  let childExited = false;
  child.once("exit", () => { childExited = true; });
  t.after(async () => {
    if (!childExited) child.kill();
    if (previousStateDirectory == null) delete process.env.GRAPHWARD_STATE_DIR;
    else process.env.GRAPHWARD_STATE_DIR = previousStateDirectory;
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const legacyStateFile = path.join(stateDirectory, "legacy-root-hash.json");
  await writeFile(legacyStateFile, JSON.stringify({
    pid: child.pid,
    root: "C:\\legacy\\repository",
    database: "C:\\legacy\\repository\\.graphward\\index.sqlite",
    port: 7444,
  }));

  const status = getGraphwardServiceStatus({ port: 7444 });
  assert.equal(status.running, true);
  assert.equal(status.scope, "legacy");
  assert.equal(status.state_file, legacyStateFile);
  const stopped = stopGraphwardService({ port: 7444 });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.running, false);
  await new Promise((resolve) => child.once("exit", resolve));
});
