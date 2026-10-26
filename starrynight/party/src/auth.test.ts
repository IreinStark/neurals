import { describe, expect, it, vi } from "vitest";
import { authorize } from "./auth";

const ROOM = "3f2b8c1e-1111-4222-8333-444455556666";
const USER = "00000000-0000-0000-0000-00000000000b";
const supa = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service" };
const url = (q: string) => new URL(`http://localhost/parties/main/${ROOM}?${q}`);
const rows = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("authorize — dev mode", () => {
  const env = { ALLOW_DEV_AUTH: "true" };

  it("defaults to editor and accepts an explicit role", async () => {
    expect(await authorize("demo-room", url(""), env)).toMatchObject({ ok: true, role: "editor", mode: "dev" });
    expect(await authorize("demo-room", url("role=viewer&uid=carol"), env)).toMatchObject({
      ok: true,
      role: "viewer",
      userId: "carol",
    });
  });

  it("ignores unknown roles and rejects malformed room ids", async () => {
    expect(await authorize("demo", url("role=admin"), env)).toMatchObject({ role: "editor" });
    expect(await authorize("../etc", url(""), env)).toMatchObject({ ok: false, status: 400 });
  });

  it("fails closed when nothing is configured", async () => {
    expect(await authorize("demo", url(""), {})).toMatchObject({ ok: false, code: "auth_not_configured" });
  });
});

describe("authorize — Supabase mode", () => {
  const verifyToken = async () => ({ sub: USER });

  it("returns the member's role from room_members", async () => {
    const fetchImpl = rows([{ role: "viewer" }]);
    const result = await authorize(ROOM, url("token=t"), supa, { verifyToken, fetchImpl });
    expect(result).toEqual({ ok: true, userId: USER, role: "viewer", mode: "supabase" });
    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(endpoint.toString()).toContain(`room_id=eq.${ROOM}`);
    expect(endpoint.toString()).toContain(`user_id=eq.${USER}`);
    expect(new Headers(init.headers).get("apikey")).toBe("service");
  });

  it("takes precedence over dev mode", async () => {
    const result = await authorize(ROOM, url("role=owner"), { ...supa, ALLOW_DEV_AUTH: "true" });
    expect(result).toMatchObject({ ok: false, status: 401, code: "missing_token" });
  });

  it("rejects bad tokens, non-members and non-uuid rooms", async () => {
    const bad = async () => {
      throw new Error("bad signature");
    };
    expect(await authorize(ROOM, url("token=t"), supa, { verifyToken: bad })).toMatchObject({ status: 401 });
    expect(await authorize(ROOM, url("token=t"), supa, { verifyToken, fetchImpl: rows([]) })).toMatchObject({
      status: 403,
      code: "not_a_member",
    });
    expect(await authorize("demo-room", url("token=t"), supa, { verifyToken })).toMatchObject({ status: 400 });
  });

  it("reports lookup failures as 500 and missing service key as misconfiguration", async () => {
    expect(
      await authorize(ROOM, url("token=t"), supa, { verifyToken, fetchImpl: rows({ message: "boom" }, 503) }),
    ).toMatchObject({ status: 500, code: "membership_lookup_failed" });
    expect(await authorize(ROOM, url("token=t"), { SUPABASE_URL: supa.SUPABASE_URL })).toMatchObject({
      code: "server_misconfigured",
    });
  });
});
