const DEFAULT_DIMENSIONS = 384;
const DEFAULT_BODY_LIMIT = 3_000;
const DEFAULT_MAX_DOCUMENTS = 50_000;
const DEFAULT_PROVIDER_BATCH_SIZE = 128;
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_EXTERNAL_RESULTS = 5_000;
const MAX_DIMENSIONS = 4_096;
const MAX_BODY_LIMIT = 30_000;
const MAX_DOCUMENTS = 100_000;
const MAX_PROVIDER_BATCH_SIZE = 1_024;
const MAX_PROVIDER_TIMEOUT_MS = 120_000;
const MAX_EXTERNAL_RESULTS = 20_000;
const MAX_QUERY_LENGTH = 4_096;
const MAX_TOKENIZED_TEXT = 100_000;
const CONCEPT_SCORE_WEIGHT = 0.15;
const VECTOR_SCORE_WEIGHT = 0.25;
const LEXICAL_SCORE_WEIGHT = 0.45;
const RRF_K = 60;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "by", "can", "could", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "if", "in", "into", "is", "it", "its", "of", "on", "or",
  "that", "the", "their", "then", "there", "these", "this", "those", "to", "was", "were", "what", "when",
  "where", "which", "while", "who", "why", "will", "with", "would",
]);

const CONCEPT_GROUPS = {
  authentication: [
    "access", "allowed", "auth", "authenticate", "authentication", "authorize", "authorization", "credential",
    "deny", "forbid", "identity", "jwt", "login", "logout", "oauth", "password", "permission", "permit", "policy",
    "protect", "protected", "role", "session", "signin", "signout", "token",
  ],
  persistence: [
    "cache", "database", "db", "document", "insert", "model", "persist", "persistence", "query", "record",
    "repository", "row", "save", "sql", "storage", "store", "table", "transaction", "update",
  ],
  http: [
    "api", "axios", "client", "controller", "endpoint", "fetch", "handler", "http", "middleware", "request",
    "response", "rest", "route", "router", "server", "status", "url",
  ],
  validation: [
    "assert", "check", "constraint", "guard", "invalid", "parse", "sanitize", "schema", "validate", "validation",
    "validator", "verify",
  ],
  failure: [
    "catch", "error", "exception", "fail", "failure", "fallback", "fault", "recover", "recovery", "retry", "throw",
    "timeout",
  ],
  transformation: [
    "adapt", "convert", "decode", "deserialize", "encode", "format", "map", "normalize", "parse", "render",
    "serialize", "transform",
  ],
  messaging: [
    "email", "event", "mail", "message", "notification", "notify", "publish", "queue", "send", "sms", "subscribe",
    "webhook",
  ],
  billing: [
    "bill", "billing", "charge", "checkout", "invoice", "order", "pay", "payment", "price", "purchase", "refund",
    "subscription",
  ],
  account: [
    "account", "actor", "customer", "member", "organization", "owner", "principal", "profile", "tenant", "user",
  ],
  creation: ["add", "build", "create", "generate", "initialize", "make", "new", "register"],
  deletion: ["clear", "delete", "destroy", "drop", "erase", "invalidate", "purge", "remove", "revoke"],
  reading: ["fetch", "find", "get", "load", "lookup", "query", "read", "retrieve", "search"],
  mutation: ["change", "edit", "modify", "patch", "replace", "set", "update", "write"],
  concurrency: ["async", "concurrent", "job", "lock", "parallel", "promise", "schedule", "task", "thread", "worker"],
  configuration: ["config", "configuration", "environment", "feature", "flag", "option", "preference", "setting"],
  observability: ["audit", "debug", "log", "metric", "monitor", "observe", "telemetry", "trace"],
  cryptography: ["cipher", "decrypt", "digest", "encrypt", "hash", "key", "secret", "sign", "signature"],
};

