import path from "node:path";
import { parse } from "@babel/parser";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const HTTP_CLIENT_ROOTS = new Set([
  "axios",
  "api",
  "apiClient",
  "client",
  "got",
  "http",
  "httpClient",
  "request",
  "requests",
]);
const TYPE_DECLARATIONS = new Set([
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSModuleDeclaration",
]);

function parserPlugins(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  const plugins = ["jsx", "decorators-legacy", "importAttributes", "explicitResourceManagement"];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) plugins.push("typescript");
  return plugins;
}

function formatParseError(error) {
  return {
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    reasonCode: error?.reasonCode ?? null,
    line: error?.loc?.line ?? null,
    column: error?.loc?.column ?? null,
  };
}

function span(node) {
  return {
    start: {
      line: node?.loc?.start.line ?? 1,
      column: node?.loc?.start.column ?? 0,
      index: node?.start ?? 0,
    },
    end: {
      line: node?.loc?.end.line ?? node?.loc?.start.line ?? 1,
      column: node?.loc?.end.column ?? node?.loc?.start.column ?? 0,
      index: node?.end ?? node?.start ?? 0,
    },
  };
}

function sourceText(node, content) {
  if (!node || !Number.isInteger(node.start) || !Number.isInteger(node.end)) return null;
  return content.slice(node.start, node.end);
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

function unwrapExpression(node) {
  let current = node;
  while ([
    "TSAsExpression",
    "TSSatisfiesExpression",
    "TSNonNullExpression",
    "TypeCastExpression",
    "ParenthesizedExpression",
    "ChainExpression",
  ].includes(current?.type)) current = current.expression;
  return current;
}

function staticName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "PrivateName") return node.id?.name ? `#${node.id.name}` : null;
  if (["StringLiteral", "NumericLiteral"].includes(node.type)) return String(node.value);
  return null;
}

function expressionPath(node) {
  const current = unwrapExpression(node);
  if (!current) return null;
  if (current.type === "Identifier") return current.name;
  if (current.type === "ThisExpression") return "this";
  if (current.type === "Super") return "super";
  if (["MemberExpression", "OptionalMemberExpression"].includes(current.type)) {
    const object = expressionPath(current.object);
    const property = current.computed
      ? staticName(current.property)
      : staticName(current.property);
    if (!object || !property) return null;
    return `${object}.${property}`;
  }
  if (["CallExpression", "OptionalCallExpression", "NewExpression"].includes(current.type)) {
    return expressionPath(current.callee);
  }
  return null;
}

function typeTargetName(node) {
  const current = unwrapExpression(node);
  if (!current) return null;
  if (current.type === "Identifier") return current.name;
  if (current.type === "TSQualifiedName") {
    const left = typeTargetName(current.left);
    const right = typeTargetName(current.right);
    return left && right ? `${left}.${right}` : left ?? right;
  }
  if (["MemberExpression", "OptionalMemberExpression"].includes(current.type)) return expressionPath(current);
  if (current.type === "ThisExpression") return "this";
  return null;
}

function rootName(value) {
  return value?.split(".")[0] ?? null;
}

function bindingNames(pattern) {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) => bindingNames(property.value ?? property.argument));
  }
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap((element) => bindingNames(element));
  return [];
}

function declarationKind(node) {
  const kinds = {
    FunctionDeclaration: "function",
    ClassDeclaration: "class",
    VariableDeclaration: node?.kind ?? "variable",
    TSInterfaceDeclaration: "interface",
    TSTypeAliasDeclaration: "type",
    TSEnumDeclaration: "enum",
    TSModuleDeclaration: "namespace",
  };
  return kinds[node?.type] ?? "expression";
}

function declarationBindings(node) {
  if (!node) return [];
  if (node.type === "VariableDeclaration") return node.declarations.flatMap((item) => bindingNames(item.id));
  const name = staticName(node.id);
  return name ? [name] : [];
}

function exportedName(specifier) {
  return staticName(specifier?.exported) ?? staticName(specifier?.local) ?? null;
}

