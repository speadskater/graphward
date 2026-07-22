export function add(a, b) {
  return a + b;
}

export function multiply(value, factor) {
  return add(value, value * (factor - 1));
}
