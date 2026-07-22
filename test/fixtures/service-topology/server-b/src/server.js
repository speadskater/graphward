const app = {};

export function duplicateUserHandler(request) {
  return { id: request.params.id, duplicate: true };
}

app.get("/users/:id", duplicateUserHandler);