function importedName(specifier) {
  if (specifier?.type === "ExportNamespaceSpecifier") return "*";
  return staticName(specifier?.local) ?? null;
}

function isTypeDeclaration(node) {
  return TYPE_DECLARATIONS.has(node?.type);
}

function collectExports(program, content) {
  const records = [];
  const add = (node, values) => records.push({ ...values, span: span(node) });

  const visit = (node) => {
    if (!node) return;
    if (node.type === "ExportAllDeclaration") {
      add(node, {
        kind: node.exported ? "re-export-namespace" : "export-all",
        exportedName: staticName(node.exported) ?? "*",
        localName: null,
        importedName: "*",
        source: node.source?.value ?? null,
        declarationKind: null,
        isTypeOnly: node.exportKind === "type",
      });
      return;
    }
    if (node.type === "ExportNamedDeclaration") {
      if (node.declaration) {
        for (const name of declarationBindings(node.declaration)) {
          add(node, {
            kind: "local",
            exportedName: name,
            localName: name,
            importedName: null,
            source: null,
            declarationKind: declarationKind(node.declaration),
            isTypeOnly: node.exportKind === "type" || isTypeDeclaration(node.declaration),
          });
        }
      }
      for (const specifier of node.specifiers ?? []) {
        const source = node.source?.value ?? null;
        const localName = importedName(specifier);
        const name = exportedName(specifier);
        add(specifier, {
          kind: source
            ? (specifier.type === "ExportNamespaceSpecifier" ? "re-export-namespace" : "re-export")
            : (localName === name ? "local" : "alias"),
          exportedName: name,
          localName: source ? null : localName,
          importedName: source ? localName : null,
          source,
          declarationKind: null,
          isTypeOnly: node.exportKind === "type" || specifier.exportKind === "type",
        });
      }
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      add(node, {
        kind: "default",
        exportedName: "default",
        localName: staticName(declaration?.id) ?? (declaration?.type === "Identifier" ? declaration.name : null),
        importedName: null,
        source: null,
        declarationKind: declarationKind(declaration),
        isTypeOnly: false,
        expression: ["FunctionDeclaration", "ClassDeclaration"].includes(declaration?.type)
          ? null
          : sourceText(declaration, content),
      });
      return;
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);

  const addCommonJs = (node) => {
    if (node?.type !== "AssignmentExpression" || node.operator !== "=") return;
    const left = expressionPath(node.left);
    if (!left) return;
    if (left === "module.exports") {
      add(node, {
        kind: "commonjs-default",
        exportedName: "default",
        localName: expressionPath(node.right),
        importedName: null,
        source: null,
        declarationKind: "expression",
        isTypeOnly: false,
        expression: sourceText(node.right, content),
      });
      if (unwrapExpression(node.right)?.type === "ObjectExpression") {
        for (const property of unwrapExpression(node.right).properties) {
          if (!["ObjectProperty", "ObjectMethod"].includes(property.type)) continue;
          const name = staticName(property.key);
          if (!name) continue;
          add(property, {
            kind: "commonjs-named",
            exportedName: name,
            localName: expressionPath(property.value) ?? (property.shorthand ? name : null),
            importedName: null,
            source: null,
            declarationKind: "expression",
            isTypeOnly: false,
          });
        }
      }
    } else if (left.startsWith("exports.") || left.startsWith("module.exports.")) {
      add(node, {
        kind: "commonjs-named",
        exportedName: left.split(".").at(-1),
        localName: expressionPath(node.right),
        importedName: null,
        source: null,
        declarationKind: "expression",
        isTypeOnly: false,
      });
    }
  };
  const walkCommonJs = (node) => {
    if (!node) return;
    addCommonJs(node);
    for (const child of children(node)) walkCommonJs(child);
  };
  walkCommonJs(program);
  return records;
}

function callableOwner(node, state) {
  if (node.type === "FunctionDeclaration") return staticName(node.id) ?? state.ownerName;
  if (["ClassMethod", "ClassPrivateMethod", "TSDeclareMethod", "ObjectMethod"].includes(node.type)) {
    const name = staticName(node.key);
    return state.scopeName && name ? `${state.scopeName}.${name}` : name ?? state.ownerName;
  }
  if (node.type === "VariableDeclarator" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)) {
    return staticName(node.id) ?? state.ownerName;
  }
  if (node.type === "ObjectProperty" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.value?.type)) {
    const name = staticName(node.key);
    return state.scopeName && name ? `${state.scopeName}.${name}` : name ?? state.ownerName;
  }
  return state.ownerName;
}

