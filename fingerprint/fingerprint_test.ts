/**
 * Tests for the puddle fingerprint helper.
 *
 * @module
 */
import { assertEquals, assertMatch, assertThrows } from "jsr:@std/assert@1";
import { assertFresh, fingerprint } from "./fingerprint.ts";

Deno.test("fingerprint is stable for the same parts", async () => {
  assertEquals(await fingerprint("a", "b"), await fingerprint("a", "b"));
});

Deno.test("fingerprint has the sha256:<hex> format", async () => {
  assertMatch(await fingerprint("hello"), /^sha256:[0-9a-f]{64}$/);
});

Deno.test("fingerprint keeps parts apart", async () => {
  assertEquals(
    (await fingerprint("ab", "c")) === (await fingerprint("a", "bc")),
    false,
  );
});

Deno.test("fingerprint changes when the input changes", async () => {
  assertEquals(
    (await fingerprint("log")) === (await fingerprint("log\nmore")),
    false,
  );
});

Deno.test("assertFresh passes on a match", async () => {
  const f = await fingerprint("x");
  assertFresh(f, f, "The daily log");
});

Deno.test("assertFresh throws on a mismatch, naming what changed", () => {
  assertThrows(
    () => assertFresh("sha256:aa", "sha256:bb", "The daily log"),
    Error,
    "The daily log changed since prepare (expected sha256:aa, now sha256:bb); nothing was written. Run the workflow again.",
  );
});