const TOKEN_CONCEPTS = new Map();
for (const [concept, words] of Object.entries(CONCEPT_GROUPS)) {
  for (const word of words) {
    const normalizedWord = stem(word);
    const concepts = TOKEN_CONCEPTS.get(normalizedWord) ?? [];
    concepts.push(concept);
    TOKEN_CONCEPTS.set(normalizedWord, concepts);
  }
}

function splitCodeText(value) {
  const source = String(value ?? "");
  if (source.length > MAX_TOKENIZED_TEXT) throw new Error(`text must be at most ${MAX_TOKENIZED_TEXT} UTF-16 code units`);
  return source
    .normalize("NFC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function stem(token) {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("es") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 4 && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

export function tokenizeCodeText(value) {
  const raw = splitCodeText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
  return raw
    .map((token) => stem(token))
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function addWeight(map, key, weight) {
  map.set(key, (map.get(key) ?? 0) + weight);
}

function characterNgrams(token) {
  const bounded = [...`^${token}$`];
  const values = [];
  for (let index = 0; index <= bounded.length - 3; index += 1) values.push(bounded.slice(index, index + 3).join(""));
  return values;
}

function semanticFeatures(value, fieldWeight = 1) {
  const tokens = tokenizeCodeText(value);
  const features = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    addWeight(features, `token:${token}`, fieldWeight);
    if (token.length >= 5 && token.length <= 32) {
      for (const gram of characterNgrams(token)) addWeight(features, `char3:${gram}`, fieldWeight * 0.08);
    }
    if (index > 0) addWeight(features, `pair:${tokens[index - 1]}:${token}`, fieldWeight * 0.3);
  }
  return features;
}

function compareCodePoints(leftValue, rightValue) {
  const left = [...String(leftValue)];
  const right = [...String(rightValue)];
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}

function boundedInteger(value, { name, fallback, minimum, maximum }) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatedText(value, maximum, name) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (value.length > maximum) throw new Error(`${name} must be at most ${maximum} UTF-16 code units`);
  return value;
}

function truncatedText(value, maximum, name) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  let result = value.slice(0, maximum);
  if (result && /[\uD800-\uDBFF]/.test(result.at(-1))) result = result.slice(0, -1);
  return result;
}

function normalizedIdentity(value, name) {
  if (value === undefined || value === null) return null;
  if (!["string", "number", "bigint"].includes(typeof value)) throw new Error(`${name} must be a string or number`);
  const result = String(value);
  if (!result || result.length > 4_096) throw new Error(`${name} must contain between 1 and 4096 characters`);
  return value;
}

function normalizedLine(value, name) {
  if (value === undefined || value === null || value === "") return 0;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100_000_000) throw new Error(`${name} must be an integer between 0 and 100000000`);
  return number;
}