function collectSemanticRelationships(program, content) {
  const heritage = [];
  const typeReferences = [];
  const memberHints = [];

  const addHeritage = (node, subjectName, relation, targetNode, typeArguments) => {
    const targetName = typeTargetName(targetNode);
    if (!subjectName || !targetName) return;
    heritage.push({
      relation,
      subjectName,
      targetName,
      targetRoot: rootName(targetName),
      typeArguments: (typeArguments?.params ?? []).map((item) => sourceText(item, content)),
      span: span(node),
    });
  };

  const visit = (node, parent = null, state = { ownerName: null, scopeName: null, typeContext: "annotation" }) => {
    if (!node) return;
    const next = { ...state, ownerName: callableOwner(node, state) };
    if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {
      const inferredName = staticName(node.id)
        ?? (parent?.type === "VariableDeclarator" ? staticName(parent.id) : null)
        ?? state.scopeName;
      next.scopeName = inferredName;
      if (node.superClass) addHeritage(node.superClass, inferredName, "extends", node.superClass, node.superTypeArguments);
      for (const item of node.implements ?? []) {
        addHeritage(item, inferredName, "implements", item.expression, item.typeArguments ?? item.typeParameters);
      }
    } else if (node.type === "TSInterfaceDeclaration") {
      next.scopeName = staticName(node.id);
      next.typeContext = "interface";
      for (const item of node.extends ?? []) {
        addHeritage(item, next.scopeName, "interface-extends", item.expression, item.typeArguments ?? item.typeParameters);
      }
    } else if (node.type === "TSTypeAliasDeclaration") {
      next.scopeName = staticName(node.id);
      next.typeContext = "type-alias";
    } else if (node.type === "VariableDeclarator" && unwrapExpression(node.init)?.type === "ObjectExpression") {
      next.scopeName = staticName(node.id) ?? state.scopeName;
    }

    if (node.type === "TSTypeReference") {
      const targetName = typeTargetName(node.typeName);
      if (targetName) {
        typeReferences.push({
          targetName,
          targetRoot: rootName(targetName),
          ownerName: next.scopeName ?? next.ownerName,
          context: next.typeContext,
          typeArguments: (node.typeParameters?.params ?? node.typeArguments?.params ?? []).map((item) => sourceText(item, content)),
          span: span(node),
        });
      }
    } else if (node.type === "TSImportType") {
      typeReferences.push({
        targetName: sourceText(node, content),
        targetRoot: null,
        ownerName: next.scopeName ?? next.ownerName,
        context: next.typeContext,
        typeArguments: (node.typeParameters?.params ?? node.typeArguments?.params ?? []).map((item) => sourceText(item, content)),
        span: span(node),
      });
    }

    if (["CallExpression", "OptionalCallExpression", "NewExpression"].includes(node.type)) {
      const callee = expressionPath(node.callee);
      if (callee) {
        const receiver = callee.includes(".") ? callee.slice(0, callee.lastIndexOf(".")) : null;
        memberHints.push({
          kind: node.type === "NewExpression" ? "construct" : "call",
          expression: callee,
          rootName: rootName(callee),
          receiver,
          memberName: callee.includes(".") ? callee.split(".").at(-1) : null,
          ownerName: next.ownerName,
          arguments: (node.arguments ?? []).map((item) => expressionPath(item)),
          optional: Boolean(node.optional),
          computed: Boolean(node.callee?.computed),
          span: span(node),
        });
      }
    } else if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
      const expression = expressionPath(node);
      if (expression) {
        memberHints.push({
          kind: "member",
          expression,
          rootName: rootName(expression),
          receiver: expressionPath(node.object),
          memberName: staticName(node.property),
          ownerName: next.ownerName,
          usage: parent?.type === "AssignmentExpression" && parent.left === node ? "write" : "read",
          optional: Boolean(node.optional),
          computed: Boolean(node.computed),
          span: span(node),
        });
      }
    }

    for (const child of children(node)) visit(child, node, next);
  };
  visit(program);
  return { heritage, typeReferences, memberHints };
}

