/**
 * Build-time check that every workflow declares run limits in its tags:
 * `maxReruns` (3-10) and `maxWallClock` (a `--timeout` duration, up to 24h).
 * Swamp rejects unknown top-level workflow keys, so the limits live in `tags`.
 * A runner enforces them: `--timeout <maxWallClock>` on run and resume, and no
 * `resume --run` once the run has been retried `maxReruns` times.
 * Run with `make guardrails-check`.
 *
 * @module
 */
import { parse as parseYaml } from "jsr:@std/yaml@1";

const MAX_SECONDS = 24 * 60 * 60;

/** Seconds in a `--timeout` value (`90`, `30s`, `5m`, `1h`), else undefined. */
export function parseDuration(text: string): number | undefined {
  const m = /^([1-9]\d*)([smh]?)$/.exec(text);
  if (!m) return undefined;
  const unit = { "": 1, s: 1, m: 60, h: 3600 }[m[2] as "" | "s" | "m" | "h"];
  return Number(m[1]) * unit;
}

/** The problems in one workflow's guardrail tags; empty when it is fine. */
export function checkWorkflow(yamlText: string): string[] {
  const doc = parseYaml(yamlText) as { tags?: Record<string, unknown> } | null;
  const tags = doc?.tags ?? {};
  const problems: string[] = [];

  const reruns = tags.maxReruns;
  if (reruns === undefined) {
    problems.push('tag "maxReruns" is missing (use "5")');
  } else if (typeof reruns !== "string" || !/^\d+$/.test(reruns)) {
    problems.push('tag "maxReruns" must be a quoted whole number, e.g. "5"');
  } else if (Number(reruns) < 3 || Number(reruns) > 10) {
    problems.push(`tag "maxReruns" is ${reruns}; it must be 3 to 10`);
  }

  const clock = tags.maxWallClock;
  if (clock === undefined) {
    problems.push('tag "maxWallClock" is missing (use "30m")');
  } else {
    const seconds = typeof clock === "string"
      ? parseDuration(clock)
      : undefined;
    if (seconds === undefined) {
      problems.push(
        'tag "maxWallClock" must be a duration like "90", "30s", "30m" or "2h"',
      );
    } else if (seconds > MAX_SECONDS) {
      problems.push(`tag "maxWallClock" is ${clock}; it must be at most 24h`);
    }
  }
  return problems;
}

/**
 * Checks every `workflows/*.yaml` under `root`. Each problem starts with the
 * workflow's path. A repo with no workflows folder has no workflows, so it has
 * no problems.
 */
export async function checkRepo(root = "."): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(`${root}/workflows`)) {
      if (entry.isFile && entry.name.endsWith(".yaml")) names.push(entry.name);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const problems: string[] = [];
  for (const name of names.sort()) {
    const path = `workflows/${name}`;
    const text = await Deno.readTextFile(`${root}/${path}`);
    for (const problem of checkWorkflow(text)) {
      problems.push(`${path}: ${problem}`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const problems = await checkRepo();
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) Deno.exit(1);
  console.log("guardrails-check: ok");
}

if (import.meta.main) await main();
