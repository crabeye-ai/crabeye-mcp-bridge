type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T extends JsonObject>(
  ...sources: Array<T | undefined>
): T {
  const result: JsonObject = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = deepMerge(result[key] as JsonObject, value);
      } else {
        result[key] = value;
      }
    }
  }
  return result as T;
}