function normalizeIdentifier(value) {
  return (splitCodeText(value).match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

function conceptsIn(value) {
  const concepts = new Set();
  for (const token of tokenizeCodeText(value)) {
    for (const concept of TOKEN_CONCEPTS.get(token) ?? []) concepts.add(concept);
  }
  return concepts;
}

function mergeFeatureMaps(target, source) {
  for (const [key, value] of source) addWeight(target, key, value);
}

function documentValue(document, camel, snake = camel) {
  return document[camel] ?? document[snake] ?? "";
}

function normalizeDocument(document, bodyLimit) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("each document must be an object");
  const normalized = {
    id: normalizedIdentity(document.id ?? document.symbol_id ?? null, "document id"),
    stableKey: normalizedIdentity(document.stableKey ?? document.stable_key ?? null, "document stable key"),
    name: validatedText(document.name ?? "", 512, "document name"),
    qualifiedName: validatedText(documentValue(document, "qualifiedName", "qualified_name"), 2_048, "document qualified name"),
    kind: validatedText(document.kind ?? "", 128, "document kind"),
    filePath: validatedText(documentValue(document, "filePath", "file_path"), 4_096, "document file path"),
    signature: validatedText(document.signature ?? "", 4_096, "document signature"),
    bodyText: truncatedText(documentValue(document, "bodyText", "body_text"), bodyLimit, "document body text"),
    startLine: normalizedLine(documentValue(document, "startLine", "start_line"), "document start line"),
    endLine: normalizedLine(documentValue(document, "endLine", "end_line"), "document end line"),
    language: validatedText(document.language ?? "", 128, "document language"),
    exported: Boolean(document.exported),
  };
  normalized.key = documentKey(normalized);
  return normalized;
}

function documentKeys(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("document must be an object");
  const keys = [];
  const stableKey = document.stableKey ?? document.stable_key;
  if (stableKey !== null && stableKey !== undefined) keys.push(`stable:${normalizedIdentity(stableKey, "document stable key")}`);
  const id = document.id ?? document.symbol_id;
  if (id !== null && id !== undefined) keys.push(`id:${normalizedIdentity(id, "document id")}`);
  const filePath = validatedText(document.filePath ?? document.file_path ?? "", 4_096, "document file path");
  const qualifiedName = validatedText(document.qualifiedName ?? document.qualified_name ?? document.name ?? "", 2_048, "document qualified name");
  const startLine = normalizedLine(document.startLine ?? document.start_line ?? 0, "document start line");
  if (filePath || qualifiedName) keys.push(`symbol:${filePath}:${qualifiedName}:${startLine}`);
  return [...new Set(keys.length ? keys : ["symbol:::0"] )];
}

export function documentKey(document) {
  return documentKeys(document)[0];
}

function preferDocument(left, right) {
  const leftRichness = left.bodyText.length + left.signature.length * 4 + left.qualifiedName.length * 2;
  const rightRichness = right.bodyText.length + right.signature.length * 4 + right.qualifiedName.length * 2;
  if (leftRichness !== rightRichness) return leftRichness > rightRichness ? left : right;
  return compareCodePoints(`${left.filePath}:${left.startLine}:${left.name}`, `${right.filePath}:${right.startLine}:${right.name}`) <= 0
    ? left
    : right;
}

function deduplicateDocuments(documents, bodyLimit) {
  const byKey = new Map();
  for (const document of documents ?? []) {
    const normalized = normalizeDocument(document, bodyLimit);
    if (!normalized.name && !normalized.qualifiedName) continue;
    const existing = byKey.get(normalized.key);
    byKey.set(normalized.key, existing ? preferDocument(existing, normalized) : normalized);
  }
  return [...byKey.values()].sort((left, right) => compareCodePoints(left.key, right.key));
}

function documentFeatureMap(document) {
  const features = new Map();
  mergeFeatureMaps(features, semanticFeatures(document.name, 5));
  mergeFeatureMaps(features, semanticFeatures(document.qualifiedName, 3.5));
  mergeFeatureMaps(features, semanticFeatures(document.filePath, 2));
  mergeFeatureMaps(features, semanticFeatures(document.kind, 1.5));
  mergeFeatureMaps(features, semanticFeatures(document.signature, 1.75));
  mergeFeatureMaps(features, semanticFeatures(document.bodyText, 1));
  return features;
}

function lexicalTermMap(document) {
  const terms = new Map();
  const add = (value, weight) => {
    for (const token of tokenizeCodeText(value)) addWeight(terms, token, weight);
  };
  add(document.name, 6);
  add(document.qualifiedName, 4);
  add(document.filePath, 2);
  add(document.signature, 2);
  add(document.bodyText, 1);
  return terms;
}

function hashFeature(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeVector(vector) {
  let magnitude = 0;
  for (let index = 0; index < vector.length; index += 1) magnitude += vector[index] * vector[index];
  magnitude = Math.sqrt(magnitude);
  if (!magnitude) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
  return vector;
}

function vectorFromFeatures(features, dimensions, inverseDocumentFrequency = null, documentCount = 1) {
  const vector = new Float32Array(dimensions);
  const defaultIdf = Math.log(1 + (documentCount + 0.5) / 0.5);
  for (const [feature, frequency] of features) {
    const hash = hashFeature(feature);
    const index = hash % dimensions;
    const sign = hash & 0x80000000 ? -1 : 1;
    const idf = inverseDocumentFrequency?.get(feature) ?? defaultIdf;
    vector[index] += sign * (1 + Math.log(Math.max(frequency, 0.0001))) * idf;
  }
  return normalizeVector(vector);
}

export function createLocalFeatureEmbedding(value, { dimensions = DEFAULT_DIMENSIONS } = {}) {
  dimensions = boundedInteger(dimensions, { name: "dimensions", fallback: DEFAULT_DIMENSIONS, minimum: 64, maximum: MAX_DIMENSIONS });
  return vectorFromFeatures(semanticFeatures(value), dimensions);
}

function dotProduct(left, right) {
  if (left.length !== right.length) throw new Error("embedding dimensions do not match");
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function renderEmbeddingText(document) {
  return [
    `name: ${document.name}`,
    `qualified name: ${document.qualifiedName}`,
    `kind: ${document.kind}`,
    `path: ${document.filePath}`,
    `signature: ${document.signature}`,
    document.bodyText,
  ].join("\n");
}

function validateProvider(provider, allowCustomProvider) {
  if (!provider) return;
  if (allowCustomProvider !== true) {
    throw new Error("caller-provided embeddingProvider receives source text; pass allowCustomProvider: true only after enforcing a local trust boundary");
  }
  if (provider.localOnly !== true) throw new Error("embeddingProvider must declare localOnly: true");
  if (provider.deterministic !== true) throw new Error("embeddingProvider must declare deterministic: true");
  if (typeof provider.embedDocuments !== "function" || typeof provider.embedQuery !== "function") {
    throw new Error("embeddingProvider must implement embedDocuments(texts) and embedQuery(query)");
  }
  if (typeof provider.id !== "string" || !provider.id.trim() || provider.id.length > 200) {
    throw new Error("embeddingProvider must have a non-empty string id of at most 200 characters");
  }
}

function validateProviderVectors(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error(`embeddingProvider returned ${vectors?.length ?? 0} vectors for ${expectedCount} documents`);
  }
  const dimensions = vectors[0]?.length ?? 0;
  if (!dimensions) throw new Error("embeddingProvider returned an empty vector");
  if (!Number.isInteger(dimensions) || dimensions > MAX_DIMENSIONS) {
    throw new Error(`embeddingProvider dimensions must be between 1 and ${MAX_DIMENSIONS}`);
  }
  return vectors.map((value) => {
    if ((!Array.isArray(value) && !(ArrayBuffer.isView(value) && !(value instanceof DataView))) || value.length !== dimensions) {
      throw new Error("embeddingProvider returned an invalid vector or inconsistent dimensions");
    }
    const vector = Float32Array.from(value);
    if (vector.some((item) => !Number.isFinite(item))) throw new Error("embeddingProvider returned a non-finite value");
    return normalizeVector(vector);
  });
}

async function withTimeout(callback, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function embedDocumentBatches(provider, texts, batchSize, timeoutMs) {
  const vectors = [];
  let dimensions = null;
  const deadline = Date.now() + timeoutMs;
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const remainingMs = Math.max(1, deadline - Date.now());
    const values = await withTimeout(
      () => provider.embedDocuments(batch),
      remainingMs,
      `embeddingProvider.embedDocuments batch ${Math.floor(offset / batchSize) + 1}`,
    );
    const validated = validateProviderVectors(values, batch.length);
    if (dimensions !== null && validated[0].length !== dimensions) throw new Error("embeddingProvider returned inconsistent dimensions across batches");
    dimensions = validated[0].length;
    vectors.push(...validated);
  }
  return vectors;
}

function exactIdentifierScore(document, query) {
  const normalizedQuery = normalizeIdentifier(query);
  if (!normalizedQuery) return 0;
  if (normalizedQuery === document.normalizedName || normalizedQuery === document.normalizedQualifiedName) return 1;
  if (document.normalizedName.startsWith(normalizedQuery) || document.normalizedQualifiedName.startsWith(normalizedQuery)) return 0.82;
  const queryTokens = tokenizeCodeText(query);
  if (queryTokens.length > 1 && queryTokens.every((token) => document.identifierTokens.has(token))) return 0.9;
  return 0;
}

function bm25Score(document, queryTokens, lexicalIdf, averageLength, documentCount) {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const token of new Set(queryTokens)) {
    const tf = document.lexicalTerms.get(token) ?? 0;
    if (!tf) continue;
    const idf = lexicalIdf.get(token) ?? Math.log(1 + (documentCount + 0.5) / 0.5);
    const denominator = tf + k1 * (1 - b + b * (document.lexicalLength / Math.max(averageLength, 1)));
    score += idf * ((tf * (k1 + 1)) / denominator);
  }
  return score;
}

function externalRankMap(results, maximum) {
  if (results !== undefined && results !== null && !Array.isArray(results)) throw new Error("lexicalResults must be an array");
  if ((results?.length ?? 0) > maximum) throw new Error(`lexicalResults must contain at most ${maximum} rows`);
  const ranks = new Map();
  for (const [index, result] of (results ?? []).entries()) {
    const score = 1 / (RRF_K + index + 1);
    for (const key of documentKeys(result)) ranks.set(key, Math.max(ranks.get(key) ?? 0, score));
  }
  const best = 1 / (RRF_K + 1);
  for (const [key, score] of ranks) ranks.set(key, score / best);
  return ranks;
}

function matchesFilter(document, options) {
  if (options.kind && document.kind.toLowerCase() !== options.kind.toLowerCase()) return false;
  if (options.filePath) {
    const requested = options.filePath.normalize("NFC").replaceAll("\\", "/").toLowerCase();
    if (!document.filePath.normalize("NFC").replaceAll("\\", "/").toLowerCase().includes(requested)) return false;
  }
  return true;
}

function validateOptionsObject(options, name) {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`${name} must be an object`);
}

