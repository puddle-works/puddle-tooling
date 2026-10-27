#!/bin/sh
# Tests `make publish` (from puddle.mk, running scripts/publish.sh) against a
# stubbed swamp:
# - it refuses a missing VISIBILITY and a VISIBILITY the manifest does not
#   declare, before running anything (a manifest with no visibility: line
#   declares public);
# - it stops when the tests fail or the dry run reports a review warning;
# - with DRY_RUN=1 it stops after a clean dry run, without pushing;
# - otherwise it pushes once, never with --yes, with the review reports read
#   from the repo root.
set -u
root=$(cd "$(dirname "$0")/.." && pwd)
make=${MAKE:-make}
tmp=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/stubs" "$tmp/repo"
cp "$root/puddle.mk" "$tmp/repo/"
printf 'include puddle.mk\ntest:\n\ttouch %s\n' "$tmp/tests-ran" > "$tmp/repo/Makefile"
cat > "$tmp/repo/manifest.yaml" <<'YAML'
manifestVersion: 1
name: "@mesgme/demo"
version: "2026.10.08.1"
visibility: public
models:
  - demo.ts
YAML
cat > "$tmp/stubs/swamp" <<STUB
#!/bin/sh
echo "\$* REVIEW_DIR=\${SWAMP_EXTENSION_REVIEW_DIR:-}" >> "$tmp/swamp-calls"
case "\$1 \$2" in
  "doctor extensions") echo '{"denoPath":"true"}' ;;
  "extension fmt") ;;
  "extension quality") echo '{"percentage":85,"gateFailures":[]}' ;;
  "extension push")
    case "\$*" in
      *--dry-run*)
        # swamp prints the dry-run JSON, the error on stderr, and exits 1 when
        # a registry check fails.
        if [ -f "$tmp/published" ] || [ -f "$tmp/not-member" ]; then
          if [ -f "$tmp/published" ]; then
            check='{"name":"version-exists","status":"failed","message":"Version 2026.10.08.1 already exists for @mesgme/demo."}'
          else
            check='{"name":"collective-membership","status":"failed","message":"You are not a member of @mesgme."}'
          fi
          echo "{\"status\":\"dry_run\",\"contentHash\":\"abc\",\"registryChecks\":[{\"name\":\"authentication\",\"status\":\"passed\"},\$check]}"
          echo '{"error":"a registry check failed"}' >&2
          exit 1
        elif [ -f "$tmp/warn" ]; then
          echo '{"status":"dry_run","contentHash":"abc","warnings":{"review":[{"ruleId":"adversarial-review-report","message":"No adversarial review recorded","file":"/repo/swamp-extension-review/_mesgme_demo-abc.json"}],"versionDrift":[{"output":"first publish"}]}}'
        else
          echo '{"status":"dry_run","contentHash":"abc","warnings":{"versionDrift":[{"output":"first publish"}]}}'
        fi ;;
      *)
        # The real push reports no contentHash; a mismatch is only caught when
        # it does report one.
        if [ -f "$tmp/drift" ]; then
          echo '{"status":"pushed","contentHash":"zzz"}'
        else
          echo '{"status":"pushed"}'
        fi ;;
    esac ;;
esac
STUB
chmod +x "$tmp/stubs/swamp"

# A second repo whose manifest has no visibility: line. Drafts leave it out for
# public (puddleworks#184, puddleworks-apps#93).
mkdir -p "$tmp/repo-default"
cp "$tmp/repo/puddle.mk" "$tmp/repo/Makefile" "$tmp/repo-default/"
grep -v '^visibility:' "$tmp/repo/manifest.yaml" > "$tmp/repo-default/manifest.yaml"

