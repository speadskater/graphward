const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);

export function normalizeHttpMethod(value, fallback = "ANY") {
  const method = String(value ?? fallback).toUpperCase();
  return HTTP_METHODS.has(method) ? method : fallback;
}

export function normalizeApiPath(value) {
  if (!value) return null;
  let result = String(value).trim();
  if (!result) return null;

  result = result.replace(/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^/]+/, "");
  result = result.replace(/^\$\{[^}]*\}/, "");
  result = result.split(/[?#]/, 1)[0];
  result = result
    .replace(/\$\{[^}]*\}/g, "{}")
    .replace(/(^|\/)\[[.]{3}[^\]]+\]/g, "$1{}")
    .replace(/(^|\/)\[[^\]]+\]/g, "$1{}")
    .replace(/(^|\/):[A-Za-z_$][\w$-]*/g, "$1{}")
    .replace(/\{[^/{}]+\}/g, "{}")
    .replace(/<[^/<>]+>/g, "{}")
    .replace(/(^|\/)\d+(?=\/|$)/g, "$1{}")
    .replace(/\/+/g, "/");
  result = result.replace(/\{\}$/, (match, offset) => result[offset - 1] === "/" ? match : "");
  if (!result.startsWith("/")) result = `/${result}`;
  if (result.length > 1) result = result.replace(/\/+$/, "");
  return result || "/";
}

export function methodsCompatible(clientMethod, routeMethod) {
  return clientMethod === "ANY" || routeMethod === "ANY" || clientMethod === routeMethod;
}
