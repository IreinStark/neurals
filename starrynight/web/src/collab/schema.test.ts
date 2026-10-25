import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addNode,
  bringToFront,
  createUndoManager,
  deleteNodes,
  initBoard,
  listNodes,
  readMeta,
  updateNode,
  type NewNode,
} from "./schema";

const base = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, createdBy: "u1" } as const;

const rect = (id: string): NewNode => ({
  ...base,
  id,
  type: "rect",
  width: 10,
  height: 10,
  fill: "#fff",
  stroke: "#000",
  strokeWidth: 1,
});

/** Two peers that exchange every update immediately (like a perfect network). */
function connectedPair(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(b, u, "remote"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(a, u, "remote"));
  return [a, b];
}

/** Sync two docs that edited while offline. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("board schema", () => {
  it("initialises meta defaults once", () => {
    const doc = new Y.Doc();
    initBoard(doc);
    initBoard(doc);
    expect(readMeta(doc)).toEqual({ schemaVersion: 1, activeStyleId: null, styleStrength: 1 });
  });

  it("adds, updates and lists nodes in z-order", () => {
    const doc = new Y.Doc();
    addNode(doc, rect("a"), 1);
    addNode(doc, rect("b"), 2);
    updateNode(doc, "a", { x: 50 }, 3);
    bringToFront(doc, "a");
    const nodes = listNodes(doc);
    expect(nodes.map((n) => n.id)).toEqual(["b", "a"]);
    expect(nodes[1]).toMatchObject({ x: 50, updatedAt: 3, createdAt: 1 });
  });

  it("stores sticky text as Y.Text and reads it back as a string", () => {
    const doc = new Y.Doc();
    addNode(doc, { ...base, id: "s", type: "sticky", width: 100, height: 100, text: "hi", color: "#ff0" });
    updateNode(doc, "s", { text: "hello" });
    expect(listNodes(doc)[0]).toMatchObject({ type: "sticky", text: "hello" });
  });

  it("deletes from both nodes and order", () => {
    const doc = new Y.Doc();
    addNode(doc, rect("a"));
    addNode(doc, rect("b"));
    deleteNodes(doc, ["a"]);
    expect(listNodes(doc).map((n) => n.id)).toEqual(["b"]);
    expect(doc.getArray("order").toArray()).toEqual(["b"]);
  });
});

describe("CRDT merge behaviour", () => {
  it("converges when two peers edit different fields of the same node concurrently", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addNode(a, rect("n"));
    sync(a, b);

    updateNode(a, "n", { x: 100 }); // peer A moves
    updateNode(b, "n", { fill: "#f00" }); // peer B recolours
    sync(a, b);

    expect(listNodes(a)).toEqual(listNodes(b));
    expect(listNodes(a)[0]).toMatchObject({ x: 100, fill: "#f00" });
  });

  it("keeps both nodes when peers add concurrently", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addNode(a, rect("fromA"));
    addNode(b, rect("fromB"));
    sync(a, b);
    expect(listNodes(a).map((n) => n.id).sort()).toEqual(["fromA", "fromB"]);
    expect(listNodes(a)).toEqual(listNodes(b));
  });

  it("delete wins over a concurrent update of the deleted node", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    addNode(a, rect("n"));
    sync(a, b);
    deleteNodes(a, ["n"]);
    updateNode(b, "n", { x: 5 });
    sync(a, b);
    expect(listNodes(a)).toEqual([]);
    expect(listNodes(b)).toEqual([]);
  });

  it("propagates live between connected peers", () => {
    const [a, b] = connectedPair();
    addNode(a, rect("live"));
    expect(listNodes(b).map((n) => n.id)).toEqual(["live"]);
  });

  it("undo only reverts the local user's changes", () => {
    const [a, b] = connectedPair();
    const undoA = createUndoManager(a);
    addNode(a, rect("mine"));
    addNode(b, rect("theirs"));
    undoA.undo();
    expect(listNodes(a).map((n) => n.id)).toEqual(["theirs"]);
    expect(listNodes(b).map((n) => n.id)).toEqual(["theirs"]);
  });
});
