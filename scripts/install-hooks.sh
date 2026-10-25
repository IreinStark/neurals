#!/usr/bin/env bash
# One-time setup per clone: makes git use the hooks in .githooks/ (pre-push → scripts/check.sh --quick).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
chmod +x "$ROOT/.githooks/"* "$ROOT/scripts/check.sh"
git -C "$ROOT" config core.hooksPath .githooks
echo "Git hooks installed. Every 'git push' now runs scripts/check.sh --quick first."
echo "Run the full suite any time with: scripts/check.sh   (add --e2e for browser tests)"
