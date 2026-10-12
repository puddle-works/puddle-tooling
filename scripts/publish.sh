#!/bin/sh
# Publishes the repo's extension to the swamp registry. Run it through
# `make publish VISIBILITY=public|private` (see puddle.mk), from the repo root.
# DRY_RUN=1 stops after a clean dry run, before anything is pushed.
#
# VISIBILITY must match the manifest's `visibility:`. It is not passed to
# swamp: a --visibility flag changes the content hash, so the review report
# written for the dry run would not match the real push (apps#49).
#
# The push is gated on a clean dry run instead of a prompt, so it never needs
# --yes. Review reports live in swamp-extension-review/ at the repo root and are
# committed with the version they review.
set -eu

die() { echo "publish: $*" >&2; exit 1; }
manifest=manifest.yaml
[ -f "$manifest" ] || die "no $manifest here; run this from the puddle repo's root"
case "${VISIBILITY:-}" in
  public | private) ;;
  *) die "set VISIBILITY=public or VISIBILITY=private" ;;
esac
declared=$(sed -n 's/^visibility: *"*\([a-z]*\)"*.*/\1/p' "$manifest")
[ "$declared" = "$VISIBILITY" ] || die "$manifest declares visibility \
'${declared:-none}', not '$VISIBILITY'. Set 'visibility: $VISIBILITY' in the \
manifest and commit it; it is never passed as a flag."

echo "==> tests"
sh -c "${PUBLISH_TESTS:-make test}" || die "tests failed; nothing was pushed"

models=$(awk '/^models:/ { f = 1; next } /^[^ ]/ { f = 0 }
  f && /^ *- / { print "extensions/models/" $2 }' "$manifest")
if [ -n "$models" ]; then
  echo "==> deno check"
  # shellcheck disable=SC2086 # one path per word
  "$DENO" check $models
fi

echo "==> swamp extension fmt --check"
swamp extension fmt "$manifest" --check

out=$(mktemp)
trap 'rm -f "$out"' EXIT

echo "==> swamp extension quality"
swamp extension quality "$manifest" --json >"$out"
jq -r '"quality: \(.percentage)%"' "$out"
if [ "$(jq '.gateFailures | length' "$out")" != 0 ]; then
  jq -r '.gateFailures[] | "  - \(.)"' "$out" >&2
  die "quality gate failed; nothing was pushed"
fi

# Review reports are bound to the content hash. Keeping them in the repo (swamp
# adds swamp-extension-review/) lets them be committed and reviewed with the
# code instead of living in a temp directory.
SWAMP_EXTENSION_REVIEW_DIR=$(pwd)
export SWAMP_EXTENSION_REVIEW_DIR

echo "==> swamp extension push --dry-run"
swamp extension push "$manifest" --dry-run --json >"$out"
# Version drift is informational; every other warning family blocks.
if [ "$(jq '[.warnings // {} | to_entries[] | select(.key != "versionDrift") | .value[]] | length' "$out")" != 0 ]; then
  jq -r '.warnings | to_entries[] | select(.key != "versionDrift") | .value[]
    | "  - [\(.ruleId // .check // "warning")] \(.message // .output)\(if .file then "\n    report: \(.file)" else "" end)"' "$out" >&2
  die "the dry run has unresolved warnings. Fix them (for a missing review, \
write the skeleton from 'swamp extension push $manifest --dry-run --json' to the \
report path with every verdict filled in) and run again. Never push with --yes."
fi
hash=$(jq -r .contentHash "$out")
echo "content hash: $hash"
if [ -n "${DRY_RUN:-}" ]; then
  echo "dry run only; nothing was pushed"
  exit 0
fi

echo "==> swamp extension push"
# --json never prompts; the dry run above is the gate.
swamp extension push "$manifest" --json >"$out"
[ "$(jq -r .status "$out")" = pushed ] || { cat "$out" >&2; die "push did not succeed"; }
# The push output carries no contentHash today, so only compare one if it is
# there. The dry run's hash is what the review report was bound to.
pushed_hash=$(jq -r '.contentHash // empty' "$out")
[ -z "$pushed_hash" ] || [ "$pushed_hash" = "$hash" ] ||
  die "pushed content hash $pushed_hash differs from the dry run's $hash"
echo "published $(sed -n 's/^name: *"*\([^"]*\)"*.*/\1/p' "$manifest")@$(sed -n 's/^version: *"*\([^"]*\)"*.*/\1/p' "$manifest") ($hash)"