function placeholderValue(node) {
  const current = unwrapExpression(node);
  if (!current) return null;
  if (current.type === "StringLiteral") return String(current.value);
  if (current.type === "TemplateLiteral") {
    let value = "";
    for (let index = 0; index < current.quasis.length; index += 1) {
      value += current.quasis[index].value.cooked ?? current.quasis[index].value.raw ?? "";
      if (index < current.expressions.length) value += "${}";
    }
    return value;
  }
  if (current.type === "BinaryExpression" && current.operator === "+") {
    const left = placeholderValue(current.left);
    const right = placeholderValue(current.right);
    if (left !== null && right !== null) return `${left}${right}`;
    if (left !== null) return `${left}${"${}"}`;
    if (right !== null) return `${"${}"}${right}`;
  }
  if (["ArrowFunctionExpression", "FunctionExpression"].includes(current.type)) {
    if (current.body.type !== "BlockStatement") return placeholderValue(current.body);
    const returned = current.body.body.find((item) => item.type === "ReturnStatement");
    return placeholderValue(returned?.argument);
  }
  return null;
}

function isEndpointValue(value) {
  return typeof value === "string" && (value.startsWith("/") || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(value));
}

function unwrapEndpointObject(node) {
  const current = unwrapExpression(node);
  if (current?.type === "ObjectExpression") return current;
  if (current?.type === "CallExpression" && ["Object.freeze", "Object.seal"].includes(expressionPath(current.callee))) {
    return unwrapExpression(current.arguments?.[0])?.type === "ObjectExpression"
      ? unwrapExpression(current.arguments[0])
      : null;
  }
  return null;
}

function objectProperty(object, name) {
  const current = unwrapEndpointObject(object) ?? unwrapExpression(object);
  if (current?.type !== "ObjectExpression") return null;
  const property = current.properties.find((item) => item.type === "ObjectProperty" && staticName(item.key) === name);
  return property?.value ?? null;
}

function normalizeMethod(value, fallback = "ANY") {
  const method = typeof value === "string" ? value.toUpperCase() : fallback;
  return HTTP_METHODS.has(method.toLowerCase()) ? method : fallback;
}

function isHttpClientReceiver(receiver) {
  const root = rootName(receiver);
  return HTTP_CLIENT_ROOTS.has(root)
    || /(?:api|http|rest|request)client$/i.test(root ?? "")
    || /client$/i.test(root ?? "");
}

function endpointReference(node) {
  const current = unwrapExpression(node);
  if (!current) return null;
  if (["Identifier", "MemberExpression", "OptionalMemberExpression"].includes(current.type)) return expressionPath(current);
  if (["CallExpression", "OptionalCallExpression"].includes(current.type)) return expressionPath(current.callee);
  return null;
}

