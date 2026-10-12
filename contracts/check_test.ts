/**
 * Tests for the workflow contract check.
 *
 * Run with: deno test --allow-read contracts/check_test.ts
 *
 * @module
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  checkReference,
  checkWorkflowText,
  type Contracts,
  findReferences,
  loadContracts,
  workflowFiles,
} from "./check.ts";

const contracts: Contracts = {
  thing: {
    model: {
      resources: {
        out: {
          schema: z.object({
            name: z.string(),
            nested: z.object({ deep: z.string() }).optional(),
            withDefault: z.object({ x: z.number() }).default({ x: 1 }),
          }),
        },
      },
    },
    data: { result: "out" },
  },
  asker: {
    model: {
      resources: { answer: { schema: z.object({ json: z.unknown() }) } },
    },
    data: { "*": "answer" },
  },
};

function workflow(expr: string): string {
  return `name: w
jobs:
  - name: main
    steps:
      - name: use
        task:
          type: model_method
          inputs:
            value: \${{ ${expr} }}
`;
}

Deno.test("findReferences returns instance, data name, path and step", () => {
  const { refs, errors } = findReferences(
    workflow(`data.latest("thing", "result").attributes.nested.deep`),
  );
  assertEquals(errors, []);
  assertEquals(refs.length, 1);
  assertEquals(refs[0].instance, "thing");
  assertEquals(refs[0].dataName, "result");
  assertEquals(refs[0].path, ["nested", "deep"]);
  assertEquals(refs[0].location, "use");
});

Deno.test("a valid reference passes", () => {
  assertEquals(
    checkWorkflowText(
      "w.yaml",
      workflow(`data.latest("thing", "result").attributes.name`),
      contracts,
    ),
    [],
  );
});

Deno.test("a renamed field fails, naming file, step and field", () => {
  const [msg] = checkWorkflowText(
    "w.yaml",
    workflow(`data.latest("thing", "result").attributes.nam`),
    contracts,
  );
  assertStringIncludes(msg, "w.yaml");
  assertStringIncludes(msg, "use");
  assertStringIncludes(msg, "nam");
});

Deno.test("an unknown instance fails", () => {
  const [msg] = checkWorkflowText(
    "w.yaml",
    workflow(`data.latest("nope", "result").attributes.name`),
    contracts,
  );
  assertStringIncludes(msg, "nope");
});

Deno.test("an unmapped data name fails", () => {
  const [msg] = checkWorkflowText(
    "w.yaml",
    workflow(`data.latest("thing", "other").attributes.name`),
    contracts,
  );
  assertStringIncludes(msg, "other");
});

Deno.test("the * wildcard resolves any data name", () => {
  assertEquals(
    checkWorkflowText(
      "w.yaml",
      workflow(`data.latest("asker", "whatever").attributes.json`),
      contracts,
    ),
    [],
  );
});

Deno.test("nested paths are walked through optional and default", () => {
  const ok = (p: string) =>
    checkReference(
      {
        instance: "thing",
        dataName: "result",
        path: p.split("."),
        location: "s",
      },
      contracts,
    );
  assertEquals(ok("nested.deep"), null);
  assertEquals(ok("withDefault.x"), null);
  assert(ok("nested.nope") !== null);
});

Deno.test("unparseable data.latest and deprecated forms are errors", () => {
  for (
    const expr of [
      `data.latest('thing', 'result').attributes.name`,
      `data.latest(inputs.a, "result").attributes.name`,
      `model.thing.resource.out.main.attributes.name`,
    ]
  ) {
    const { errors } = findReferences(workflow(expr));
    assertEquals(errors.length, 1, expr);
  }
});

Deno.test("an inputs.name does not replace the step name in messages", () => {
  const text = `jobs:
  - name: main
    steps:
      - name: use
        task:
          type: model_method
          inputs:
            name: other
            value: \${{ data.latest("thing", "result").attributes.nam }}
`;
  const [msg] = checkWorkflowText("w.yaml", text, contracts);
  assertStringIncludes(msg, "w.yaml: use:");
});

async function scratch(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(
      `${dir}/${path.split("/").slice(0, -1).join("/") || "."}`,
      {
        recursive: true,
      },
    );
    await Deno.writeTextFile(`${dir}/${path}`, text);
  }
  return dir;
}

Deno.test("loadContracts returns no contracts when the file is absent", async () => {
  const dir = await scratch({});
  assertEquals(await loadContracts(`${dir}/contracts.ts`), {});
});

Deno.test("loadContracts reads CONTRACTS from the repo's own file", async () => {
  const dir = await scratch({
    "contracts.ts":
      "export const CONTRACTS = { thing: { model: { resources: {} }, data: {} } };",
  });
  assertEquals(Object.keys(await loadContracts(`${dir}/contracts.ts`)), [
    "thing",
  ]);
});

Deno.test("loadContracts rejects a file without CONTRACTS", async () => {
  const dir = await scratch({ "contracts.ts": "export const OTHER = {};" });
  let message = "";
  try {
    await loadContracts(`${dir}/contracts.ts`);
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "CONTRACTS");
});

Deno.test("workflowFiles lists workflows/*.yaml only, sorted", async () => {
  const dir = await scratch({
    "workflows/b.yaml": "",
    "workflows/a.yaml": "",
    "workflows/notes.md": "",
    "puddles/x/workflow-x.yaml": "",
  });
  assertEquals(await workflowFiles(dir), [
    `${dir}/workflows/a.yaml`,
    `${dir}/workflows/b.yaml`,
  ]);
});

Deno.test("workflowFiles is empty when the repo has no workflows/", async () => {
  assertEquals(await workflowFiles(await scratch({})), []);
});
