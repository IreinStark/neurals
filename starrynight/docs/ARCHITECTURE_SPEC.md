# Architecture Spec & Contracts — Collaborative AI Whiteboard (T1.1)

**Project:** StarryNight GP2, Collaborative AI Whiteboard System (SWE-492, NEU, Fall 2026–2027)
**WBS:** 1.1 Requirements & API Contracts · 1.2 DB Schema & Worker Protocol
**Source of truth:** *Software Implementation Plan: Collaborative AI Whiteboard System*. This document makes that plan concrete. Where the plan leaves a choice open (for example "Liveblocks / PartyKit"), the decision taken here is marked **Decision**.

---

## 1. Scope recap (from plan §1)

| In scope | Where it lives |
|---|---|
| Collaborative infinite canvas (freehand, shapes, sticky notes, images) | `web/` (Konva + Zustand) |
| Real-time CRDT sync + presence (cursors, selection locks, deltas) | `web/` + `party/` (Yjs) |
| Client-side ONNX inference in a Web Worker | `web/src/workers/style-preview-worker.ts` |
| Temporally consistent video stylization (ReCoNet, TWE) | `backend/` (existing Django + `reco/`) |
| Evaluation & benchmarking (FPS, latency, PSNR, MAE, LPIPS, TWE, HTML report) | `backend/scripts/` + `web/` dashboard |
| Sessions, roles (Owner/Editor/Viewer), passcode rooms, RLS, PNG/SVG/MP4 export | `supabase/` + `web/` |

**Out of scope (plan §1.2):** model training from scratch, native mobile apps, and WebRTC audio/video calling. The GP2 ideas from the earlier design notes (AdaIN, WebRTC live streaming, Gallery) are **not** in this plan and are not built unless the plan is amended.

---

## 2. Repository layout (monorepo)

```
neurals/
├── .github/workflows/ci.yml          # T1.2: web + backend CI
├── Real-time-Coherent-Style-Transfer-For-Videos/   # research code (unchanged)
└── starrynight/
    ├── backend/                       # Django (existing) — video + evaluation API
    │   ├── style_transfer/            # v1 endpoints (unchanged) + v2 endpoints
    │   └── scripts/                   # export_onnx.py, evaluate_style_transfer.py, ...
    ├── frontend/                      # GP1 CRA app (kept for reference, frozen)
    ├── web/                           # NEW: Next.js 15 whiteboard app
    │   ├── public/models/*.onnx       # served ONNX assets (copied from frontend/public/models)
    │   └── src/
    │       ├── app/                   # App Router routes
    │       ├── canvas/                # Konva stage, tools, node renderers
    │       ├── collab/                # Yjs doc schema, provider, awareness
    │       ├── ml/                    # worker client, tensor utils, EP selection
    │       ├── workers/               # style-preview-worker.ts
    │       ├── lib/                   # supabase client, django client, env
    │       └── contracts/             # shared TS types (this spec, in code)
    ├── party/                         # NEW: PartyKit Yjs sync server
    ├── supabase/migrations/           # NEW: SQL schema + RLS (T2.1)
    └── docs/ARCHITECTURE_SPEC.md      # this file
```

---

## 3. System architecture