function validateSearchFilters(options) {
  if (options.kind !== undefined && typeof options.kind !== "string") throw new Error("kind filter must be a string");
  if (options.filePath !== undefined && typeof options.filePath !== "string") throw new Error("filePath filter must be a string");
  if ((options.kind?.length ?? 0) > 128) throw new Error("kind filter must be at most 128 characters");
  if ((options.filePath?.length ?? 0) > 4_096) throw new Error("filePath filter must be at most 4096 characters");
}

export class HybridSearchIndex {
  constructor(state) {
    Object.assign(this, state);
  }

  static async create(documents, options = {}) {
    validateOptionsObject(options, "options");
    if (!Array.isArray(documents)) throw new Error("documents must be an array");
    validateProvider(options.embeddingProvider, options.allowCustomProvider);
    const dimensions = boundedInteger(options.dimensions, { name: "dimensions", fallback: DEFAULT_DIMENSIONS, minimum: 64, maximum: MAX_DIMENSIONS });
    const bodyLimit = boundedInteger(options.bodyLimit, { name: "bodyLimit", fallback: DEFAULT_BODY_LIMIT, minimum: 0, maximum: MAX_BODY_LIMIT });
    const maxDocuments = boundedInteger(options.maxDocuments, { name: "maxDocuments", fallback: DEFAULT_MAX_DOCUMENTS, minimum: 1, maximum: MAX_DOCUMENTS });
    const providerBatchSize = boundedInteger(options.providerBatchSize, { name: "providerBatchSize", fallback: DEFAULT_PROVIDER_BATCH_SIZE, minimum: 1, maximum: MAX_PROVIDER_BATCH_SIZE });
    const providerTimeoutMs = boundedInteger(options.providerTimeoutMs, { name: "providerTimeoutMs", fallback: DEFAULT_PROVIDER_TIMEOUT_MS, minimum: 1, maximum: MAX_PROVIDER_TIMEOUT_MS });
    if (documents.length > maxDocuments) throw new Error(`documents must contain at most ${maxDocuments} rows`);
    const normalized = deduplicateDocuments(documents, bodyLimit);
    if (!normalized.length) {
      return new HybridSearchIndex({
        documents: [],
        dimensions,
        provider: null,
        providerId: "local-feature-hash-v1",
        providerTrust: "built-in-no-io",
        conceptExpansion: "heuristic-concepts-v1",
        semanticIdf: new Map(),
        lexicalIdf: new Map(),
        averageLength: 0,
        maxExternalResults: boundedInteger(options.maxExternalResults, { name: "maxExternalResults", fallback: DEFAULT_MAX_EXTERNAL_RESULTS, minimum: 0, maximum: MAX_EXTERNAL_RESULTS }),
        providerTimeoutMs,
      });
    }

    const lexicalDocumentFrequency = new Map();
    let totalLexicalLength = 0;
    for (const document of normalized) {
      document.lexicalTerms = lexicalTermMap(document);
      document.lexicalLength = [...document.lexicalTerms.values()].reduce((sum, value) => sum + value, 0);
      document.concepts = conceptsIn(renderEmbeddingText(document));
      document.identifierTokens = new Set([...tokenizeCodeText(document.name), ...tokenizeCodeText(document.qualifiedName)]);
      document.normalizedName = normalizeIdentifier(document.name);
      document.normalizedQualifiedName = normalizeIdentifier(document.qualifiedName);
      if (!options.embeddingProvider) {
        document.vector = vectorFromFeatures(documentFeatureMap(document), dimensions);
      }
      totalLexicalLength += document.lexicalLength;
      for (const token of document.lexicalTerms.keys()) addWeight(lexicalDocumentFrequency, token, 1);
    }
    const idfFor = (frequency) => Math.log(1 + (normalized.length - frequency + 0.5) / (frequency + 0.5));
    const semanticIdf = new Map();
    const lexicalIdf = new Map([...lexicalDocumentFrequency].map(([key, value]) => [key, idfFor(value)]));

    let provider = null;
    let providerId = "local-feature-hash-v1";
    let providerTrust = "built-in-no-io";
    if (options.embeddingProvider) {
      provider = options.embeddingProvider;
      providerId = provider.id;
      providerTrust = "caller-attested-local";
      const vectors = await embedDocumentBatches(provider, normalized.map(renderEmbeddingText), providerBatchSize, providerTimeoutMs);
      for (let index = 0; index < normalized.length; index += 1) normalized[index].vector = vectors[index];
    }
    const actualDimensions = normalized[0].vector.length;
    return new HybridSearchIndex({
      documents: normalized,
      dimensions: actualDimensions,
      provider,
      providerId,
      providerTrust,
      conceptExpansion: "heuristic-concepts-v1",
      semanticIdf,
      lexicalIdf,
      averageLength: totalLexicalLength / normalized.length,
      maxExternalResults: boundedInteger(options.maxExternalResults, { name: "maxExternalResults", fallback: DEFAULT_MAX_EXTERNAL_RESULTS, minimum: 0, maximum: MAX_EXTERNAL_RESULTS }),
      providerTimeoutMs,
    });
  }

