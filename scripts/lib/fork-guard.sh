#!/bin/bash

# A clone can keep Codecast as an upstream remote. Only origin authorizes release.
require_codecast_origin() {
    local origin_fetch origin_push url
    origin_fetch="$(git remote get-url origin 2>/dev/null)" &&
        origin_push="$(git remote get-url --push --all origin 2>/dev/null)" || return 1

    for url in "$origin_fetch" "$origin_push"; do
        case "${url%.git}" in
            https://github.com/codecast-sh/codecast|git@github.com:codecast-sh/codecast|ssh://git@github.com/codecast-sh/codecast) ;;
            *) return 1 ;;
        esac
    done
}

if ! require_codecast_origin; then
    message="Swarm's release targets are not configured yet."
    echo "${1:-$message}" >&2
    exit 1
fi
