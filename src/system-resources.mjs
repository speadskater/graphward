import os from "node:os";

const MIB = 1024 ** 2;
const MIN_HEAP_MB = 512;
const MAX_ADAPTIVE_HEAP_MB = 32 * 1024;
const HEAP_INCREMENT_MB = 256;
const MIN_SYSTEM_RESERVE_MB = 2 * 1024;
const SYSTEM_RESERVE_SHARE = 0.20;
const TOTAL_MEMORY_HEAP_SHARE = 0.75;

function memoryMegabytes(value, name, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} byte count`);
  }
  return Math.floor(value / MIB);
}

function configuredHeapLimit(environment) {
  const raw = environment.GRAPHWARD_MAX_HEAP_MB;
  if (raw == null || String(raw).trim() === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_HEAP_MB) {
    throw new Error(`GRAPHWARD_MAX_HEAP_MB must be an integer of at least ${MIN_HEAP_MB}`);
  }
  return value;
}

export function getSystemResourcePlan({
  totalMemoryBytes = os.totalmem(),
  availableMemoryBytes = os.freemem(),
  environment = process.env,
} = {}) {
  const totalMemoryMb = Math.max(1, memoryMegabytes(totalMemoryBytes, "totalMemoryBytes"));
  const availableMemoryMb = Math.min(
    totalMemoryMb,
    memoryMegabytes(availableMemoryBytes, "availableMemoryBytes", { allowZero: true }),
  );
  const reserveMemoryMb = Math.max(MIN_SYSTEM_RESERVE_MB, Math.ceil(totalMemoryMb * SYSTEM_RESERVE_SHARE));
  const overrideHeapMb = configuredHeapLimit(environment);

  let heapLimitMb = overrideHeapMb;
  let heapSource = "environment";
  if (heapLimitMb == null) {
    const availableBudgetMb = Math.max(MIN_HEAP_MB, availableMemoryMb - reserveMemoryMb);
    const totalBudgetMb = Math.max(MIN_HEAP_MB, Math.floor(totalMemoryMb * TOTAL_MEMORY_HEAP_SHARE));
    const adaptiveBudgetMb = Math.min(MAX_ADAPTIVE_HEAP_MB, availableBudgetMb, totalBudgetMb);
    heapLimitMb = Math.max(MIN_HEAP_MB, Math.floor(adaptiveBudgetMb / HEAP_INCREMENT_MB) * HEAP_INCREMENT_MB);
    heapSource = "adaptive";
  }

  return {
    total_memory_mb: totalMemoryMb,
    available_memory_mb: availableMemoryMb,
    reserve_memory_mb: reserveMemoryMb,
    heap_limit_mb: heapLimitMb,
    heap_source: heapSource,
    override_variable: "GRAPHWARD_MAX_HEAP_MB",
  };
}

export function nodeHeapArgument(resourcePlan) {
  const heapLimitMb = Number(resourcePlan?.heap_limit_mb);
  if (!Number.isSafeInteger(heapLimitMb) || heapLimitMb < MIN_HEAP_MB) {
    throw new Error(`heap_limit_mb must be an integer of at least ${MIN_HEAP_MB}`);
  }
  return `--max-old-space-size=${heapLimitMb}`;
}
