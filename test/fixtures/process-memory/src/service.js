import { addFee } from "./math.js";

export function handleOrder(input) {
  return calculateTotal(input);
}

export function calculateTotal(value) {
  return addFee(value);
}
