import { assertEquals } from "jsr:@std/assert@1";
import { checkWorkflow, parseDuration } from "./check.ts";

const wf = (tags: string) => `name: w\nversion: 1\n${tags}jobs: []\n`;

Deno.test("parseDuration accepts seconds and s/m/h suffixes", () => {
  assertEquals(parseDuration("90"), 90);
  assertEquals(parseDuration("30s"), 30);
  assertEquals(parseDuration("30m"), 1800);
  assertEquals(parseDuration("2h"), 7200);
});

Deno.test("parseDuration rejects junk, zero and negatives", () => {
  for (const bad of ["", "m", "0", "0m", "-5m", "1.5h", "5d", "abc"]) {
    assertEquals(parseDuration(bad), undefined, bad);
  }
});

Deno.test("a workflow with both tags in range has no problems", () => {
  const y = wf('tags:\n  maxReruns: "5"\n  maxWallClock: "30m"\n');
  assertEquals(checkWorkflow(y), []);
});

Deno.test("missing tags are reported", () => {
  assertEquals(checkWorkflow(wf("")).length, 2);
  assertEquals(checkWorkflow(wf('tags:\n  puddle: "true"\n')).length, 2);
});

Deno.test("maxReruns must be an integer from 3 to 10", () => {
  for (const bad of ["2", "11", "abc", "5.5", ""]) {
    const y = wf(`tags:\n  maxReruns: "${bad}"\n  maxWallClock: "30m"\n`);
    assertEquals(checkWorkflow(y).length, 1, bad);
  }
  for (const ok of ["3", "10"]) {
    const y = wf(`tags:\n  maxReruns: "${ok}"\n  maxWallClock: "30m"\n`);
    assertEquals(checkWorkflow(y), [], ok);
  }
});

Deno.test("maxWallClock must be a duration of at most 24h", () => {
  for (const bad of ["soon", "0", "25h", "86401"]) {
    const y = wf(`tags:\n  maxReruns: "5"\n  maxWallClock: "${bad}"\n`);
    assertEquals(checkWorkflow(y).length, 1, bad);
  }
  const y = wf('tags:\n  maxReruns: "5"\n  maxWallClock: "24h"\n');
  assertEquals(checkWorkflow(y), []);
});

Deno.test("unquoted YAML numbers are rejected: tags must be strings", () => {
  const y = wf("tags:\n  maxReruns: 5\n  maxWallClock: 30m\n");
  assertEquals(checkWorkflow(y).length, 1);
});
