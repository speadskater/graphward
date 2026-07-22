export async function loadAbsoluteUser(id) {
  return fetch(`http://users.local/users/${id}`, { method: "GET" });
}

export async function loadMissingUser(id) {
  return fetch(`http://users.local/missing/${id}`, { method: "GET" });
}