fail=0
# run <make args...>: runs make publish in $repo with the stub swamp on PATH.
# MAKEFLAGS and the environment are cleaned so a parent `make publish` (which
# runs these tests) does not pass its own VISIBILITY and DRY_RUN down.
repo=$tmp/repo
run() {
  rm -f "$tmp/swamp-calls" "$tmp/tests-ran"
  env -u MAKEFLAGS -u MFLAGS -u MAKELEVEL -u VISIBILITY -u DRY_RUN PATH="$tmp/stubs:$PATH" $make -s -C "$repo" publish \
    PUDDLE_TOOLING_DIR="$root" DENO=true PUBLISH_TESTS="touch $tmp/tests-ran" "$@" >"$tmp/out" 2>&1
}
pushed() { grep -E '^extension push ' "$tmp/swamp-calls" 2>/dev/null | grep -qv -- --dry-run; }

# refuses <label> <expected text> <make args...>
refuses() {
  label=$1 want=$2; shift 2
  if run "$@"; then
    echo "FAIL: publish succeeded with $label"; cat "$tmp/out"; fail=1
  elif ! grep -q -- "$want" "$tmp/out"; then
    echo "FAIL: publish with $label did not say '$want'"; cat "$tmp/out"; fail=1
  elif [ -f "$tmp/tests-ran" ] || pushed; then
    echo "FAIL: publish with $label ran the tests or pushed"; fail=1
  else
    echo "ok  publish refuses $label"
  fi
}

refuses "no VISIBILITY" "set VISIBILITY"
refuses "a VISIBILITY the manifest does not declare" "declares visibility 'public'" \
  VISIBILITY=private

if run VISIBILITY=public PUBLISH_TESTS=false; then
  echo "FAIL: publish succeeded although the tests failed"; fail=1
elif pushed; then
  echo "FAIL: publish pushed although the tests failed"; fail=1
else
  echo "ok  publish stops when the tests fail"
fi

touch "$tmp/warn"
if run VISIBILITY=public; then
  echo "FAIL: publish succeeded with an unresolved review warning"; fail=1
elif pushed; then
  echo "FAIL: publish pushed with an unresolved review warning"; fail=1
elif ! grep -q "/repo/swamp-extension-review/_mesgme_demo-abc.json" "$tmp/out"; then
  echo "FAIL: publish did not name the review report to write"; cat "$tmp/out"; fail=1
else
  echo "ok  publish stops on a review warning and names the report"
fi
rm "$tmp/warn"

if ! run VISIBILITY=public; then
  echo "FAIL: publish failed on a clean puddle"; cat "$tmp/out"; fail=1
elif [ ! -f "$tmp/tests-ran" ]; then
  echo "FAIL: publish did not run the tests"; fail=1
elif ! pushed; then
  echo "FAIL: publish did not push"; cat "$tmp/swamp-calls"; fail=1
elif grep '^extension push ' "$tmp/swamp-calls" | grep -qE -- ' (-y|--yes|-f|--force|--visibility)( |$)'; then
  echo "FAIL: publish pushed with a waiver or a visibility flag"; cat "$tmp/swamp-calls"; fail=1
elif grep '^extension push ' "$tmp/swamp-calls" | grep -qv "REVIEW_DIR=$tmp/repo$"; then
  echo "FAIL: publish did not read reviews from the repo root"; cat "$tmp/swamp-calls"; fail=1
else
  echo "ok  publish pushes a clean puddle once, without --yes"
fi
if ! grep -q "published @mesgme/demo@2026.10.08.1 (abc)" "$tmp/out"; then
  echo "FAIL: publish did not report what it published"; cat "$tmp/out"; fail=1
else
  echo "ok  publish reports the name, version and dry-run hash"
fi

if ! run VISIBILITY=public DRY_RUN=1; then
  echo "FAIL: a DRY_RUN=1 publish failed on a clean repo"; cat "$tmp/out"; fail=1
elif pushed; then
  echo "FAIL: a DRY_RUN=1 publish pushed"; fail=1
elif ! grep -q "dry run only" "$tmp/out"; then
  echo "FAIL: a DRY_RUN=1 publish did not say it stopped"; cat "$tmp/out"; fail=1
else
  echo "ok  DRY_RUN=1 stops after the dry run without pushing"
fi

