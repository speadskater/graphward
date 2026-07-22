const app = {};

export function handleUser(request) {
  return { id: request.params.id };
}

app.get("/users/:id", handleUser);
