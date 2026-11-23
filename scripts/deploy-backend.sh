#!/bin/bash
# Deploy the Convex backend from this fork's main, safely.
#
# Two targets:
#
#   codecast production (self-hosted, the default): goes through
#   packages/convex/deploy.sh, the only path to that server. deploy.sh refuses
#   a tree behind its freshness remote, but in this fork that remote falls back
#   to `origin` (scripts/convex-base-remote.sh finds no codecast-sh/codecast
#   remote), so a fork behind codecast-sh/codecast's main would pass and its
#   push would delete codecast's newer functions. This wrapper adds
#   codecast-sh/codecast as the `codecast` remote and makes it the freshness
#   remote, so the fork must contain codecast's main before it can push there.
#
#   a Convex cloud deployment (--deploy-key-file): swarm's own backend. The key
#   names its deployment; the tree must contain this fork's origin/main. It does
#   not go through deploy.sh, which always targets the self-hosted server. The
#   target's function list is read before and after the push, and anything the
#   push removed is printed.
#
# Usage:
#   scripts/deploy-backend.sh [--deploy-key-file PATH] [--check] [--yes] [-- deploy args]
#     --check            run every check and print the target; deploy nothing
#     --yes              skip the confirmation prompt
#     --deploy-key-file  a file holding a Convex cloud deploy key (prod:<name>|...)
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

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

confirm() {
    [ "$ASSUME_YES" = 1 ] && return 0
    [ -t 0 ] || fail "no terminal to confirm on; pass --yes to deploy without the prompt."
    read -r -p "Deploy this tree to $1? Type 'deploy' to continue: " ANSWER
    [ "$ANSWER" = "deploy" ] || { echo "Not deployed."; exit 1; }
}

# Both targets: a clean main that contains this fork's origin/main.
[ "$(git branch --show-current)" = "main" ] || fail "check out main first (on '$(git branch --show-current)')."
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "main has uncommitted changes to tracked files; commit or stash them."
git fetch origin --quiet || fail "'git fetch origin' failed."
if ! git merge-base --is-ancestor origin/main HEAD; then
    git merge --ff-only origin/main --quiet || fail "main cannot fast-forward to origin/main; rebase it first."
    echo "main fast-forwarded to $(git rev-parse --short HEAD)."
fi

