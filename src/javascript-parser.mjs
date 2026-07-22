import path from "node:path";
import { parse } from "@babel/parser";
import { normalizeApiPath, normalizeHttpMethod } from "./api-utils.mjs";

const HTTP_METHOD_NAMES = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const ROUTE_QUALIFIERS = new Set(["app", "router", "server", "fastify"]);
const CLIENT_QUALIFIERS = new Set(["axios", "client", "http", "httpClient", "apiClient", "request", "requests", "got"]);

function propertyName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateName") return node.id?.name ? `#${node.id.name}` : null;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  return null;
}

function bindingName(node) {
  return node?.type === "Identifier" ? node.name : null;
}

function nodeRange(node) {
  return {
    startIndex: Math.max(0, (node.loc?.start.line ?? 1) - 1),
    endIndex: Math.max(0, (node.loc?.end.line ?? node.loc?.start.line ?? 1) - 1),
    nodeStart: node.start ?? 0,
    nodeEnd: node.end ?? node.start ?? 0,
  };
}

function parserPlugins(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const plugins = ["jsx", "decorators-legacy", "importAttributes", "explicitResourceManagement"];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  return plugins;
}

function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node ?? {})) {
    if (["loc", "start", "end", "extra", "errors", "tokens", "comments"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") result.push(item);
    } else if (value && typeof value.type === "string") {
      result.push(value);
    }
  }
  return result;
}

function serializeExpression(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "Super") return "super";
  if (node.type === "StringLiteral") return String(node.value);
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
    const object = serializeExpression(node.object);
    const property = propertyName(node.property);
    return object && property ? `${object}.${property}` : property ?? object;
  }
  if (node.type === "TSNonNullExpression" || node.type === "TSAsExpression" || node.type === "TypeCastExpression") {
    return serializeExpression(node.expression);
  }
  return null;
}

function literalText(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "TemplateLiteral") {
    let result = "";
    for (let index = 0; index < node.quasis.length; index += 1) {
      result += node.quasis[index].value.cooked ?? node.quasis[index].value.raw ?? "";
      if (index < node.expressions.length) result += "${}";
    }
    return result;
  }
  return null;
}

function objectProperty(object, name) {
  if (object?.type !== "ObjectExpression") return null;
  const property = object.properties.find((item) => item.type === "ObjectProperty" && propertyName(item.key) === name);
  return property?.value ?? null;
}

function handlerName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) return serializeExpression(node);
  return null;
}

