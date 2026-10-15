# puddle-tooling

Shared checks, a publish script and reusable GitHub workflows for puddle repos.
Each puddle lives in its own repo ([ADR-004][adr]); this repo keeps the generic
parts identical across all of them. Repos use it by tagged release, never by
copying the code.

## What is in it

| Path | What it does |
|---|---|
| `contracts/check.ts` | Fails when a workflow reads `data.latest(...)` fields its extension does not write. Reads the repo's own `contracts.ts`. |
| `guardrails/check.ts` | Fails when a workflow lacks the `maxReruns` (3 to 10) and `maxWallClock` (up to 24h) tags. |
| `scripts/publish.sh` | Tests, type-checks, quality-gates and dry-runs the extension, then pushes it. Never uses `--yes`. |
| `puddle.mk` | Make targets that run the above from the tagged release. |
| `.github/workflows/` | Reusable `contracts-check`, `guardrails-check` and `publish` workflows. |

## Use it from a puddle repo

Copy `puddle.mk` into the repo and include it:

```make
include puddle.mk

test:
	$(DENO) test --allow-read extensions/models/
```

```sh
make contracts-check
make guardrails-check
make publish VISIBILITY=private DRY_RUN=1   # stop after the dry run
make publish VISIBILITY=private             # push
```

`VISIBILITY` must equal `visibility:` in the repo's `manifest.yaml`; a manifest
with no `visibility:` line is public. It is not
passed to swamp, because a `--visibility` flag changes the content hash and the
committed review report would no longer match.

The same checks run in CI by calling the reusable workflows:

```yaml
jobs:
  contracts:
    uses: puddle-works/puddle-tooling/.github/workflows/contracts-check.yml@v0.1.1
  guardrails:
    uses: puddle-works/puddle-tooling/.github/workflows/guardrails-check.yml@v0.1.1
  publish:
    uses: puddle-works/puddle-tooling/.github/workflows/publish.yml@v0.1.1
    with:
      visibility: private
      dry-run: true       # false pushes
    secrets:
      SWAMP_API_KEY: ${{ secrets.SWAMP_API_KEY }}
      SWAMP_SIGNIN_TOKEN: ${{ secrets.SWAMP_SIGNIN_TOKEN }}
```

The publish workflow needs the `SWAMP_API_KEY` and `SWAMP_SIGNIN_TOKEN` secrets
even for a dry run, because every swamp command needs an account. Create them
for the collective with
`swamp auth token create --collective <collective> --scopes extensions:push`.
It prints both values once; store each as a repository secret.

Pin the workflow `@vX.Y.Z` and, when you move to a newer release, change
`TOOLING_REF` in `puddle.mk` (or the `tooling-ref` input) with it. The two
defaults are the release they ship in.

## Contracts

A repo whose workflows read another model's data through `data.latest` adds a
`contracts.ts` that exports `CONTRACTS`, importing the types from this repo:

```ts
import type { Contracts } from "https://raw.githubusercontent.com/puddle-works/puddle-tooling/v0.1.1/contracts/check.ts";
import { model as thing } from "./extensions/models/thing.ts";

export const CONTRACTS: Contracts = {
  "thing-instance": { model: thing, data: { result: "result" } },
};
```

A repo with no `contracts.ts` has no contracts, so a workflow that reads
instance data fails the check until one is added.

## Develop

```sh
deno fmt --check contracts guardrails
deno test --allow-read --allow-write contracts guardrails
sh scripts/test_publish.sh
```

[adr]: https://github.com/puddle-works/puddleworks-apps/blob/main/docs/adr/ADR-004-one-repo-per-puddle.md
