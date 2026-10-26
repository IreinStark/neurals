# GP2 Whiteboard: Local Setup

This covers the M1 foundations (T1.1, T1.2, T2.1). The design and contracts are in [ARCHITECTURE_SPEC.md](ARCHITECTURE_SPEC.md).

## 1. Web app (Next.js 15, `starrynight/web`)

```bash
cd starrynight/web
nvm use 22            # Node ≥ 20.9 (Next 15). The GP1 CRA app in frontend/ still uses Node 18.
npm install
cp .env.example .env.local   # fill in Supabase values (optional until T2.2)
npm run dev                  # http://localhost:3000 (copies ONNX models into public/models first)
```

| Command | What it does |
|---|---|
| `npm run lint` / `npm run typecheck` | ESLint, `tsc --noEmit` (strict + `noUncheckedIndexedAccess`) |
| `npm test` | Vitest unit tests (tensor contract, RDP, CRDT merges, API client) |
| `npm run test:coverage` | Same, with a coverage report in `coverage/` |
| `npm run build` | Production build |
| `npm run e2e` | Playwright smoke + axe-core (run `npx playwright install chromium` once) |

`/api/v2/*` and `/media/*` are proxied to Django (`NEXT_PUBLIC_DJANGO_URL`, default `http://127.0.0.1:8000`), so the browser needs no CORS.

## 1b. Sync server (PartyKit, `starrynight/party`)

```bash
cd starrynight/party
npm install
npm run dev                  # ws://127.0.0.1:1999. Dev auth is on: anyone can join, and the role comes from ?role=
```

With both running, open http://localhost:3000 and click **New board**. To test with a second person, open the same board link in another browser window (or on another device on your network). Add `?role=viewer` to the link to join as a read-only viewer.

**Canvas shortcuts:**

| Key | Action |
|---|---|
| V | Select |
| H | Pan (or hold Space and drag) |
| P | Pen |
| R | Rectangle |
| O | Ellipse |
| A | Arrow |
| N | Sticky note |
| ⌘/Ctrl + scroll or pinch | Zoom |
| Scroll | Pan |
| ⌘0 | Zoom to fit |
| ⌘Z / ⇧⌘Z | Undo / redo |
| ⌫ | Delete |
| ⌘A | Select all |
| Double-click a sticky note | Edit its text |

Add `?debug=1` to a board link to show the FPS counter and expose `window.__board`, which the E2E tests use.

## 2. Backend (Django, `starrynight/backend`)

Same as GP1 (`python manage.py runserver`). New for GP2:

- `GET /api/v2/health/` → `{"status":"ok","service":"starrynight-backend","api":"v2"}`
- `GET /api/v2/styles/` → the fixed style catalog, with server and browser availability for each style

Tests: `python manage.py test api_v2 style_transfer.tests`

## 3. Database (Supabase, `starrynight/supabase`)

- `migrations/20261025000001_whiteboard_core.sql`: tables, role helpers, RPCs (`create_room`, `join_room`, `set_member_role`, `set_room_passcode`), RLS policies and column grants. `passcode_hash` is never readable by clients.
- `migrations/20261025000002_board_assets_storage.sql`: the `board-assets` bucket and its storage policies (path `<room_id>/<file>`).

**Apply to the Supabase project:** `supabase link --project-ref <ref>` and then `supabase db push` (run from `starrynight/`). You can also paste both files, in order, into the SQL editor.

**Run the RLS tests locally** (needs a disposable PostgreSQL 16; a Supabase stub is applied first):

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres starrynight/supabase/scripts/test-db.sh
```

## 4. Checks (local, instead of GitHub Actions)

GitHub Actions is paused because of the account billing lock (`.github/workflows/ci.yml` now only runs when started by hand). The same checks run locally:

```bash
scripts/install-hooks.sh     # once per clone: every `git push` now runs the quick checks first
scripts/check.sh             # full run: web lint/types/unit/build + sync server + Django + database RLS
scripts/check.sh --quick     # what the pre-push hook runs (no production build)
scripts/check.sh --e2e       # full run plus Playwright: two-browser sync, locks, viewer, a11y, 200-node FPS
scripts/check.sh --only web  # one section: web | party | backend | database
```

- A failing check **cancels the push** and prints the error. `git push --no-verify` skips the checks once.
- If Python (with Django + PyTorch) or Postgres can't be found, that section is **skipped** with a hint and does not block the push. Use `--strict` to make skips fail.
  - Python: the script looks for `starrynight/.venv` (made by `apply_fixes.sh`) or `PYTHON=/path/to/python`.
  - Postgres: `brew install postgresql@16 && brew services start postgresql@16`, or set `DATABASE_URL`.
- Web needs Node ≥ 20.9: `cd starrynight/web && nvm use` (reads `web/.nvmrc`, which is 22). The GP1 `frontend/` stays on Node 18.

To bring back GitHub Actions after the billing is fixed, uncomment the `push` / `pull_request` triggers at the top of `.github/workflows/ci.yml`.
