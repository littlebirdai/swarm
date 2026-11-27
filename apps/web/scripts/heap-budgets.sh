#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun perf/heap-budgets.ts "$@"
