import { authorize as guard } from "./auth.js";
import * as auth from "./auth.js";

export interface User {
  active: boolean;
}

export class Controller {
  run(user: User) {
    return guard(user) && auth.authorize(user);
  }
}
