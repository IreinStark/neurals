/**
 * Board sync server (T2.3). One PartyKit room per whiteboard; Yjs state is synced with
 * y-partykit and persisted as a snapshot in room storage. Viewers get read-only
 * connections: the server drops their document updates but still relays awareness
 * (cursors), so they appear in the room without being able to edit (spec D3).
 */
import type * as Party from "partykit/server";
import { onConnect } from "y-partykit";
import * as Y from "yjs";
import { authorize, isRole, type AuthEnv } from "./auth";

const ROLE_HEADER = "x-board-role";
const USER_HEADER = "x-board-user";

function envOf(env: Record<string, unknown>): AuthEnv {
  const str = (k: string) => (typeof env[k] === "string" ? (env[k] as string) : undefined);
  return {
    SUPABASE_URL: str("SUPABASE_URL"),
    SUPABASE_SERVICE_ROLE_KEY: str("SUPABASE_SERVICE_ROLE_KEY"),
    SUPABASE_JWT_SECRET: str("SUPABASE_JWT_SECRET"),
    ALLOW_DEV_AUTH: str("ALLOW_DEV_AUTH"),
  };
}

export default class BoardServer implements Party.Server {
  readonly options: Party.ServerOptions = { hibernate: false };

  constructor(readonly room: Party.Room) {}

  /** Runs before the WebSocket upgrade: reject unauthorized clients with a plain HTTP status. */
  static async onBeforeConnect(req: Party.Request, lobby: Party.Lobby) {
    const url = new URL(req.url);
    const result = await authorize(lobby.id, url, envOf(lobby.env));
    if (!result.ok) {
      return new Response(JSON.stringify({ error: { code: result.code } }), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Strip the token so it never reaches room code or logs, and pass the verified identity on.
    url.searchParams.delete("token");
    const headers = new Headers(req.headers);
    headers.set(ROLE_HEADER, result.role);
    headers.set(USER_HEADER, result.userId);
    return new Request(url.toString(), { method: req.method, headers }) as unknown as Party.Request;
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const role = ctx.request.headers.get(ROLE_HEADER);
    if (!isRole(role)) {
      conn.close(4001, "unauthorized");
      return;
    }
    const env = envOf(this.room.env);
    await onConnect(conn, this.room, {
      persist: { mode: "snapshot" },
      readOnly: role === "viewer",
      callback: env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
        ? {
            // Backup to Postgres (board_snapshots) at most every 30 s while the room is active.
            debounceWait: 30_000,
            debounceMaxWait: 60_000,
            handler: (doc) => saveSnapshot(env, this.room.id, doc),
          }
        : undefined,
    });
  }

  /** GET /parties/main/<room> → small health/info payload (useful for checks and the demo). */
  async onRequest(req: Party.Request) {
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return Response.json({ room: this.room.id, connections: [...this.room.getConnections()].length });
  }
}

async function saveSnapshot(env: AuthEnv, roomId: string, doc: Y.Doc): Promise<void> {
  const state = Y.encodeStateAsUpdate(doc);
  let hex = "";
  for (const byte of state) hex += byte.toString(16).padStart(2, "0");
  await fetch(new URL("/rest/v1/board_snapshots", env.SUPABASE_URL), {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    // PostgREST accepts bytea as a "\x..." hex string.
    body: JSON.stringify({ room_id: roomId, state: `\\x${hex}` }),
  });
}
