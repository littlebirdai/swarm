set -euo pipefail

for attempt in 1 2 3; do
  echo "::group::Test attempt $attempt"
  if "$@"; then
    echo "::endgroup::"
    exit 0
  fi
  echo "::endgroup::"
  echo "::warning::Test attempt $attempt failed"
  tmux kill-server 2>/dev/null || true
  sleep 2
done

echo "::error::Tests failed on all three attempts"
exit 1