function apiOperation(node, details, ownerInternalId) {
  const rootQualifier = details.qualifier?.split(".")[0] ?? null;
  const lowerName = details.calleeName.toLowerCase();
  const firstPath = literalText(node.arguments?.[0]);
  if (HTTP_METHOD_NAMES.has(lowerName) && ROUTE_QUALIFIERS.has(rootQualifier) && firstPath) {
    const handler = [...(node.arguments ?? [])].reverse().map(handlerName).find(Boolean) ?? null;
    return {
      ownerInternalId,
      kind: "route",
      method: normalizeHttpMethod(lowerName),
      rawPath: firstPath,
      normalizedPath: normalizeApiPath(firstPath),
      framework: rootQualifier === "fastify" ? "fastify" : "express-like",
      line: node.loc?.start.line ?? null,
      confidence: 0.95,
      handlerName: handler,
    };
  }
  if (lowerName === "use" && ROUTE_QUALIFIERS.has(rootQualifier) && firstPath) {
    const mounted = [...(node.arguments ?? []).slice(1)].reverse().map(handlerName).find(Boolean) ?? null;
    if (!mounted) return null;
    return {
      ownerInternalId,
      kind: "mount",
      method: "ANY",
      rawPath: firstPath,
      normalizedPath: normalizeApiPath(firstPath),
      framework: rootQualifier === "fastify" ? "fastify" : "express-like",
      line: node.loc?.start.line ?? null,
      confidence: 0.95,
      handlerName: mounted,
    };
  }
  if (lowerName === "route" && ROUTE_QUALIFIERS.has(rootQualifier) && node.arguments?.[0]?.type === "ObjectExpression") {
    const config = node.arguments[0];
    const rawPath = literalText(objectProperty(config, "url")) ?? literalText(objectProperty(config, "path"));
    if (!rawPath) return null;
    return {
      ownerInternalId,
      kind: "route",
      method: normalizeHttpMethod(literalText(objectProperty(config, "method"))),
      rawPath,
      normalizedPath: normalizeApiPath(rawPath),
      framework: rootQualifier === "fastify" ? "fastify" : "express-like",
      line: node.loc?.start.line ?? null,
      confidence: 0.95,
      handlerName: handlerName(objectProperty(config, "handler")),
    };
  }
  if (lowerName === "fetch" && !details.qualifier && firstPath) {
    const method = literalText(objectProperty(node.arguments?.[1], "method"));
    return {
      ownerInternalId,
      kind: "client",
      method: normalizeHttpMethod(method, "GET"),
      rawPath: firstPath,
      normalizedPath: normalizeApiPath(firstPath),
      framework: "fetch",
      line: node.loc?.start.line ?? null,
      confidence: 0.99,
      handlerName: null,
    };
  }
  if (HTTP_METHOD_NAMES.has(lowerName) && CLIENT_QUALIFIERS.has(rootQualifier) && firstPath) {
    return {
      ownerInternalId,
      kind: "client",
      method: normalizeHttpMethod(lowerName),
      rawPath: firstPath,
      normalizedPath: normalizeApiPath(firstPath),
      framework: rootQualifier,
      line: node.loc?.start.line ?? null,
      confidence: 0.95,
      handlerName: null,
    };
  }
  if (lowerName === "axios" && !details.qualifier && node.arguments?.[0]?.type === "ObjectExpression") {
    const config = node.arguments[0];
    const rawPath = literalText(objectProperty(config, "url"));
    if (!rawPath) return null;
    return {
      ownerInternalId,
      kind: "client",
      method: normalizeHttpMethod(literalText(objectProperty(config, "method")), "GET"),
      rawPath,
      normalizedPath: normalizeApiPath(rawPath),
      framework: "axios",
      line: node.loc?.start.line ?? null,
      confidence: 0.99,
      handlerName: null,
    };
  }
  if (["request", "apiRequest", "httpRequest"].includes(details.calleeName) && !details.qualifier) {
    const method = literalText(node.arguments?.[0]);
    const rawPath = literalText(node.arguments?.[1]);
    if (method && rawPath) {
      return {
        ownerInternalId,
        kind: "client",
        method: normalizeHttpMethod(method),
        rawPath,
        normalizedPath: normalizeApiPath(rawPath),
        framework: "request-wrapper",
        line: node.loc?.start.line ?? null,
        confidence: 0.9,
        handlerName: null,
      };
    }
  }
  return null;
}

function nextRoutePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  let match = normalized.match(/(?:^|\/)app\/(.+)\/route\.[^.]+$/i);
  if (!match) match = normalized.match(/(?:^|\/)pages\/api\/(.+)\.[^.]+$/i);
  if (!match) return null;
  const segments = match[1]
    .split("/")
    .filter((segment) => segment && !/^\(.+\)$/.test(segment) && !segment.startsWith("@"));
  if (segments.at(-1)?.toLowerCase() === "index") segments.pop();
  return normalizeApiPath(`/${segments.join("/")}`);
}

function calleeDetails(callee) {
  if (!callee || callee.type === "Import") return null;
  if (callee.type === "Identifier") return { calleeName: callee.name, qualifier: null };
  if (callee.type === "TSInstantiationExpression") return calleeDetails(callee.expression);
  if (["MemberExpression", "OptionalMemberExpression"].includes(callee.type)) {
    const calleeName = propertyName(callee.property);
    if (!calleeName) return null;
    return { calleeName, qualifier: serializeExpression(callee.object) };
  }
  return null;
}

