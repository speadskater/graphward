import { multiply } from "./math.js";

export function handleRequest(input) {
  return formatResponse(multiply(input, 2));
}

function formatResponse(value) {
  return { value };
}
