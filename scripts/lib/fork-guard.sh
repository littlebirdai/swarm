#!/bin/bash
# Swarm is a fork that runs on its own infrastructure. Every inherited path
# that deploys or publishes to Codecast's infrastructure runs this first, and
# it always refuses: a clone whose origin still points at codecast-sh/codecast
# (with Swarm as a second remote) must not pass either. Swarm's own targets get
# their own scripts when they exist; the backend already has
# scripts/deploy-backend.sh.
message="Swarm's release targets are not configured yet."
echo "${1:-$message}" >&2
exit 1
