#!/bin/bash
# Deploy swarm's Convex backend.
#
# Swarm runs on its own Convex cloud deployment, separate from the codecast
# project it was forked from. This is its deploy path. It does not use
# packages/convex/deploy.sh, which belongs to codecast's self-hosted server.
#
# Before pushing, the script checks that:
#   - this is a clean `main` that contains origin/main (fast-forwarded when
#     possible), because Convex pushes the whole tree and an older tree deletes
#     newer functions;
#   - the deploy key is a production key for the pinned deployment
#     (SWARM_CONVEX_DEPLOYMENT, default fine-deer-603), so a key for another
#     deployment is refused;
#   - no CONVEX_SELF_HOSTED_URL is set to steer the CLI elsewhere, and the
#     repo's own Convex CLI is installed.
#
# What it does while deploying:
#   - shares the deploy lock with packages/convex/deploy.sh;
#   - moves aside any .env.local that names a deployment;
#   - lists the target's functions before and after the push and prints
#     anything the push removed;
#   - restores the generated code under packages/convex/convex/_generated,
#     which the push rewrites.
#
# Usage:
#   scripts/deploy-backend.sh [--deploy-key-file PATH] [--check] [--yes] [-- convex deploy args]
#     --deploy-key-file  a file holding the production deploy key (prod:<deployment>|...);
#                        without it, CONVEX_DEPLOY_KEY from the environment is used
#     --check            run every check and print the target; deploy nothing
#     --yes              skip the confirmation prompt
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

EXPECTED="${SWARM_CONVEX_DEPLOYMENT:-fine-deer-603}"
CHECK_ONLY=0
ASSUME_YES=0
KEY_FILE=""
PASSTHROUGH=()
while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK_ONLY=1 ;;
        --yes) ASSUME_YES=1 ;;
        --deploy-key-file) shift; KEY_FILE="${1:-}" ;;
        --) shift; PASSTHROUGH=("$@"); break ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

fail() { echo "REFUSING to deploy: $*" >&2; exit 1; }

[ -z "${CONVEX_SELF_HOSTED_URL:-}" ] || fail "CONVEX_SELF_HOSTED_URL is set; unset it, it would send the push to a self-hosted server."
CONVEX_BIN="$ROOT/node_modules/.bin/convex"
[ -x "$CONVEX_BIN" ] || fail "the repo's Convex CLI is not installed; run 'bun install --frozen-lockfile' first."

if [ -n "$KEY_FILE" ]; then
    [ -r "$KEY_FILE" ] || fail "cannot read the deploy key file."
    DEPLOY_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
else
    DEPLOY_KEY="${CONVEX_DEPLOY_KEY:-}"
fi
[ -n "$DEPLOY_KEY" ] || fail "no deploy key: pass --deploy-key-file PATH or set CONVEX_DEPLOY_KEY."
case "$DEPLOY_KEY" in prod:*'|'*) ;; *) fail "the deploy key is not a production key (expected prod:<deployment>|...)." ;; esac
NAME="${DEPLOY_KEY#prod:}"; NAME="${NAME%%|*}"
[ "$NAME" = "$EXPECTED" ] || fail "the deploy key is for '$NAME', not swarm's deployment '$EXPECTED' (set SWARM_CONVEX_DEPLOYMENT to change the pin)."
TARGET="https://$NAME.convex.cloud"

[ "$(git branch --show-current)" = "main" ] || fail "check out main first (on '$(git branch --show-current)')."
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "main has uncommitted changes to tracked files; commit or stash them."
git fetch origin --quiet || fail "'git fetch origin' failed."
if ! git merge-base --is-ancestor origin/main HEAD; then
    git merge --ff-only origin/main --quiet || fail "main cannot fast-forward to origin/main; rebase it first."
    echo "main fast-forwarded to $(git rev-parse --short HEAD)."
fi

echo "Checks passed. main $(git rev-parse --short HEAD) contains origin/main."
echo "Target deployment: $TARGET"
[ "$CHECK_ONLY" = 1 ] && { echo "--check: nothing deployed."; exit 0; }
if [ "$ASSUME_YES" != 1 ]; then
    [ -t 0 ] || fail "no terminal to confirm on; pass --yes to deploy without the prompt."
    read -r -p "Deploy main $(git rev-parse --short HEAD) to $TARGET? Type 'deploy' to continue: " ANSWER
    [ "$ANSWER" = "deploy" ] || { echo "Not deployed."; exit 1; }
fi

LOCK="$(git rev-parse --path-format=absolute --git-common-dir)/convex-deploy.lock"
while ! mkdir "$LOCK" 2>/dev/null; do
    HOLDER="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$HOLDER" ] && ! kill -0 "$HOLDER" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
    echo "waiting for the deploy already running from this checkout (pid ${HOLDER:-unknown}) to finish..." >&2
    sleep 15
done
echo $$ > "$LOCK/pid"
HELD=()
for f in "$ROOT/.env.local" "$ROOT/packages/convex/.env.local"; do
    if [ -f "$f" ] && grep -q '^CONVEX_DEPLOYMENT=' "$f"; then mv "$f" "$f.deployhold"; HELD+=("$f"); fi
done
SPEC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/convex-spec.XXXXXX")"
GENERATED="packages/convex/convex/_generated"
cleanup() {
    for f in ${HELD[@]+"${HELD[@]}"}; do [ -f "$f.deployhold" ] && mv "$f.deployhold" "$f"; done
    git -C "$ROOT" checkout -- "$GENERATED" 2>/dev/null || true
    rm -rf "$LOCK" "$SPEC_DIR"
}
trap cleanup EXIT

convex() {
    (cd "$ROOT/packages/convex" && env -u CONVEX_DEPLOYMENT -u CONVEX_SELF_HOSTED_ADMIN_KEY \
        CONVEX_DEPLOY_KEY="$DEPLOY_KEY" "$CONVEX_BIN" "$@")
}
functions() { bun -e 'const s = JSON.parse(await Bun.stdin.text()); for (const f of s.functions ?? []) if (f.identifier) console.log(f.identifier)' | sort -u; }

BEFORE_OK=0
if convex function-spec > "$SPEC_DIR/before.json" 2>/dev/null; then
    functions < "$SPEC_DIR/before.json" > "$SPEC_DIR/before.txt"
    BEFORE_OK=1
    echo "The target runs $(wc -l < "$SPEC_DIR/before.txt" | tr -d ' ') function(s) before the push."
else
    echo "warning: could not read the target's functions before the push; removals will not be listed." >&2
fi

convex deploy -y ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

if [ "$BEFORE_OK" = 1 ] && convex function-spec > "$SPEC_DIR/after.json" 2>/dev/null; then
    functions < "$SPEC_DIR/after.json" > "$SPEC_DIR/after.txt"
    REMOVED="$(comm -23 "$SPEC_DIR/before.txt" "$SPEC_DIR/after.txt")"
    ADDED="$(comm -13 "$SPEC_DIR/before.txt" "$SPEC_DIR/after.txt" | wc -l | tr -d ' ')"
    echo "Deployed $(git rev-parse --short HEAD) to $TARGET: $(wc -l < "$SPEC_DIR/after.txt" | tr -d ' ') function(s), $ADDED added."
    if [ -n "$REMOVED" ]; then echo "Removed by this push:"; echo "$REMOVED" | sed 's/^/  /'; else echo "Removed by this push: none."; fi
else
    echo "Deployed $(git rev-parse --short HEAD) to $TARGET."
fi