function isRequireCall(node) {
  return node?.type === "CallExpression"
    && node.callee?.type === "Identifier"
    && node.callee.name === "require"
    && node.arguments?.[0]?.type === "StringLiteral";
}

function formatParseError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    reason_code: error?.reasonCode ?? null,
    line: error?.loc?.line ?? null,
    column: error?.loc?.column ?? null,
  };
}

export function parseJavaScriptSource(content, relativePath) {
  let ast;
  try {
    ast = parse(content, {
      sourceFilename: relativePath,
      sourceType: "unambiguous",
      allowAwaitOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      errorRecovery: true,
      plugins: parserPlugins(relativePath),
    });
  } catch (error) {
    const diagnostic = formatParseError(error);
    return {
      ok: false,
      definitions: [],
      imports: [],
      calls: [],
      apiOperations: [],
      error: diagnostic,
      parser: { mode: "babel-failed", diagnostics: [diagnostic] },
    };
  }

  const definitions = [];
  const definitionByNode = new WeakMap();
  let nextDefinitionId = 1;
  const addDefinition = (node, values) => {
    if (!values.name) return null;
    const definition = {
      internalId: nextDefinitionId++,
      ...nodeRange(values.rangeNode ?? node),
      exported: Boolean(values.exported),
      ...values,
    };
    delete definition.rangeNode;
    definitions.push(definition);
    definitionByNode.set(node, definition);
    return definition;
  };

  const collectDefinitions = (node, context = {}) => {
    if (!node) return;
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) collectDefinitions(node.declaration, { ...context, exported: true });
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      if (declaration?.type === "FunctionDeclaration" && !declaration.id) {
        addDefinition(declaration, { name: "default", qualifiedName: "default", kind: "Function", exported: true, rangeNode: node });
        collectDefinitions(declaration.body, context);
      } else if (declaration?.type === "ClassDeclaration" && !declaration.id) {
        addDefinition(declaration, { name: "default", qualifiedName: "default", kind: "Class", exported: true, rangeNode: node });
        collectDefinitions(declaration.body, { ...context, className: "default" });
      } else {
        collectDefinitions(declaration, { ...context, exported: true });
      }
      return;
    }

    if (node.type === "FunctionDeclaration") {
      const name = bindingName(node.id);
      addDefinition(node, { name, qualifiedName: name, kind: "Function", exported: context.exported });
      collectDefinitions(node.body, { ...context, exported: false });
      return;
    }

    if (node.type === "ClassDeclaration") {
      const name = bindingName(node.id);
      addDefinition(node, { name, qualifiedName: name, kind: "Class", exported: context.exported });
      collectDefinitions(node.body, { ...context, className: name, objectName: null, exported: false });
      return;
    }

    if (node.type === "VariableDeclaration") {
      for (const declarator of node.declarations) {
        const name = bindingName(declarator.id);
        const value = declarator.init;
        const isExportedRegistryValue = Boolean(context.exported && name && /^[A-Z][A-Z0-9_]*$/.test(name));
        if (name && ["ArrowFunctionExpression", "FunctionExpression"].includes(value?.type)) {
          addDefinition(declarator, { name, qualifiedName: name, kind: "Function", exported: context.exported, rangeNode: node });
          collectDefinitions(value.body, { ...context, exported: false });
        } else if (name && value?.type === "ClassExpression") {
          addDefinition(declarator, { name, qualifiedName: name, kind: "Class", exported: context.exported, rangeNode: node });
          collectDefinitions(value.body, { ...context, className: name, objectName: null, exported: false });
        } else if (name && value?.type === "ObjectExpression") {
          if (isExportedRegistryValue) addDefinition(declarator, { name, qualifiedName: name, kind: node.kind === "const" ? "Constant" : "Variable", exported: true, rangeNode: node });
          collectDefinitions(value, { ...context, objectName: name, exported: false });
        } else {
          if (isExportedRegistryValue) addDefinition(declarator, { name, qualifiedName: name, kind: node.kind === "const" ? "Constant" : "Variable", exported: true, rangeNode: node });
          collectDefinitions(value, { ...context, exported: false });
        }
      }
      return;
    }

    if (["ClassMethod", "ClassPrivateMethod", "TSDeclareMethod"].includes(node.type)) {
      const name = propertyName(node.key);
      const qualifiedName = context.className && name ? `${context.className}.${name}` : name;
      addDefinition(node, {
        name,
        qualifiedName,
        kind: node.kind === "constructor" ? "Constructor" : "Method",
        exported: false,
      });
      collectDefinitions(node.body, { ...context, exported: false });
      return;
    }

    if (node.type === "ObjectMethod") {
      const name = propertyName(node.key);
      const qualifiedName = context.objectName && name ? `${context.objectName}.${name}` : name;
      addDefinition(node, { name, qualifiedName, kind: "Method", exported: context.exported });
      collectDefinitions(node.body, { ...context, exported: false });
      return;
    }

    if (node.type === "ObjectProperty" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.value?.type)) {
      const name = propertyName(node.key);
      const qualifiedName = context.objectName && name ? `${context.objectName}.${name}` : name;
      addDefinition(node, { name, qualifiedName, kind: "Method", exported: context.exported });
      collectDefinitions(node.value.body, { ...context, exported: false });
      return;
    }

    const typeKinds = {
      TSInterfaceDeclaration: "Interface",
      TSTypeAliasDeclaration: "TypeAlias",
      TSEnumDeclaration: "Enum",
      TSModuleDeclaration: "Namespace",
    };
    if (typeKinds[node.type]) {
      const name = bindingName(node.id) ?? propertyName(node.id);
      addDefinition(node, { name, qualifiedName: name, kind: typeKinds[node.type], exported: context.exported });
      return;
    }

    for (const child of children(node)) collectDefinitions(child, context);
  };
  collectDefinitions(ast.program);

  const importsBySpecifier = new Map();
  const addImport = (specifier, binding = null) => {
    if (!specifier) return;
    const imported = importsBySpecifier.get(specifier) ?? { specifier, bindings: [] };
    if (binding) {
      const key = JSON.stringify(binding);
      if (!imported.bindings.some((value) => JSON.stringify(value) === key)) imported.bindings.push(binding);
    }
    importsBySpecifier.set(specifier, imported);
  };

  const collectImports = (node, parent = null) => {
    if (!node) return;
    if (node.type === "ImportDeclaration") {
      const specifier = node.source?.value;
      if (!node.specifiers.length) addImport(specifier, { kind: "side-effect", local: null, imported: null });
      for (const item of node.specifiers) {
        if (item.type === "ImportDefaultSpecifier") addImport(specifier, { kind: "default", local: item.local.name, imported: "default" });
        if (item.type === "ImportNamespaceSpecifier") addImport(specifier, { kind: "namespace", local: item.local.name, imported: "*" });
        if (item.type === "ImportSpecifier") addImport(specifier, { kind: "named", local: item.local.name, imported: propertyName(item.imported) });
      }
    } else if (["ExportAllDeclaration", "ExportNamedDeclaration"].includes(node.type) && node.source?.value) {
      addImport(node.source.value, { kind: "re-export", local: null, imported: "*" });
    } else if (node.type === "VariableDeclarator") {
      let required = node.init;
      let importedName = null;
      if (["MemberExpression", "OptionalMemberExpression"].includes(required?.type) && isRequireCall(required.object)) {
        importedName = propertyName(required.property);
        required = required.object;
      }
      if (isRequireCall(required)) {
        const specifier = required.arguments[0].value;
        if (node.id.type === "Identifier") {
          addImport(specifier, importedName
            ? { kind: "named", local: node.id.name, imported: importedName }
            : { kind: "commonjs", local: node.id.name, imported: "default" });
        } else if (node.id.type === "ObjectPattern") {
          for (const property of node.id.properties) {
            const imported = propertyName(property.key);
            const local = bindingName(property.value) ?? bindingName(property.argument);
            if (imported && local) addImport(specifier, { kind: "named", local, imported });
          }
        }
      }
    } else if (isRequireCall(node) && parent?.type === "ExpressionStatement") {
      addImport(node.arguments[0].value, { kind: "side-effect", local: null, imported: null });
    }
    for (const child of children(node)) collectImports(child, node);
  };
  collectImports(ast.program);

  const calls = [];
  const apiOperations = [];
  const collectCalls = (node, ownerInternalId = null) => {
    if (!node) return;
    const owner = definitionByNode.get(node);
    const currentOwnerId = owner && !["Interface", "TypeAlias", "Enum", "Namespace"].includes(owner.kind)
      ? owner.internalId
      : ownerInternalId;
    if (["CallExpression", "OptionalCallExpression", "NewExpression"].includes(node.type) && !isRequireCall(node)) {
      const details = calleeDetails(node.callee);
      if (details) {
        calls.push({
          ...details,
          ownerInternalId: currentOwnerId,
          callLine: node.loc?.start.line ?? null,
          syntax: node.type === "NewExpression" ? "construct" : "call",
        });
        const operation = apiOperation(node, details, currentOwnerId);
        if (operation) apiOperations.push(operation);
      }
    }
    for (const child of children(node)) collectCalls(child, currentOwnerId);
  };
  collectCalls(ast.program);

  const collectApiLiterals = (node, ownerInternalId = null) => {
    if (!node) return;
    const owner = definitionByNode.get(node);
    const currentOwnerId = owner && !["Interface", "TypeAlias", "Enum", "Namespace"].includes(owner.kind)
      ? owner.internalId
      : ownerInternalId;
    let rawPath = null;
    let registryName = null;
    if (node.type === "ObjectProperty") {
      registryName = propertyName(node.key);
      rawPath = literalText(node.value);
      if (!rawPath && node.value?.type === "ArrowFunctionExpression") rawPath = literalText(node.value.body);
    } else if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      registryName = node.id.name;
      rawPath = literalText(node.init);
    }
    if (rawPath && (rawPath.startsWith("/") || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(rawPath))) {
      apiOperations.push({
        ownerInternalId: currentOwnerId,
        kind: "client",
        method: "ANY",
        rawPath,
        normalizedPath: normalizeApiPath(rawPath),
        framework: "endpoint-registry",
        line: node.loc?.start.line ?? null,
        confidence: 0.75,
        handlerName: registryName,
      });
    }
    for (const child of children(node)) collectApiLiterals(child, currentOwnerId);
  };
  collectApiLiterals(ast.program);

  const inferredRoutePath = nextRoutePath(relativePath);
  if (inferredRoutePath) {
    for (const definition of definitions) {
      if (!definition.exported || !HTTP_METHOD_NAMES.has(definition.name.toLowerCase())) continue;
      apiOperations.push({
        ownerInternalId: definition.internalId,
        kind: "route",
        method: normalizeHttpMethod(definition.name),
        rawPath: inferredRoutePath,
        normalizedPath: inferredRoutePath,
        framework: "nextjs",
        line: definition.startIndex + 1,
        confidence: 0.99,
        handlerName: definition.qualifiedName,
      });
    }
  }

  const diagnostics = (ast.errors ?? []).slice(0, 50).map(formatParseError);
  return {
    ok: true,
    definitions,
    imports: [...importsBySpecifier.values()],
    calls,
    apiOperations,
    parser: {
      mode: diagnostics.length ? "babel-recovered" : "babel",
      diagnostics,
    },
  };
}