function collectEndpointValues(program, content) {
  const definitions = [];
  const aliasCandidates = [];
  const definitionKeys = new Set();

  const addDefinition = (node, symbolPath, valueNode, kind, sourceExpression = null) => {
    if (!symbolPath || definitionKeys.has(symbolPath)) return false;
    const valueTemplate = placeholderValue(valueNode);
    if (!isEndpointValue(valueTemplate)) return false;
    const current = unwrapExpression(valueNode);
    definitions.push({
      kind,
      symbolPath,
      rootName: rootName(symbolPath),
      propertyPath: symbolPath.includes(".") ? symbolPath.split(".").slice(1) : [],
      valueTemplate,
      dynamic: valueTemplate.includes("${}"),
      sourceExpression,
      span: span(node),
      valueSpan: span(current),
    });
    definitionKeys.add(symbolPath);
    return true;
  };

  const collectObject = (object, prefix) => {
    for (const property of object?.properties ?? []) {
      if (!["ObjectProperty", "ObjectMethod"].includes(property.type)) continue;
      const name = staticName(property.key);
      if (!name) continue;
      const symbolPath = `${prefix}.${name}`;
      const value = property.type === "ObjectMethod" ? property : property.value;
      const nested = unwrapEndpointObject(value);
      if (nested) collectObject(nested, symbolPath);
      if (!addDefinition(property, symbolPath, value, property.type === "ObjectMethod" || ["ArrowFunctionExpression", "FunctionExpression"].includes(unwrapExpression(value)?.type)
        ? "builder"
        : "registry-member")) {
        const reference = endpointReference(value);
        if (reference) aliasCandidates.push({ node: property, symbolPath, sourceExpression: reference });
      }
    }
  };

  const collectDirect = (node, parent = null, state = { className: null }) => {
    if (!node) return;
    const next = { ...state };
    if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {
      next.className = staticName(node.id)
        ?? (parent?.type === "VariableDeclarator" ? staticName(parent.id) : null)
        ?? state.className;
    }
    if (node.type === "VariableDeclarator") {
      const name = staticName(node.id);
      if (name) {
        const object = unwrapEndpointObject(node.init);
        if (object) collectObject(object, name);
        if (!addDefinition(node, name, node.init, ["ArrowFunctionExpression", "FunctionExpression"].includes(unwrapExpression(node.init)?.type) ? "builder" : "constant")) {
          const reference = endpointReference(node.init);
          if (reference) aliasCandidates.push({ node, symbolPath: name, sourceExpression: reference });
        }
      } else if (node.id?.type === "ObjectPattern") {
        const source = endpointReference(node.init);
        if (source) {
          for (const property of node.id.properties) {
            const imported = staticName(property.key);
            const local = bindingNames(property.value ?? property.argument)[0];
            if (imported && local) aliasCandidates.push({ node: property, symbolPath: local, sourceExpression: `${source}.${imported}` });
          }
        }
      }
    } else if (["ClassProperty", "ClassPrivateProperty", "PropertyDefinition"].includes(node.type)) {
      const name = staticName(node.key);
      if (next.className && name) addDefinition(node, `${next.className}.${name}`, node.value, "class-member");
    } else if (node.type === "TSEnumMember") {
      const name = staticName(node.id);
      const enumName = parent?.type === "TSEnumDeclaration" ? staticName(parent.id) : null;
      if (name && enumName) addDefinition(node, `${enumName}.${name}`, node.initializer, "enum-member");
    } else if (node.type === "AssignmentExpression" && node.operator === "=") {
      const name = expressionPath(node.left);
      if (name && !addDefinition(node, name, node.right, "assignment")) {
        const reference = endpointReference(node.right);
        if (reference) aliasCandidates.push({ node, symbolPath: name, sourceExpression: reference });
      }
    }
    for (const child of children(node)) collectDirect(child, node, next);
  };
  collectDirect(program);

  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of aliasCandidates) {
      if (definitionKeys.has(candidate.symbolPath)) continue;
      const source = definitions.find((item) => item.symbolPath === candidate.sourceExpression);
      if (!source) continue;
      definitions.push({
        kind: "alias",
        symbolPath: candidate.symbolPath,
        rootName: rootName(candidate.symbolPath),
        propertyPath: candidate.symbolPath.includes(".") ? candidate.symbolPath.split(".").slice(1) : [],
        valueTemplate: source.valueTemplate,
        dynamic: source.dynamic,
        sourceExpression: candidate.sourceExpression,
        span: span(candidate.node),
        valueSpan: source.valueSpan,
      });
      definitionKeys.add(candidate.symbolPath);
      changed = true;
    }
  }

  const usages = [];
  const addUsage = (call, valueNode, method, framework, callee) => {
    const valueExpression = endpointReference(valueNode);
    if (!valueExpression) return;
    const definition = definitions.find((item) => item.symbolPath === valueExpression) ?? null;
    usages.push({
      kind: "http-client",
      method: normalizeMethod(method),
      framework,
      callee,
      valueExpression,
      resolvedDefinition: definition?.symbolPath ?? null,
      valueTemplate: definition?.valueTemplate ?? null,
      confidence: definition ? 0.99 : 0.8,
      span: span(call),
      valueSpan: span(valueNode),
    });
  };

  const collectUsages = (node) => {
    if (!node) return;
    if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      const callee = expressionPath(node.callee);
      const member = callee?.split(".").at(-1)?.toLowerCase() ?? null;
      const receiver = callee?.includes(".") ? callee.slice(0, callee.lastIndexOf(".")) : null;
      if (callee === "fetch") {
        const method = placeholderValue(objectProperty(node.arguments?.[1], "method")) ?? "GET";
        addUsage(node, node.arguments?.[0], method, "fetch", callee);
      } else if (member && HTTP_METHODS.has(member) && isHttpClientReceiver(receiver)) {
        addUsage(node, node.arguments?.[0], member, rootName(receiver), callee);
      } else if (callee === "axios") {
        const config = node.arguments?.[0];
        addUsage(
          node,
          objectProperty(config, "url"),
          placeholderValue(objectProperty(config, "method")) ?? "GET",
          "axios",
          callee,
        );
      } else if (member === "request" && isHttpClientReceiver(receiver)) {
        const config = node.arguments?.[0];
        if (unwrapEndpointObject(config)) {
          addUsage(
            node,
            objectProperty(config, "url") ?? objectProperty(config, "path"),
            placeholderValue(objectProperty(config, "method")) ?? "ANY",
            rootName(receiver),
            callee,
          );
        } else {
          addUsage(
            node,
            node.arguments?.[0],
            placeholderValue(objectProperty(node.arguments?.[1], "method")) ?? "ANY",
            rootName(receiver),
            callee,
          );
        }
      } else if (["request", "apiRequest", "httpRequest"].includes(callee)) {
        const possibleMethod = placeholderValue(node.arguments?.[0]);
        if (possibleMethod && HTTP_METHODS.has(possibleMethod.toLowerCase())) {
          addUsage(node, node.arguments?.[1], possibleMethod, "request-wrapper", callee);
        }
      }
    }
    for (const child of children(node)) collectUsages(child);
  };
  collectUsages(program);
  return { definitions, usages };
}

