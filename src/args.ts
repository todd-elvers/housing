import { z } from "zod";
import type { ArgsDef } from "citty";

/**
 * Derive citty args from a zod object schema via the official z.toJSONSchema()
 * API (no schema internals). citty handles tokenizing + help rendering; zod
 * stays the single validation/coercion authority. Keep input schemas FLAT
 * (scalars, enums, string arrays, optional/default) so they map cleanly to flags.
 */
export function zodToCittyArgs(input?: z.ZodObject<z.ZodRawShape>): ArgsDef {
  if (!input) return {};
  let json: {
    properties?: Record<string, JsonProp>;
    required?: string[];
  };
  try {
    json = z.toJSONSchema(input, { unrepresentable: "any" }) as typeof json;
  } catch {
    return {};
  }
  const required = new Set(json.required ?? []);
  const args: ArgsDef = {};
  for (const [name, prop] of Object.entries(json.properties ?? {})) {
    const isBool = prop.type === "boolean";
    const parts: string[] = [];
    if (prop.description) parts.push(prop.description);
    if (prop.enum) parts.push(`(choices: ${prop.enum.join("|")})`);
    if (prop.default !== undefined) parts.push(`(default: ${String(prop.default)})`);
    args[name] = {
      type: isBool ? "boolean" : "string",
      description: parts.join(" "),
      required: required.has(name) && prop.default === undefined,
      ...(prop.default !== undefined
        ? { default: isBool ? Boolean(prop.default) : String(prop.default) }
        : {}),
      ...(isBool ? {} : { valueHint: typeof prop.type === "string" ? prop.type : "value" }),
    } as ArgsDef[string];
  }
  return args;
}

interface JsonProp {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}
