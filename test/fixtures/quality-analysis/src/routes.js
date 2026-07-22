function routeHandler(request, response) {
  response.json({ ok: true });
}

router.get("/quality", routeHandler);
