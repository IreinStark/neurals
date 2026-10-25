#!/usr/bin/env bash
# =============================================================================
# Local replacement for the GitHub Actions CI (.github/workflows/ci.yml).
# Runs the same checks on your own machine. Works with macOS's default bash 3.2.
#
#   scripts/check.sh            full run: web (lint, types, unit, build) + backend + database
#   scripts/check.sh --quick    what the pre-push hook runs: skips the production build
#   scripts/check.sh --e2e      full run + Playwright browser/accessibility tests
#   scripts/check.sh --strict   treat "skipped" sections (missing Python/Postgres) as failures
#   scripts/check.sh --only web|backend|database   run one section
#
# Environment overrides:
#   PYTHON=/path/to/python      Python with the backend requirements installed
#   DATABASE_URL=postgres://... superuser URL on a disposable Postgres 16 (enables DB tests)
# =============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/starrynight"

QUICK=0; E2E=0; STRICT=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --e2e) E2E=1 ;;
    --strict) STRICT=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

PASSED=""; FAILED=""; SKIPPED=""
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/starrynight-check.XXXXXX")"

section() { printf '\n%s▸ %s%s\n' "$BOLD" "$1" "$RESET"; }
skip()    { printf '  %s↷ skipped:%s %s\n' "$YELLOW" "$RESET" "$2"; SKIPPED="$SKIPPED\n  $1 — $2"; }

# step "<label>" <dir> <command...>  — output hidden unless the step fails.
step() {
  label="$1"; dir="$2"; shift 2
  log="$LOG_DIR/$(echo "$label" | tr -c 'a-zA-Z0-9' '_').log"
  printf '  %-34s' "$label"
  start=$(date +%s)
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    printf '%s✓%s %s(%ss)%s\n' "$GREEN" "$RESET" "$DIM" "$(( $(date +%s) - start ))" "$RESET"
    PASSED="$PASSED\n  $label"
  else
    printf '%s✗%s\n' "$RED" "$RESET"
    echo "${DIM}------ last 40 lines of output ------${RESET}"
    tail -n 40 "$log"
    echo "${DIM}------ full log: $log ------${RESET}"
    FAILED="$FAILED\n  $label"
  fi
}

want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

# ------------------------------------------------------------------- web ---
if want web; then
  section "Web (Next.js) — starrynight/web"
  if ! command -v node >/dev/null 2>&1; then
    skip "web" "node not found (install Node 22, e.g. 'nvm install 22')"
  else
    node_major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$node_major" -lt 20 ]; then
      skip "web" "Node $(node -v) is too old for Next.js 15 — run 'cd starrynight/web && nvm use' (uses web/.nvmrc → 22)"
    else
      if [ ! -d "$APP/web/node_modules" ]; then
        step "install dependencies (npm ci)" "$APP/web" npm ci --no-audit --no-fund
      fi
      step "lint (eslint)" "$APP/web" npm run --silent lint
      step "typecheck (tsc)" "$APP/web" npm run --silent typecheck
      step "unit tests (vitest)" "$APP/web" npm run --silent test
      if [ "$QUICK" -eq 0 ]; then
        step "production build (next build)" "$APP/web" npm run --silent build
      fi
      if [ "$E2E" -eq 1 ]; then
        if [ ! -d "$APP/web/.next" ]; then
          step "production build (next build)" "$APP/web" npm run --silent build
        fi
        step "e2e + a11y (playwright)" "$APP/web" npx playwright test
      fi
    fi
  fi
fi

# --------------------------------------------------------------- backend ---
find_python() {
  for candidate in "${PYTHON:-}" "$APP/.venv/bin/python" "$APP/backend/.venv/bin/python" "$APP/venv/bin/python" python3 python; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ] || continue
    if "$candidate" -c "import django, rest_framework, torch" >/dev/null 2>&1; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}

if want backend; then
  section "Backend (Django) — starrynight/backend"
  if PY="$(find_python)"; then
    printf '  %susing %s%s\n' "$DIM" "$PY" "$RESET"
    export CACHE_BACKEND="${CACHE_BACKEND:-locmem}" WEBCAM_VIDEO_TASK_MODE="${WEBCAM_VIDEO_TASK_MODE:-thread}"
    step "django check" "$APP/backend" "$PY" manage.py check
    step "django tests" "$APP/backend" "$PY" manage.py test api_v2 style_transfer.tests
  else
    skip "backend" "no Python with Django + PyTorch found (run starrynight/apply_fixes.sh, or set PYTHON=...)"
  fi
fi

# -------------------------------------------------------------- database ---
if want database; then
  section "Database (Supabase migrations + RLS) — starrynight/supabase"
  db_url="${DATABASE_URL:-}"
  if [ -z "$db_url" ] && command -v pg_isready >/dev/null 2>&1 && pg_isready -q -h localhost -p 5432 2>/dev/null; then
    db_url="postgres://${PGUSER:-$(whoami)}@localhost:5432/postgres"   # Homebrew Postgres default
  fi
  if ! command -v psql >/dev/null 2>&1; then
    skip "database" "psql not found (macOS: 'brew install postgresql@16 && brew services start postgresql@16')"
  elif [ -z "$db_url" ]; then
    skip "database" "no running Postgres found (start one, or set DATABASE_URL)"
  else
    step "migrations + RLS tests" "$APP/supabase" env DATABASE_URL="$db_url" bash scripts/test-db.sh
  fi
fi

# --------------------------------------------------------------- summary ---
printf '\n%sSummary%s\n' "$BOLD" "$RESET"
[ -n "$PASSED" ]  && printf '%s✓ passed%s%b\n' "$GREEN" "$RESET" "$PASSED"
[ -n "$SKIPPED" ] && printf '%s↷ skipped%s%b\n' "$YELLOW" "$RESET" "$SKIPPED"
[ -n "$FAILED" ]  && printf '%s✗ failed%s%b\n' "$RED" "$RESET" "$FAILED"

if [ -n "$FAILED" ]; then
  exit 1
elif [ -n "$SKIPPED" ] && [ "$STRICT" -eq 1 ]; then
  echo "${RED}--strict: skipped sections count as failures.${RESET}"
  exit 1
elif [ -z "$PASSED" ]; then
  echo "${YELLOW}Nothing was checked — every section was skipped.${RESET}"
  exit 0
fi
rm -rf "$LOG_DIR"
echo "${GREEN}All checks passed.${RESET}"
