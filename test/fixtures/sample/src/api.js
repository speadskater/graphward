export const ENDPOINTS = { USER: "/users/:id" };

export async function loadUser(id) {
  return fetch(`/users/${id}`, { method: "GET" });
}