# A version that is already in the registry: a dry run (CI on a PR that does
# not bump the version, or main after a publish) passes with a notice; a real
# push stops before pushing and says to bump.
touch "$tmp/published"
if ! run VISIBILITY=public DRY_RUN=1; then
  echo "FAIL: a dry run failed because the version is already published"; cat "$tmp/out"; fail=1
elif pushed; then
  echo "FAIL: a dry run of a published version pushed"; fail=1
elif ! grep -q "2026.10.08.1 is already published" "$tmp/out"; then
  echo "FAIL: a dry run did not say the version is already published"; cat "$tmp/out"; fail=1
else
  echo "ok  DRY_RUN=1 passes with a notice when the version is already published"
fi
if run VISIBILITY=public; then
  echo "FAIL: publish succeeded although the version is already published"; fail=1
elif pushed; then
  echo "FAIL: publish pushed a version that is already published"; fail=1
elif ! grep -q "bump version:" "$tmp/out"; then
  echo "FAIL: publish did not say to bump the version"; cat "$tmp/out"; fail=1
else
  echo "ok  publish of an already published version says to bump it"
fi
rm "$tmp/published"

# Any other failed registry check stops even a dry run.
touch "$tmp/not-member"
if run VISIBILITY=public DRY_RUN=1; then
  echo "FAIL: a dry run passed with a failed membership check"; fail=1
elif ! grep -q "not a member of @mesgme" "$tmp/out"; then
  echo "FAIL: a dry run did not name the failed registry check"; cat "$tmp/out"; fail=1
else
  echo "ok  DRY_RUN=1 stops on any other failed registry check"
fi
rm "$tmp/not-member"

touch "$tmp/drift"
if run VISIBILITY=public; then
  echo "FAIL: publish succeeded although the pushed hash differs"; fail=1
elif ! grep -q "differs from the dry run" "$tmp/out"; then
  echo "FAIL: publish did not report the hash difference"; cat "$tmp/out"; fail=1
else
  echo "ok  publish fails when the pushed hash differs"
fi
rm "$tmp/drift"

repo=$tmp/repo-default
refuses "private for a manifest with no visibility line" \
  "declares visibility 'public'" VISIBILITY=private
if ! run VISIBILITY=public; then
  echo "FAIL: publish refused public for a manifest with no visibility line"
  cat "$tmp/out"; fail=1
elif ! pushed; then
  echo "FAIL: publish did not push a manifest with no visibility line"; fail=1
elif grep '^extension push ' "$tmp/swamp-calls" | grep -q -- '--visibility'; then
  echo "FAIL: publish passed a visibility flag"; cat "$tmp/swamp-calls"; fail=1
else
  echo "ok  publish treats a missing visibility line as public"
fi
repo=$tmp/repo

# Without PUDDLE_TOOLING_DIR the script is fetched with curl and piped to sh.
# The settings (DENO and PUBLISH_TESTS come from puddle.mk's defaults, which make
# does not export) must reach sh, not curl. A stub curl serves the local script.
cat > "$tmp/stubs/curl" <<STUB
#!/bin/sh
cat "$root/scripts/publish.sh"
STUB
chmod +x "$tmp/stubs/curl"
rm -f "$tmp/swamp-calls" "$tmp/tests-ran"
if ! env -u MAKEFLAGS -u MFLAGS -u MAKELEVEL -u VISIBILITY -u DRY_RUN -u PUDDLE_TOOLING_DIR PATH="$tmp/stubs:$PATH" \
    $make -s -C "$tmp/repo" publish VISIBILITY=public DRY_RUN=1 >"$tmp/out" 2>&1; then
  echo "FAIL: a publish using the fetched script failed"; cat "$tmp/out"; fail=1
elif ! grep -q "dry run only" "$tmp/out"; then
  echo "FAIL: a publish using the fetched script did not stop at the dry run"; cat "$tmp/out"; fail=1
elif [ ! -f "$tmp/tests-ran" ]; then
  echo "FAIL: a publish using the fetched script did not run make test"; fail=1
else
  echo "ok  publish passes its settings to the fetched script"
fi
exit "$fail"
