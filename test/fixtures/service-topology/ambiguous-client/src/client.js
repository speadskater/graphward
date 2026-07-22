export async function loadRelativeUser(id) {
  return fetch(`/users/${id}`, { method: "GET" });
}
