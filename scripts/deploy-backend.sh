#!/bin/bash
# Deploy the Convex backend from this fork's main, safely.
#
# packages/convex/deploy.sh is the only deploy path, and it refuses a tree that
# is behind the freshness remote. In this fork that remote falls back to
# `origin` (scripts/convex-base-remote.sh looks for a codecast-sh/codecast
# remote and finds none), so a fork that is behind codecast-sh/codecast's main
# would pass and its push would delete codecast's newer functions from the
# deployment. This wrapper closes that gap:
#
#   1. it requires a clean `main`, fast-forwarded to origin/main;
#   2. it adds codecast-sh/codecast as the `codecast` remote when missing and
#      makes it the freshness remote, so deploy.sh also refuses a tree behind
#      codecast's main;
#   3. it names the target deployment and asks before pushing.
#
# Usage:
#   scripts/deploy-backend.sh --check   run every check, deploy nothing
#   scripts/deploy-backend.sh           check, confirm, then run deploy.sh
#   scripts/deploy-backend.sh --yes     check, then deploy without the prompt
# Extra arguments after `--` go to deploy.sh.
set -euo pipefail
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

CHECK_ONLY=0
ASSUME_YES=0
PASSTHROUGH=()
while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK_ONLY=1 ;;
        --yes) ASSUME_YES=1 ;;
        --) shift; PASSTHROUGH=("$@"); break ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
    shift
done

UPSTREAM_REMOTE="codecast"
UPSTREAM_URL="https://github.com/codecast-sh/codecast"
TARGET="${CONVEX_SELF_HOSTED_URL:-https://convex.codecast.sh}"

fail() { echo "REFUSING to deploy: $*" >&2; exit 1; }

[ "$(git branch --show-current)" = "main" ] || fail "check out main first (on '$(git branch --show-current)')."
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "main has uncommitted changes to tracked files; commit or stash them."

git fetch origin --quiet || fail "'git fetch origin' failed."
if ! git merge-base --is-ancestor origin/main HEAD; then
    git merge --ff-only origin/main --quiet || fail "main cannot fast-forward to origin/main; rebase it first."
    echo "main fast-forwarded to $(git rev-parse --short HEAD)."
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
    git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
    echo "added remote '$UPSTREAM_REMOTE' -> $UPSTREAM_URL"
fi
git fetch "$UPSTREAM_REMOTE" main --quiet || fail "'git fetch $UPSTREAM_REMOTE main' failed."
if ! git merge-base --is-ancestor "$UPSTREAM_REMOTE/main" HEAD; then
    echo "REFUSING to deploy: main is BEHIND $UPSTREAM_REMOTE/main ($UPSTREAM_URL)." >&2
    echo "Pushing this tree would delete what these commits added to the backend:" >&2
    git log --oneline "HEAD..$UPSTREAM_REMOTE/main" >&2
    echo "Backend files they touch:" >&2
    git diff --name-only "HEAD...$UPSTREAM_REMOTE/main" -- packages/convex/convex packages/shared platform/packages >&2 || true
    echo "Bring $UPSTREAM_REMOTE/main into this fork's main (through a pull request), then retry." >&2
    exit 1
fi

AHEAD="$(git rev-list --count "$UPSTREAM_REMOTE/main..HEAD")"
echo "Checks passed. main $(git rev-parse --short HEAD) contains $UPSTREAM_REMOTE/main and is $AHEAD commit(s) ahead of it."
echo "Target deployment: $TARGET"
[ "$CHECK_ONLY" = 1 ] && { echo "--check: nothing deployed."; exit 0; }

if [ "$ASSUME_YES" != 1 ]; then
    [ -t 0 ] || fail "no terminal to confirm on; pass --yes to deploy without the prompt."
    read -r -p "Deploy this tree to $TARGET? Type 'deploy' to continue: " ANSWER
    [ "$ANSWER" = "deploy" ] || { echo "Not deployed."; exit 1; }
fi

export CONVEX_FRESHNESS_REMOTE="$UPSTREAM_REMOTE"
exec "$ROOT/packages/convex/deploy.sh" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}
