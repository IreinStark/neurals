/**
 * Presence helpers (T3.3): local identity, awareness-derived selection locks (spec D5),
 * and the list of remote peers to draw cursors / live strokes for.
 */
import type { AwarenessState, Role } from "@/contracts/board";

export interface Identity {
  id: string;
  name: string;
  color: string;
}

const COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f"];
const ADJECTIVES = ["Swift", "Bold", "Quiet", "Bright", "Calm", "Lucky", "Clever", "Gentle"];
const ANIMALS = ["Otter", "Falcon", "Lynx", "Panda", "Heron", "Fox", "Koala", "Orca"];

const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)]!;

/** Stable per-browser identity for dev mode (replaced by the Supabase profile in T2.2). */
export function loadIdentity(storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage()): Identity {
  try {
    const raw = storage?.getItem("starrynight.identity");
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Identity>;
      if (parsed.id && parsed.name && parsed.color) return parsed as Identity;
    }
  } catch {
    // corrupted or unavailable storage: fall through to a fresh identity
  }
  const identity: Identity = {
    id: `dev-${Math.random().toString(36).slice(2, 10)}`,
    name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`,
    color: pick(COLORS),
  };
  try {
    storage?.setItem("starrynight.identity", JSON.stringify(identity));
  } catch {
    // private mode etc. — identity just won't persist
  }
  return identity;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface LockInfo {
  clientId: number;
  user: AwarenessState["user"];
}

/**
 * Who holds each selected node. When several clients select the same node, the lowest
 * clientID wins, so every client computes the same answer without coordination.
 */
export function computeLocks(states: ReadonlyMap<number, Partial<AwarenessState>>): Map<string, LockInfo> {
  const locks = new Map<string, LockInfo>();
  for (const [clientId, state] of states) {
    if (!state.user || !Array.isArray(state.selection)) continue;
    for (const nodeId of state.selection) {
      const current = locks.get(nodeId);
      if (!current || clientId < current.clientId) locks.set(nodeId, { clientId, user: state.user });
    }
  }
  return locks;
}

/** Nodes this client may not edit because another client holds the lock. */
export function lockedForMe(locks: ReadonlyMap<string, LockInfo>, selfClientId: number): Map<string, LockInfo> {
  const out = new Map<string, LockInfo>();
  for (const [id, info] of locks) if (info.clientId !== selfClientId) out.set(id, info);
  return out;
}

export interface Peer {
  clientId: number;
  user: AwarenessState["user"];
  cursor: AwarenessState["cursor"];
  drawing: AwarenessState["drawing"];
}

export function remotePeers(states: ReadonlyMap<number, Partial<AwarenessState>>, selfClientId: number): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, s] of states) {
    if (clientId === selfClientId || !s.user) continue;
    peers.push({ clientId, user: s.user, cursor: s.cursor ?? null, drawing: s.drawing ?? null });
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}

export function canEdit(role: Role): boolean {
  return role === "owner" || role === "editor";
}
