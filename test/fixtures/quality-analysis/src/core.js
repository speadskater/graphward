export function exportedApi(value) {
  const label = "exported";
  return coordinator([value], label);
}

function coordinator(values, label) {
  const enabled = label === "exported";
  return complexWorker(values, enabled);
}

function complexWorker(items, enabled) {
  let total = 0;
  for (const item of items) {
    if (item > 0 && enabled) {
      total += item;
    } else if (item < 0 || !enabled) {
      total -= item;
    } else {
      total += enabled ? 1 : 0;
    }
  }
  try {
    return total > 10 ? Math.floor(total) : total;
  } catch (error) {
    return 0;
  }
}

function unusedHelper(value) {
  const marker = "unused";
  return value + marker.length;
}

function reflectedOnly() {
  return "reflected";
}

function dispatch(registry) {
  const hook = "reflectedOnly";
  return registry[hook]();
}

function loader() {
  return "framework hook";
}

class InternalWorker {
  _unusedMethod() {
    return "method";
  }
}