function selectorKeys(value) {
  const text = String(value ?? "");
  const results = [];
  const attributePattern = /\[\s*(data-[\w-]+)\s*=\s*(["'])(.*?)\2\s*\]/g;
  for (const match of text.matchAll(attributePattern)) {
    results.push({
      selectorKey: `${match[1]}=${match[3]}`,
      selector: `[${match[1]}="${match[3]}"]`,
      attribute: match[1],
      value: match[3],
    });
  }
  return results;
}

function collectDomSelectors(program, content) {
  const records = [];
  const add = (node, values) => records.push({ ...values, span: span(node) });
  const addTextSelectors = (node, value, values) => {
    for (const selector of selectorKeys(value)) add(node, { ...values, ...selector });
  };
  const consumerMethods = new Set([
    "$", "$$", "closest", "locator", "matches", "querySelector", "querySelectorAll", "waitForSelector",
  ]);

  const visit = (node, parent = null, state = { ownerName: null, scopeName: null }) => {
    if (!node) return;
    const next = { ...state, ownerName: callableOwner(node, state) };
    if (["ClassDeclaration", "ClassExpression"].includes(node.type)) {
      next.scopeName = staticName(node.id)
        ?? (parent?.type === "VariableDeclarator" ? staticName(parent.id) : null)
        ?? state.scopeName;
    }

    if (node.type === "VariableDeclarator") {
      const registryName = staticName(node.id);
      const initializer = unwrapExpression(node.init);
      const registryCall = initializer?.type === "CallExpression" && expressionPath(initializer.callee)?.endsWith("createTourTargetRegistry")
        ? unwrapExpression(initializer.arguments?.[0])
        : null;
      if (registryName && registryCall?.type === "ObjectExpression") {
        for (const property of registryCall.properties ?? []) {
          if (property.type !== "ObjectProperty") continue;
          const key = staticName(property.key);
          const value = placeholderValue(property.value);
          if (!key || value == null) continue;
          add(property, {
            kind: "registry-definition",
            registryReference: `${registryName}.${key}`,
            selectorKey: `data-tour=${value}`,
            selector: `[data-tour="${value}"]`,
            attribute: "data-tour",
            value,
            ownerName: registryName,
          });
        }
      }
    }

    if (node.type === "JSXAttribute" && node.name?.type === "JSXIdentifier") {
      const attribute = node.name.name;
      const valueNode = node.value?.type === "JSXExpressionContainer" ? node.value.expression : node.value;
      const value = placeholderValue(valueNode);
      if (attribute.startsWith("data-") && value != null) {
        add(node, {
          kind: "producer",
          selectorKey: `${attribute}=${value}`,
          selector: `[${attribute}="${value}"]`,
          attribute,
          value,
          ownerName: next.ownerName,
        });
      }
    } else if (node.type === "JSXSpreadAttribute") {
      const reference = expressionPath(node.argument);
      if (reference?.endsWith(".props")) {
        add(node, {
          kind: "registry-producer",
          registryReference: reference.slice(0, -".props".length),
          selectorKey: null,
          selector: null,
          ownerName: next.ownerName,
        });
      }
    }

    if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      const callee = expressionPath(node.callee);
      const method = callee?.split(".").at(-1);
      const value = placeholderValue(node.arguments?.[0]);
      if (consumerMethods.has(method) && value != null) {
        addTextSelectors(node.arguments[0], value, {
          kind: "consumer",
          consumerMethod: method,
          ownerName: next.ownerName,
        });
      }
    } else if (node.type === "ObjectProperty") {
      const key = staticName(node.key);
      const value = placeholderValue(node.value);
      if (["element", "selector", "target"].includes(key) && value != null) {
        addTextSelectors(node.value, value, {
          kind: "consumer",
          consumerMethod: `property:${key}`,
          ownerName: next.ownerName,
        });
      }
    } else if (["MemberExpression", "OptionalMemberExpression"].includes(node.type) && parent?.type !== "JSXSpreadAttribute") {
      const reference = expressionPath(node);
      if (reference?.endsWith(".selector")) {
        add(node, {
          kind: "registry-consumer",
          registryReference: reference.slice(0, -".selector".length),
          selectorKey: null,
          selector: null,
          ownerName: next.ownerName,
        });
      }
    }

    for (const child of children(node)) visit(child, node, next);
  };
  visit(program);
  const unique = new Map();
  for (const record of records) {
    const key = [record.kind, record.selectorKey, record.registryReference, record.span.start.index, record.ownerName].join(":" );
    if (!unique.has(key)) unique.set(key, record);
  }
  return [...unique.values()];
}

function deterministicSort(records) {
  return records.sort((left, right) => {
    const byStart = left.span.start.index - right.span.start.index;
    if (byStart) return byStart;
    const byEnd = left.span.end.index - right.span.end.index;
    if (byEnd) return byEnd;
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  });
}

export function extractJavaScriptRelationships(content, relativePath = "source.js") {
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
    return { ok: false, error: formatParseError(error) };
  }

  const semantic = collectSemanticRelationships(ast.program, content);
  const endpointValues = collectEndpointValues(ast.program, content);
  const domSelectors = collectDomSelectors(ast.program, content);
  const diagnostics = (ast.errors ?? []).slice(0, 50).map(formatParseError);
  return {
    ok: true,
    exports: deterministicSort(collectExports(ast.program, content)),
    heritage: deterministicSort(semantic.heritage),
    typeReferences: deterministicSort(semantic.typeReferences),
    memberHints: deterministicSort(semantic.memberHints),
    endpointValues: {
      definitions: deterministicSort(endpointValues.definitions),
      usages: deterministicSort(endpointValues.usages),
    },
    domSelectors: deterministicSort(domSelectors),
    parser: {
      mode: diagnostics.length ? "babel-recovered" : "babel",
      diagnostics,
    },
  };
}
