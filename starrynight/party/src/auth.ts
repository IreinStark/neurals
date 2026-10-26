/**
 * Connection authorization for the board sync server (ARCHITECTURE_SPEC §5, decision D3).
 *
 * Two modes:
 *  - Supabase mode (SUPABASE_URL set): verify the Supabase access token, then look up
 *    the caller's row in room_members with the service role. No row -> 403.
 *  - Dev mode (no SUPABASE_URL and ALLOW_DEV_AUTH=true): anyone may join; the role comes
 *    from ?role= (default "editor") so viewer behaviour can be tested locally.
 * With neither configured, every connection is refused (fail closed).
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type Role = "owner" | "editor" | "viewer";
const ROLES: readonly Role[] = ["owner", "editor", "viewer"];

export interface AuthEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_JWT_SECRET?: string;
  ALLOW_DEV_AUTH?: string;
}

export type AuthResult =
  | { ok: true; userId: string; role: Role; mode: "supabase" | "dev" }
  | { ok: false; status: 400 | 401 | 403 | 500; code: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEV_ROOM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwksFor(supabaseUrl: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(supabaseUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL("/auth/v1/.well-known/jwks.json", supabaseUrl));
    jwksCache.set(supabaseUrl, jwks);
  }
  return jwks;
}

export interface AuthDeps {
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to JWKS (or the legacy HS256 secret when configured). */
  verifyToken?: (token: string) => Promise<{ sub?: string }>;
}

async function defaultVerify(token: string, env: AuthEnv): Promise<{ sub?: string }> {
  const issuer = new URL("/auth/v1", env.SUPABASE_URL).toString();
  const options = { issuer, audience: "authenticated" };
  if (env.SUPABASE_JWT_SECRET) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SUPABASE_JWT_SECRET), options);
    return payload;
  }
  const { payload } = await jwtVerify(token, jwksFor(env.SUPABASE_URL!), options);
  return payload;
}

export async function authorize(roomId: string, url: URL, env: AuthEnv, deps: AuthDeps = {}): Promise<AuthResult> {
  if (env.SUPABASE_URL) {
    if (!UUID_RE.test(roomId)) return { ok: false, status: 400, code: "invalid_room_id" };
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, status: 500, code: "server_misconfigured" };

    const token = url.searchParams.get("token");
    if (!token) return { ok: false, status: 401, code: "missing_token" };

    let userId: string | undefined;
    try {
      const payload = await (deps.verifyToken ?? ((t) => defaultVerify(t, env)))(token);
      userId = payload.sub;
    } catch {
      return { ok: false, status: 401, code: "invalid_token" };
    }
    if (!userId || !UUID_RE.test(userId)) return { ok: false, status: 401, code: "invalid_token" };

    const endpoint = new URL("/rest/v1/room_members", env.SUPABASE_URL);
    endpoint.searchParams.set("select", "role");
    endpoint.searchParams.set("room_id", `eq.${roomId}`);
    endpoint.searchParams.set("user_id", `eq.${userId}`);
    let res: Response;
    try {
      res = await (deps.fetchImpl ?? fetch)(endpoint, {
        headers: {
          apikey: env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          Accept: "application/json",
        },
      });
    } catch {
      return { ok: false, status: 500, code: "membership_lookup_failed" };
    }
    if (!res.ok) return { ok: false, status: 500, code: "membership_lookup_failed" };
    const rows = (await res.json()) as Array<{ role?: unknown }>;
    const role = rows[0]?.role;
    if (!isRole(role)) return { ok: false, status: 403, code: "not_a_member" };
    return { ok: true, userId, role, mode: "supabase" };
  }

  if (env.ALLOW_DEV_AUTH === "true") {
    if (!DEV_ROOM_RE.test(roomId)) return { ok: false, status: 400, code: "invalid_room_id" };
    const requested = url.searchParams.get("role");
    const role: Role = isRole(requested) ? requested : "editor";
    const userId = url.searchParams.get("uid")?.slice(0, 64) || "dev-anonymous";
    return { ok: true, userId, role, mode: "dev" };
  }

  return { ok: false, status: 500, code: "auth_not_configured" };
}
