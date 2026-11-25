#!/bin/bash
set -euo pipefail

fail() { echo "REFUSING to deploy: $*" >&2; exit 1; }

[ "${CI:-}" = true ] &&
    [ "${GITHUB_ACTIONS:-}" = true ] &&
    [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] ||
    fail "Swarm production deploys run only on GitHub-hosted CI."
[ "${GITHUB_REPOSITORY:-}" = littlebirdai/swarm ] &&
    [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] &&
    [ "${GITHUB_REF:-}" = refs/heads/main ] &&
    [ "${GITHUB_WORKFLOW_REF:-}" = littlebirdai/swarm/.github/workflows/deploy-swarm-backend.yml@refs/heads/main ] ||
    fail "use the manual Swarm backend workflow from littlebirdai/swarm main."
[ "$#" -eq 0 ] || fail "this workflow does not accept deploy arguments."

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
DEPLOYMENT="$(cat scripts/swarm-production-deployment.txt)"
[ -n "$DEPLOYMENT" ] || fail "the production deployment name is missing."
case "${CONVEX_DEPLOY_KEY:-}" in
    "prod:$DEPLOYMENT|"[![:space:]]*) ;;
    "") fail "the protected environment has no production deploy key." ;;
    *) fail "the deploy key is not a production key for $DEPLOYMENT." ;;
esac
[ -z "${CONVEX_SELF_HOSTED_URL:-}${CONVEX_SELF_HOSTED_ADMIN_KEY:-}${CONVEX_PROVISION_HOST:-}${CONVEX_OVERRIDE_ACCESS_TOKEN:-}" ] ||
    fail "Convex server overrides are set."
CONVEX_BIN="$ROOT/node_modules/.bin/convex"
[ -x "$CONVEX_BIN" ] || fail "the repo's Convex CLI is not installed."

HEAD_SHA="$(git rev-parse HEAD)"
[ "$HEAD_SHA" = "${GITHUB_SHA:-}" ] || fail "the checkout does not match the workflow commit."

require_current_main() {
    local status main
    status="$(git status --porcelain)" || fail "could not verify the checkout is clean."
    [ -z "$status" ] || fail "the checkout has uncommitted changes."
    [ "$(git rev-parse HEAD)" = "$HEAD_SHA" ] || fail "the checkout changed during the deploy checks."
    main="$(git ls-remote --exit-code https://github.com/littlebirdai/swarm.git refs/heads/main)" ||
        fail "could not verify the tip of Swarm main."
    [ "$HEAD_SHA" = "${main%%[[:space:]]*}" ] || fail "the workflow commit is no longer the tip of Swarm main."
}

require_current_main
git show "$HEAD_SHA:scripts/swarm-production-drops.json" |
    bun --no-env-file apps/server/scripts/prod-diff.ts --swarm-gate "$DEPLOYMENT" ||
    fail "the production inventory check failed."
require_current_main

cd "$ROOT/apps/server"
export CONVEX_DEPLOYMENT="" CONVEX_SELF_HOSTED_URL="" CONVEX_SELF_HOSTED_ADMIN_KEY=""
export CONVEX_PROVISION_HOST="" CONVEX_OVERRIDE_ACCESS_TOKEN=""
"$CONVEX_BIN" deploy -y
