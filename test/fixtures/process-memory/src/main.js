import { handleOrder } from "./service.js";

export function bootstrap(id) {
  return handleOrder(id);
}

bootstrap("startup");