if [ -n "$KEY_FILE" ]; then
    [ -r "$KEY_FILE" ] || fail "cannot read the deploy key file."
    DEPLOY_KEY="$(tr -d '[:space:]' < "$KEY_FILE")"
    case "$DEPLOY_KEY" in prod:*'|'*) ;; *) fail "the deploy key is not a production key (expected prod:<deployment>|...)." ;; esac
    NAME="${DEPLOY_KEY#prod:}"; NAME="${NAME%%|*}"
    case "$NAME" in ""|*[!a-z0-9-]*) fail "cannot read a deployment name from the deploy key." ;; esac
    TARGET="https://$NAME.convex.cloud"
    echo "Checks passed. main $(git rev-parse --short HEAD) contains origin/main."
    echo "Target deployment: $TARGET (Convex cloud, from the deploy key)"
    [ "$CHECK_ONLY" = 1 ] && { echo "--check: nothing deployed."; exit 0; }
    confirm "$TARGET"

    # One deploy at a time per checkout, shared with deploy.sh.
    LOCK="$(git rev-parse --path-format=absolute --git-common-dir)/convex-deploy.lock"
    while ! mkdir "$LOCK" 2>/dev/null; do
        echo "waiting for the deploy already running from this checkout to finish..." >&2
        sleep 15
    done
    echo $$ > "$LOCK/pid"
    # An .env.local naming a CONVEX_DEPLOYMENT steers the CLI away from the key's deployment.
    HELD=()
    for f in "$ROOT/.env.local" "$ROOT/packages/convex/.env.local"; do
        if [ -f "$f" ] && grep -q '^CONVEX_DEPLOYMENT=' "$f"; then mv "$f" "$f.deployhold"; HELD+=("$f"); fi
    done
    SPEC_DIR="$(mktemp -d "${TMPDIR:-/tmp}/convex-spec.XXXXXX")"
    cleanup() {
        for f in ${HELD[@]+"${HELD[@]}"}; do [ -f "$f.deployhold" ] && mv "$f.deployhold" "$f"; done
        rm -rf "$LOCK" "$SPEC_DIR"
    }
    trap cleanup EXIT

    convex() {
        (cd "$ROOT/packages/convex" && env -u CONVEX_DEPLOYMENT -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
            CONVEX_DEPLOY_KEY="$DEPLOY_KEY" npx convex "$@")
    }
    functions() { bun -e 'const s = JSON.parse(await Bun.stdin.text()); for (const f of s.functions ?? []) if (f.identifier) console.log(f.identifier)' | sort -u; }

    if convex function-spec > "$SPEC_DIR/before.json" 2>/dev/null; then
        functions < "$SPEC_DIR/before.json" > "$SPEC_DIR/before.txt"
        echo "The target runs $(wc -l < "$SPEC_DIR/before.txt" | tr -d ' ') function(s) before the push."
    else
        echo "warning: could not read the target's functions before the push; removals will not be listed." >&2
        : > "$SPEC_DIR/before.txt"
    fi

    convex deploy -y ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

    if [ -s "$SPEC_DIR/before.txt" ] && convex function-spec > "$SPEC_DIR/after.json" 2>/dev/null; then
        functions < "$SPEC_DIR/after.json" > "$SPEC_DIR/after.txt"
        REMOVED="$(comm -23 "$SPEC_DIR/before.txt" "$SPEC_DIR/after.txt")"
        ADDED="$(comm -13 "$SPEC_DIR/before.txt" "$SPEC_DIR/after.txt" | wc -l | tr -d ' ')"
        echo "Deployed $(git rev-parse --short HEAD) to $TARGET: $(wc -l < "$SPEC_DIR/after.txt" | tr -d ' ') function(s), $ADDED added."
        if [ -n "$REMOVED" ]; then
            echo "Removed by this push:"
            echo "$REMOVED" | sed 's/^/  /'
        else
            echo "Removed by this push: none."
        fi
    else
        echo "Deployed $(git rev-parse --short HEAD) to $TARGET."
    fi
    exit 0
fi

# codecast production: the fork must also contain codecast-sh/codecast's main.
UPSTREAM_REMOTE="codecast"
UPSTREAM_URL="https://github.com/codecast-sh/codecast"
TARGET="${CONVEX_SELF_HOSTED_URL:-https://convex.codecast.sh}"
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
    echo "added remote '$UPSTREAM_REMOTE' -> $UPSTREAM_URL"
fi
git fetch "$UPSTREAM_REMOTE" main --quiet || fail "'git fetch $UPSTREAM_REMOTE main' failed."
if ! git merge-base --is-ancestor "$UPSTREAM_REMOTE/main" HEAD; then
    echo "REFUSING to deploy: main is BEHIND $UPSTREAM_REMOTE/main ($UPSTREAM_URL)." >&2
    echo "Pushing this tree to $TARGET would delete what these commits added to the backend:" >&2
    git log --oneline "HEAD..$UPSTREAM_REMOTE/main" >&2
    echo "Backend files they touch:" >&2
    git diff --name-only "HEAD...$UPSTREAM_REMOTE/main" -- packages/convex/convex packages/shared platform/packages >&2 || true
    echo "Bring $UPSTREAM_REMOTE/main into this fork's main (through a pull request), then retry." >&2
    exit 1
fi
echo "Checks passed. main $(git rev-parse --short HEAD) contains $UPSTREAM_REMOTE/main and is $(git rev-list --count "$UPSTREAM_REMOTE/main..HEAD") commit(s) ahead of it."
echo "Target deployment: $TARGET (self-hosted, through packages/convex/deploy.sh)"
[ "$CHECK_ONLY" = 1 ] && { echo "--check: nothing deployed."; exit 0; }
confirm "$TARGET"
export CONVEX_FRESHNESS_REMOTE="$UPSTREAM_REMOTE"
exec "$ROOT/packages/convex/deploy.sh" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