```
┌──────────────────────── Browser (Next.js 15 / React 19) ────────────────────────┐
│  Konva Stage ◄── Zustand (viewport, tool, local UI state)                        │
│      ▲  │                                                                        │
│      │  ▼                                                                        │
│  Y.Doc (nodes / order / meta) ◄──► YPartyKitProvider ──WebSocket──┐              │
│  Awareness (cursor, selection, live stroke)                       │              │
│                                                                   │              │
│  ML client ──postMessage(Transferable)──► style-preview-worker    │              │
│                                            onnxruntime-web        │              │
│                                            webgpu → webgl → wasm  │              │
└────────────┬──────────────────────────┬───────────────────────────┼──────────────┘
             │ supabase-js (JWT)        │ fetch (Bearer JWT)         │
             ▼                          ▼                            ▼
   ┌──────────────────┐     ┌──────────────────────────┐   ┌────────────────────┐
   │ Supabase          │     │ Django (backend/)         │   │ PartyKit (party/)  │
   │ Postgres 16 + RLS │◄────│ /api/v2/video/*           │   │ y-partykit server  │
   │ Auth · Storage    │ JWKS│ /api/v2/eval/*            │   │ onConnect: verify  │
   │ RPC join_room...  │     │ Celery/thread → reco_infer│   │ JWT + role → read- │
   └──────────────────┘     │ evaluate_style_transfer   │   │ only for Viewer    │
            ▲               └──────────────────────────┘   └─────────┬──────────┘
            └───────────────── service-role: membership lookup, snapshots ──┘
```

### 3.1 Key decisions

| # | Decision | Reason |
|---|---|---|
| D1 | **PartyKit + `y-partykit`** for sync (Liveblocks kept as a drop-in alternative behind `collab/provider.ts`) | Runs fully locally (`npx partykit dev`) with no paid key, self-hostable, native Yjs. |
| D2 | **Supabase Auth is the single identity.** Django verifies Supabase JWTs through JWKS and no longer issues its own tokens for v2. | One login across canvas, sync and video. GP1 SimpleJWT endpoints stay for v1. |
| D3 | **Role enforcement in three places:** Postgres RLS (persisted data), PartyKit `onConnect` (CRDT writes: Viewer connections are `readOnly`), and the UI (tools disabled). | RLS alone can't stop CRDT writes, because they never touch Postgres. TC-E2E-01 needs Viewer writes rejected on both paths. |
| D4 | **Live strokes are ephemeral and only committed strokes are CRDT data** (R2 mitigation) | In-progress points go through awareness; on pointer-up the path is simplified with Ramer–Douglas–Peucker and written once to Yjs. |
| D5 | **Object locks are awareness-derived and never stored** | A node is locked for me if another client's awareness `selection` contains it. On a tie, the lower `clientID` wins. Locks disappear when the client disconnects. |
| D6 | **Image assets go to Supabase Storage and the CRDT stores only the URL plus metadata** | Keeps the Y.Doc small, so sync stays fast under the 200-node load in TC-NFR-01. |
| D7 | **Existing ONNX assets are reused** (`frontend/public/models/*.onnx`, opset 11, dynamic H/W) | T4.1 is effectively done. Only validation and a manifest are added. |

---

## 4. CRDT document schema (Yjs)

One `Y.Doc` per room. Room ID = `rooms.id` (UUID) = PartyKit room name.

```
Y.Doc
├── nodes : Y.Map<string, Y.Map<any>>   // nodeId → node fields (one Y.Map per node)
├── order : Y.Array<string>             // z-order, back → front
└── meta  : Y.Map<any>                  // room-level shared settings
      ├── schemaVersion : 1
      ├── activeStyleId : StyleId | null
      └── styleStrength : number          // 0..1, blend for previews
```

### 4.1 Node fields (all nodes)

| Field | Type | Notes |
|---|---|---|
| `id` | string (nanoid 12) | Also the key in `nodes`. |
| `type` | `"stroke" \| "rect" \| "ellipse" \| "arrow" \| "sticky" \| "image"` | |
| `x`, `y` | number | World coordinates (pre-viewport). |
| `rotation` | number | Degrees. |
| `scaleX`, `scaleY` | number | Default 1. |
| `createdBy` | string (auth user id) | |
| `createdAt`, `updatedAt` | number (epoch ms) | |

### 4.2 Type-specific fields

