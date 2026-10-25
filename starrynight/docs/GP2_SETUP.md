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

## 4. CI

`.github/workflows/ci.yml` runs three jobs on every push and PR:

- **web:** lint → typecheck → unit tests with coverage → build → Playwright + axe
- **backend:** Django check + tests, using CPU-only PyTorch
- **database:** migrations and RLS tests against a Postgres 16 service