  async search(query, options = {}) {
    validateOptionsObject(options, "options");
    if (typeof query !== "string" || !query.trim()) throw new Error("query is required and must be a string");
    if (query.length > MAX_QUERY_LENGTH) throw new Error(`query must be at most ${MAX_QUERY_LENGTH} UTF-16 code units`);
    const limit = boundedInteger(options.limit, { name: "limit", fallback: 20, minimum: 1, maximum: 101 });
    const offset = boundedInteger(options.offset, { name: "offset", fallback: 0, minimum: 0, maximum: 10_000 });
    validateSearchFilters(options);
    const external = externalRankMap(options.lexicalResults, this.maxExternalResults);
    if (!this.documents.length) return [];
    let queryVector;
    if (this.provider) {
      const value = await withTimeout(
        () => this.provider.embedQuery(query),
        this.providerTimeoutMs,
        "embeddingProvider.embedQuery",
      );
      [queryVector] = validateProviderVectors([value], 1);
      if (queryVector.length !== this.dimensions) throw new Error("query embedding dimensions do not match document embeddings");
    } else {
      queryVector = vectorFromFeatures(semanticFeatures(query), this.dimensions, this.semanticIdf, this.documents.length);
    }
    const queryTokens = tokenizeCodeText(query);
    const queryConcepts = conceptsIn(query);
    const filtered = this.documents.filter((document) => matchesFilter(document, options));
    const externalScore = (document) => Math.max(...documentKeys(document).map((key) => external.get(key) ?? 0));
    let candidates = filtered;
    if (!this.provider) {
      const narrowed = filtered.filter((document) => externalScore(document) > 0
        || queryTokens.some((token) => document.lexicalTerms.has(token))
        || [...queryConcepts].some((concept) => document.concepts.has(concept)));
      if (narrowed.length >= Math.min(filtered.length, (limit + offset) * 3)) candidates = narrowed;
    }
    const scored = [];
    let maxLexical = 0;
    for (const document of candidates) {
      const lexical = bm25Score(document, queryTokens, this.lexicalIdf, this.averageLength, this.documents.length);
      const conceptMatches = [...queryConcepts].filter((concept) => document.concepts.has(concept)).length;
      const concept = queryConcepts.size ? conceptMatches / queryConcepts.size : 0;
      const vectorSemantic = Math.max(0, dotProduct(queryVector, document.vector));
      maxLexical = Math.max(maxLexical, lexical);
      scored.push({
        document,
        exact: exactIdentifierScore(document, query),
        lexical,
        vectorSemantic,
        semantic: vectorSemantic * 0.7 + concept * 0.3,
        concept,
        external: externalScore(document),
      });
    }
    for (const item of scored) {
      const lexical = maxLexical ? item.lexical / maxLexical : 0;
      item.score = item.exact * 2
        + lexical * LEXICAL_SCORE_WEIGHT
        + item.vectorSemantic * VECTOR_SCORE_WEIGHT
        + Math.min(item.concept * CONCEPT_SCORE_WEIGHT, CONCEPT_SCORE_WEIGHT)
        + item.external * 0.15;
      item.normalizedLexical = lexical;
    }
    scored.sort((left, right) => right.score - left.score
      || right.exact - left.exact
      || right.semantic - left.semantic
      || compareCodePoints(left.document.key, right.document.key));
    return scored.slice(offset, offset + limit).map((item) => {
      const {
        vector,
        lexicalTerms,
        lexicalLength,
        concepts,
        identifierTokens,
        normalizedName,
        normalizedQualifiedName,
        key,
        ...document
      } = item.document;
      return {
        ...document,
        score: item.score,
        scores: {
          exact: item.exact,
          lexical: item.normalizedLexical,
          semantic: item.semantic,
          concept: item.concept,
          external: item.external,
          contributions: {
            exact: item.exact * 2,
            lexical: item.normalizedLexical * LEXICAL_SCORE_WEIGHT,
            vector: item.vectorSemantic * VECTOR_SCORE_WEIGHT,
            concept: Math.min(item.concept * CONCEPT_SCORE_WEIGHT, CONCEPT_SCORE_WEIGHT),
            external: item.external * 0.15,
          },
        },
        embeddingProvider: this.providerId,
        embeddingProviderTrust: this.providerTrust,
        conceptExpansion: this.conceptExpansion,
      };
    });
  }
}

export async function createHybridSearchIndex(documents, options = {}) {
  return HybridSearchIndex.create(documents, options);
}