| Type | Fields |
|---|---|
| `stroke` | `points: number[]` (flat `[x0,y0,x1,y1,…]`, relative to `x,y`, RDP-simplified, ε = 1.0 px), `color`, `width`, `opacity` |
| `rect` / `ellipse` | `width`, `height`, `fill`, `stroke`, `strokeWidth` |
| `arrow` | `points: number[]` (4 values), `stroke`, `strokeWidth` |
| `sticky` | `width`, `height`, `text` (**Y.Text**, so concurrent typing merges), `color` |
| `image` | `width`, `height`, `src` (Supabase Storage public/signed path), `assetId`, `styleId?` (set when the image is a committed style result), `sourceNodeIds?` |

**Mutation rules**

- Always mutate inside `doc.transact(fn, origin)` with `origin = "local"` for user edits, so undo (`Y.UndoManager` scoped to `nodes`/`order`, `trackedOrigins: {"local"}`) never undoes remote changes.
- Deleting a node removes it from both `nodes` and `order` in one transaction.
- Field updates go to the node's inner `Y.Map` (fine-grained, so concurrent move + recolor both survive).

### 4.3 Awareness state (ephemeral, per client)

```ts
{
  user:      { id: string; name: string; color: string; role: Role };
  cursor:    { x: number; y: number } | null;        // world coords, throttled to 30 Hz
  selection: string[];                                // node ids → lock source (D5)
  drawing:   { points: number[]; color: string; width: number } | null; // live stroke (D4)
  viewport?: { x: number; y: number; scale: number }; // optional "follow" mode
}
```

---

## 5. Sync server contract (`party/`)

