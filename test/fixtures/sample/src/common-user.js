const authorize = require("./auth.js");

export function commonCaller(user) {
  return authorize(user);
}
