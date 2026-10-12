/**
 * Build-time check that workflow `data.latest(...)` reads name fields the
 * extension really writes. Run with `make contracts-check`, or
 * `deno run --allow-read --allow-env URL/contracts/check.ts [contracts.ts]`.
 *
 * @module
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";
import type { ZodType } from "npm:zod@4";

/** One extension model, reduced to what the check needs. */
export interface ContractModel {
  resources: Record<string, { schema: ZodType }>;
}

/** The contract for one model instance. */
export interface Contract {
  model: ContractModel;
  /** Data name to resource name; `"*"` matches any data name. */
  data: Record<string, string>;
}

/** Instance name to contract. */
export type Contracts = Record<string, Contract>;

/** One `data.latest("a","b").attributes.x.y` read. */
export interface Reference {
  instance: string;
  dataName: string;
  path: string[];
  /** The step (or nearest named ancestor) holding the expression. */
  location: string;
}

/** An expression the check could not parse. */
export interface ParseError {
  location: string;
  message: string;
}

const LATEST =
  /data\.latest\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)\.attributes((?:\.[A-Za-z_][\w]*)*)/g;

function walk(
  node: unknown,
  location: string,
  visit: (text: string, location: string) => void,
): void {
  if (typeof node === "string") return visit(node, location);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, location, visit);
  } else if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    // Only steps name a location; an `inputs.name` must not shadow it.
    const here = typeof obj.name === "string" && "task" in obj
      ? obj.name
      : location;
    for (const value of Object.values(obj)) walk(value, here, visit);
  }
}

/** Finds every data read in a workflow, plus the expressions it can't parse. */
export function findReferences(
  yamlText: string,
): { refs: Reference[]; errors: ParseError[] } {
  const refs: Reference[] = [];
  const errors: ParseError[] = [];
  walk(parseYaml(yamlText), "(workflow)", (text, location) => {
    const parsed = new Set<number>();
    for (const m of text.matchAll(LATEST)) {
      parsed.add(m.index!);
      refs.push({
        instance: m[1],
        dataName: m[2],
        path: m[3].split(".").filter(Boolean),
        location,
      });
    }
    for (const m of text.matchAll(/data\.latest\(/g)) {
      if (!parsed.has(m.index!)) {
        errors.push({
          location,
          message:
            `cannot parse data.latest(...) in "${text.trim()}"; use double-quoted literal arguments followed by .attributes.<field>`,
        });
      }
    }
    if (/\bmodel\.[\w-]+\.resource\b/.test(text)) {
      errors.push({
        location,
        message:
          `deprecated model.<name>.resource expression in "${text.trim()}"; use data.latest("<name>", "<dataName>").attributes.<field>`,
      });
    }
  });
  return { refs, errors };
}

// deno-lint-ignore no-explicit-any
function unwrap(schema: any): any {
  let s = schema;
  while (s?.def?.innerType) s = s.def.innerType;
  return s;
}

/** Returns an error message, or null when the reference is satisfied. */
export function checkReference(
  ref: Reference,
  contracts: Contracts,
): string | null {
  const contract = contracts[ref.instance];
  if (!contract) {
    return `instance "${ref.instance}" has no entry in contracts.ts`;
  }
  const resourceName = contract.data[ref.dataName] ?? contract.data["*"];
  if (!resourceName) {
    return `data name "${ref.dataName}" of "${ref.instance}" maps to no resource`;
  }
  const resource = contract.model.resources[resourceName];
  if (!resource) {
    return `resource "${resourceName}" is not in the "${ref.instance}" extension`;
  }
  let schema = unwrap(resource.schema);
  const walked: string[] = [];
  for (const field of ref.path) {
    const shape = schema?.shape;
    if (!shape || !(field in shape)) {
      const at = walked.length ? walked.join(".") : "(top level)";
      return `field "${field}" is not in resource "${resourceName}" at ${at}`;
    }
    walked.push(field);
    schema = unwrap(shape[field]);
  }
  return null;
}

/** Checks one workflow file's text; returns `file: step: message` lines. */
export function checkWorkflowText(
  file: string,
  text: string,
  contracts: Contracts,
): string[] {
  const { refs, errors } = findReferences(text);
  const failures = errors.map((e) => `${file}: ${e.location}: ${e.message}`);
  for (const ref of refs) {
    const msg = checkReference(ref, contracts);
    if (msg) failures.push(`${file}: ${ref.location}: ${msg}`);
  }
  return failures;
}

/** The `workflows/*.yaml` files under `root`, sorted; none if there is no folder. */
export async function workflowFiles(root = "."): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const e of Deno.readDir(`${root}/workflows`)) {
      if (e.isFile && e.name.endsWith(".yaml")) {
        files.push(`${root}/workflows/${e.name}`);
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return files.sort();
}

/**
 * Loads the `CONTRACTS` a repo exports from its own contracts file. A repo
 * with no such file reads no instance data, so it has no contracts.
 */
export async function loadContracts(path: string): Promise<Contracts> {
  try {
    await Deno.stat(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return {};
    throw err;
  }
  const url = new URL(path, `file://${Deno.cwd()}/`).href;
  const mod = await import(url);
  if (!mod.CONTRACTS || typeof mod.CONTRACTS !== "object") {
    throw new Error(`${path} must export CONTRACTS`);
  }
  return mod.CONTRACTS as Contracts;
}

async function main(): Promise<void> {
  const contracts = await loadContracts(Deno.args[0] ?? "contracts.ts");
  const files = await workflowFiles();
  const failures: string[] = [];
  for (const file of files) {
    failures.push(
      ...checkWorkflowText(file, await Deno.readTextFile(file), contracts),
    );
  }
  if (failures.length) {
    console.error(failures.join("\n"));
    Deno.exit(1);
  }
  console.log(`contracts-check: ${files.length} workflows OK`);
}

if (import.meta.main) await main();