- **URL:** `ws(s)://<PARTYKIT_HOST>/parties/main/<roomId>?token=<supabase_access_token>`
- **`onConnect`:**
  1. Verify the JWT against the Supabase JWKS (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`). If it fails, close with code `4001`.
  2. Look up `room_members(room_id, user_id)` with the service role. No row → close `4003`.
  3. `role = 'viewer'` → `readOnly: true` (the server drops document updates; awareness still works so the viewer's cursor shows).
- **Persistence:** `y-partykit` `persist: { mode: "snapshot" }`, plus a debounced (30 s) upsert of `Y.encodeStateAsUpdate(doc)` into `board_snapshots` so a room can be restored if PartyKit storage is wiped.
- **Load:** if PartyKit has no state for the room, seed it from the latest `board_snapshots` row.

---

## 6. Database contract (summary; full SQL in `supabase/migrations`, T2.1)

| Table | Purpose | Key columns |
|---|---|---|
| `profiles` | Display info per auth user | `id (=auth.users.id)`, `display_name`, `avatar_color` |
| `rooms` | Whiteboard sessions | `id uuid`, `name`, `owner_id`, `passcode_hash` (bcrypt via pgcrypto, nullable), `default_role` (`editor\|viewer`), `created_at` |
| `room_members` | Role per user per room | `room_id`, `user_id`, `role` (`owner\|editor\|viewer`), PK `(room_id,user_id)` |
| `board_snapshots` | CRDT backups | `room_id`, `state bytea`, `created_at` |
| `board_assets` | Uploaded images metadata | `id`, `room_id`, `storage_path`, `width`, `height`, `uploaded_by` |
| `style_telemetry` | Benchmark/inference telemetry | `room_id?`, `user_id`, `style_id`, `backend` (`webgpu\|webgl\|wasm\|server-cpu\|server-cuda`), `input_w`, `input_h`, `latency_ms`, `fps?`, `psnr?`, `mae?`, `lpips?`, `twe?`, `created_at` |
| `video_jobs` | Mirror of Django jobs per user | `id (= Django job_id)`, `room_id?`, `user_id`, `style_id`, `status`, `progress`, `output_url`, `metrics jsonb` |

**RPCs (SECURITY DEFINER):**

- `create_room(name, passcode?, default_role)` → `uuid`: inserts the room and adds the owner as a member.
- `join_room(room_id, passcode?)` → `role`: checks the passcode and inserts the caller with `default_role`.
- `set_member_role(room_id, user_id, role)`: Owner only, and the owner can't be demoted.

**RLS rules in one line each:**

- Members can read their rooms.
- Only the Owner can update or delete a room.
- Owners and Editors can write snapshots and assets.
- Viewers can only read.
- Users read and write only their own telemetry and video jobs.

---

## 7. REST contracts

Existing GP1 endpoints under `/style_transfer/*` and `/accounts/*` remain **unchanged** (v1). New endpoints are versioned under `/api/v2/`. All v2 endpoints need `Authorization: Bearer <supabase_access_token>`, except `GET /api/v2/health/` and `GET /api/v2/styles/`, which are public (static catalog, no user data).

### 7.1 Styles

`GET /api/v2/styles/` → `200`
```json
{ "styles": [ { "id": "starry-night", "label": "Starry Night", "serverAvailable": true,
                "onnx": "/models/starry-night.onnx" } ] }
```
Style IDs (fixed): `starry-night`, `mosaic`, `udnie`, `wave`, `tokyo-ghoul`, `lazy`, `bayanihan` (+ `pointilism`, browser-only, fixed 224×224).

### 7.2 Video jobs (T5.1)

`POST /api/v2/video/jobs/` (multipart): `video` (mp4/webm ≤ 50 MB), `style_id`, `mode` = `reconet` (temporal, default) | `per-frame` (baseline), `room_id?`, `target_fps?` (default 15)
→ `202 { "job_id": "…", "status": "queued", "execution_mode": "celery|thread" }`

`GET /api/v2/video/jobs/<job_id>/` → `200`
```json
{ "job_id": "…", "status": "queued|processing|completed|failed", "progress": 0.0,
  "output_url": "/media/output/video-<id>.mp4", "error": null,
  "metrics": { "fps": 1.25, "twe": 0.0149 } }
```
Errors: `400` validation (`{"error": {"code": "invalid_style", "message": "…"}}`), `401` bad/missing token, `404` unknown job or not owner, `413` too large.

### 7.3 Evaluation (T5.2)

`POST /api/v2/eval/runs/` JSON `{ "styles": ["starry-night", …], "clip": "default-60f", "modes": ["reconet","per-frame"] }` → `202 { "run_id": "…" }`
`GET /api/v2/eval/runs/<run_id>/` → `{ "status": "…", "rows": [ { "style_id", "mode", "fps", "psnr", "mae", "lpips", "twe" } ], "report_url": "/media/eval/<run_id>/report.html" }`

### 7.4 Error envelope (all v2)

```json
{ "error": { "code": "snake_case_code", "message": "Human readable", "details": {} } }
```

---

## 8. Web Worker protocol (`style-preview-worker.ts`, T4.2)

### 8.1 Model I/O contract (verified against the repo's ONNX files)

| Model | Input | Output | Range |
|---|---|---|---|
| TransformerNet ×7 (`<style>.onnx`) | `input` float32 `[1,3,H,W]`, dynamic H/W | `output` float32 `[1,3,H,W]` | in **0–255**, out unclamped (≈ −60…390) → clamp to 0–255 |
| `pointilism-10.onnx` | `input1` float32 `[1,3,224,224]` fixed | `output1` same | 0–255 → resize ROI to 224² first |

"Normalized tensor" (TC-UNT-01) means **RGBA HWC Uint8 → RGB CHW Float32 in 0–255**, with alpha dropped and kept separately for compositing. There is **no** ImageNet mean/std, because the models were trained on raw 0–255 input.

### 8.2 Messages: main → worker

```ts
type ToWorker =
  | { type: "init";    reqId: string; modelUrl: string; styleId: StyleId;
      preferredEP?: ("webgpu" | "webgl" | "wasm")[] }
  | { type: "infer";   reqId: string; styleId: StyleId; width: number; height: number;
      pixels: ArrayBuffer /* RGBA Uint8, transferred */; maxSide?: number /* default 512 */ }
  | { type: "cancel";  reqId: string }
  | { type: "dispose"; styleId?: StyleId };
