/**
 * Yjs document schema helpers (ARCHITECTURE_SPEC §4).
 *
 *   doc.getMap("nodes") : Y.Map<Y.Map<unknown>>   nodeId -> fields
 *   doc.getArray("order"): Y.Array<string>         z-order, back -> front
 *   doc.getMap("meta")  : Y.Map<unknown>           room-level settings
 *
 * All mutations run in a single transaction tagged with LOCAL_ORIGIN so a
 * Y.UndoManager tracking that origin only undoes the local user's edits.
 */
import * as Y from "yjs";
import { nanoid } from "nanoid";
import {
  BOARD_SCHEMA_VERSION,
  type BoardMeta,
  type BoardNode,
  type DistributiveOmit,
} from "@/contracts/board";

export const LOCAL_ORIGIN = "local";

export type NodeMap = Y.Map<unknown>;
export type NewNode = DistributiveOmit<BoardNode, "id" | "createdAt" | "updatedAt"> & { id?: string };

export function getNodes(doc: Y.Doc): Y.Map<NodeMap> {
  return doc.getMap<NodeMap>("nodes");
}

export function getOrder(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>("order");
}

export function getMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>("meta");
}

/** Ensure meta defaults exist. Safe to call on every client; keys only set when absent. */
export function initBoard(doc: Y.Doc): void {
  const meta = getMeta(doc);
  doc.transact(() => {
    if (!meta.has("schemaVersion")) meta.set("schemaVersion", BOARD_SCHEMA_VERSION);
    if (!meta.has("activeStyleId")) meta.set("activeStyleId", null);
    if (!meta.has("styleStrength")) meta.set("styleStrength", 1);
  }, LOCAL_ORIGIN);
}

export function readMeta(doc: Y.Doc): BoardMeta {
  const meta = getMeta(doc);
  return {
    schemaVersion: (meta.get("schemaVersion") as number | undefined) ?? BOARD_SCHEMA_VERSION,
    activeStyleId: (meta.get("activeStyleId") as BoardMeta["activeStyleId"] | undefined) ?? null,
    styleStrength: (meta.get("styleStrength") as number | undefined) ?? 1,
  };
}

function toYMap(node: BoardNode): NodeMap {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;
    if (node.type === "sticky" && key === "text") {
      map.set(key, new Y.Text(value as string));
    } else {
      map.set(key, value);
    }
  }
  return map;
}

/** Plain JS snapshot of a node (Y.Text -> string). */
export function readNode(map: NodeMap): BoardNode {
  const out: Record<string, unknown> = {};
  map.forEach((value, key) => {
    out[key] = value instanceof Y.Text ? value.toString() : value;
  });
  return out as unknown as BoardNode;
}

export function addNode(doc: Y.Doc, input: NewNode, now: number = Date.now()): string {
  const id = input.id ?? nanoid(12);
  const node = { ...input, id, createdAt: now, updatedAt: now } as BoardNode;
  doc.transact(() => {
    getNodes(doc).set(id, toYMap(node));
    getOrder(doc).push([id]);
  }, LOCAL_ORIGIN);
  return id;
}

/**
 * Replace a Y.Text's content with `next` using a minimal single-range edit (common
 * prefix/suffix kept), so two people typing in different parts of a sticky note merge
 * instead of overwriting each other.
 */
export function applyTextDiff(text: Y.Text, next: string): void {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  const maxStart = Math.min(prev.length, next.length);
  while (start < maxStart && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  if (endPrev > start) text.delete(start, endPrev - start);
  if (endNext > start) text.insert(start, next.slice(start, endNext));
}

type PartialUnion<T> = T extends unknown ? Partial<T> : never;
export type UpdatableFields = PartialUnion<DistributiveOmit<BoardNode, "id" | "type" | "createdBy" | "createdAt">>;

/** Field-level update: concurrent edits to different fields of one node both survive. */
export function updateNode(doc: Y.Doc, id: string, patch: UpdatableFields, now: number = Date.now()): boolean {
  const map = getNodes(doc).get(id);
  if (!map) return false;
  doc.transact(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const current = map.get(key);
      if (current instanceof Y.Text && typeof value === "string") {
        applyTextDiff(current, value);
      } else {
        map.set(key, value);
      }
    }
    map.set("updatedAt", now);
  }, LOCAL_ORIGIN);
  return true;
}

export function deleteNodes(doc: Y.Doc, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const remove = new Set(ids);
  doc.transact(() => {
    const nodes = getNodes(doc);
    for (const id of remove) nodes.delete(id);
    const order = getOrder(doc);
    // Walk backwards so indices stay valid while deleting.
    for (let i = order.length - 1; i >= 0; i--) {
      if (remove.has(order.get(i))) order.delete(i, 1);
    }
  }, LOCAL_ORIGIN);
}

/** Move a node to the front of the z-order. */
export function bringToFront(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    const order = getOrder(doc);
    const idx = order.toArray().indexOf(id);
    if (idx === -1 || idx === order.length - 1) return;
    order.delete(idx, 1);
    order.push([id]);
  }, LOCAL_ORIGIN);
}

/**
 * Nodes in render order. Ids present in `order` but missing in `nodes` (or vice
 * versa, possible transiently after concurrent deletes) are skipped / appended.
 */
export function listNodes(doc: Y.Doc): BoardNode[] {
  const nodes = getNodes(doc);
  const seen = new Set<string>();
  const out: BoardNode[] = [];
  for (const id of getOrder(doc).toArray()) {
    if (seen.has(id)) continue; // duplicate ids can appear if two clients re-order concurrently
    const map = nodes.get(id);
    if (!map) continue;
    seen.add(id);
    out.push(readNode(map));
  }
  nodes.forEach((map, id) => {
    if (!seen.has(id)) out.push(readNode(map));
  });
  return out;
}

export function createUndoManager(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([getNodes(doc), getOrder(doc)], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 400,
  });
}
