import { formatResult, processCode } from "./policy.js";

export function runLocal(source) {
  return formatResult(processCode(source));
}
