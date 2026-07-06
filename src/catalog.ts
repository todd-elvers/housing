import { z } from "zod";
import type { CommandDef } from "citty";
import { META, type ToolDef } from "./tool.ts";
import { SOURCE, type SourceContract } from "./source.ts";
import { isRequired, type EnvDecl } from "./env/spec.ts";

export interface CatalogArg {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  choices?: string[];
  description?: string;
}
export interface CatalogEnv {
  key: string;
  description: string;
  getAt: string;
  required: boolean;
}
export interface CatalogNode {
  path: string[];
  argv: string;
  kind: "query" | "mutation" | "group";
  summary?: string;
  when?: string;
  examples?: string[];
  args?: CatalogArg[];
  inputJsonSchema?: unknown;
  requires?: CatalogEnv[];
  source?: { snapshotComplete: boolean; tier: number };
  children?: CatalogNode[];
}

async function unwrap<T>(v: T | (() => T | Promise<T>)): Promise<T> {
  return typeof v === "function" ? await (v as () => T | Promise<T>)() : v;
}

/** Walk the citty tree, resolving every lazy node, and read the META/SOURCE symbols into a plain catalog. */
export async function buildCatalog(
  cmd: CommandDef,
  path: string[] = ["housing"],
): Promise<CatalogNode> {
  const def = (cmd as Record<symbol, unknown>)[META] as
    | ToolDef<z.ZodObject<z.ZodRawShape>, EnvDecl>
    | undefined;
  const source = (cmd as Record<symbol, unknown>)[SOURCE] as SourceContract | undefined;
  const sub = cmd.subCommands ? await unwrap(cmd.subCommands) : undefined;

  const node: CatalogNode = {
    path,
    argv: path.join(" "),
    kind: sub ? "group" : (def?.kind ?? "query"),
  };
  if (def) {
    node.summary = def.summary;
    node.when = def.when;
    if (def.examples) node.examples = def.examples;
    if (def.input) {
      node.args = describeArgs(def.input);
      node.inputJsonSchema = safeJsonSchema(def.input);
    }
    if (def.requires) node.requires = describeEnv(def.requires);
  }
  if (source) node.source = { snapshotComplete: source.snapshotComplete, tier: source.tier };
  if (sub) {
    node.children = [];
    for (const [name, child] of Object.entries(sub)) {
      const resolved = (await unwrap(child)) as CommandDef;
      node.children.push(await buildCatalog(resolved, [...path, name]));
    }
    node.children.sort((a, b) => a.argv.localeCompare(b.argv));
  }
  return node;
}

function describeArgs(input: z.ZodObject<z.ZodRawShape>): CatalogArg[] {
  const json = safeJsonSchema(input) as {
    properties?: Record<
      string,
      { type?: string; description?: string; enum?: string[]; default?: unknown }
    >;
    required?: string[];
  };
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, p]) => ({
    name,
    type: p.type ?? "string",
    required: required.has(name),
    default: p.default,
    choices: p.enum,
    description: p.description,
  }));
}

function describeEnv(decl: EnvDecl): CatalogEnv[] {
  return Object.entries(decl).map(([key, spec]) => ({
    key,
    description: spec.description,
    getAt: spec.getAt,
    required: isRequired(spec),
  }));
}

function safeJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: "any" });
  } catch {
    return {};
  }
}