```

### 8.3 Messages: worker → main

```ts
type FromWorker =
  | { type: "ready";  reqId: string; styleId: StyleId; ep: "webgpu" | "webgl" | "wasm"; loadMs: number }
  | { type: "result"; reqId: string; styleId: StyleId; width: number; height: number;
      pixels: ArrayBuffer /* RGBA Uint8, transferred */;
      timings: { preMs: number; inferMs: number; postMs: number; totalMs: number }; ep: string }
  | { type: "error";  reqId: string; code: "model_missing" | "ep_unavailable" | "oom" | "cancelled" | "internal";
      message: string };
```

### 8.4 Rules

- All `pixels` buffers are **transferred** (zero-copy, R1 mitigation). The sender must not touch a buffer after posting it.
- EP fallback order `webgpu → webgl → wasm (SIMD, threads when crossOriginIsolated)` (R4). On fallback to wasm, `maxSide` drops to 384 automatically.
- Before creating a session, the worker sends `HEAD modelUrl`. A 404 gives `error{code:"model_missing"}` (TC-UNT-01 "verifies checkpoint existence").
- Sessions are cached per `styleId` (LRU, max 2) to limit GPU memory.
- One inference runs at a time. A new `infer` for the same style replaces any queued one (latest wins), so dragging a region never builds a backlog.
- Pre-processing target: ≤ 15 ms for 512×512 (TC-UNT-01).

---

## 9. Canvas ↔ ML bridge (T4.3)

1. The user selects nodes or drags an ROI rectangle.
2. `stage.toCanvas({ x, y, width, height, pixelRatio })` gives the ROI pixels, then `getImageData` → `ArrayBuffer`.
3. Post `infer` to the worker, get `result`, and paint it to an offscreen canvas.
4. A before/after slider overlay shows the result locally only (not in the CRDT).
5. **Commit:** upload the PNG to Storage, then add an `image` node with `styleId` and `sourceNodeIds` in one transaction, and log telemetry to `style_telemetry`.

---

## 10. Requirement → test traceability

| Plan test | Covers | Implemented in |
|---|---|---|
| TC-UNT-01 | §8.1 tensor contract, ≤ 15 ms, model existence | `web/src/ml/*.test.ts` (Vitest) |
| TC-E2E-01 | §4 convergence ≤ 100 ms, D3 viewer rejection (sync + RLS) | `web/e2e/sync.spec.ts` (Playwright, 3 contexts) |
| TC-INT-01 | §7.2 `reconet` vs `per-frame`, TWE ≥ 35 % lower | `backend/style_transfer/tests/test_twe_benchmark.py` (PyTest) |
| TC-NFR-01 | axe-core zero critical/serious, ≥ 55 FPS at 200 nodes | `web/e2e/a11y-perf.spec.ts` |

---

## 11. Environment variables

| Var | Used by | Example |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web, party, backend | `https://xyz.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web | `eyJ…` |
| `SUPABASE_SERVICE_ROLE_KEY` | party, backend (server only) | `eyJ…` |
| `NEXT_PUBLIC_PARTYKIT_HOST` | web | `127.0.0.1:1999` |
| `NEXT_PUBLIC_DJANGO_URL` | web | `http://127.0.0.1:8000` |
| `SUPABASE_JWKS_URL` | backend, party | `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` |

---

## 12. Schedule note (plan §5 vs. actual state on 2026-10-25)

- **M1 (Oct 9)** was not met in code: the repo's last commit (May 19) has no whiteboard foundations. This spec, together with T1.2 and T2.1, closes M1.
- **Inconsistency in the plan:** M2 (Nov 6) includes "ONNX Worker Integration", but the phase table schedules 4.0 for W8–W10 (Nov 16–27). Because T4.1 is already done (D7) and T4.2 depends only on T4.1, T4.2 can run in parallel with T3.x before the midterm freeze (Nov 7–13). T4.3 (which also needs T3.2) stays after midterms.
