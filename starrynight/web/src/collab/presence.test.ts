import { describe, expect, it } from "vitest";
import type { AwarenessState } from "@/contracts/board";
import { canEdit, computeLocks, loadIdentity, lockedForMe, remotePeers } from "./presence";

const user = (name: string) => ({ id: name, name, color: "#000", role: "editor" as const });
const state = (name: string, selection: string[], extra: Partial<AwarenessState> = {}): Partial<AwarenessState> => ({
  user: user(name),
  selection,
  cursor: null,
  drawing: null,
  ...extra,
});

describe("computeLocks", () => {
  it("gives each selected node to the lowest clientID", () => {
    const states = new Map([
      [7, state("bob", ["a", "b"])],
      [3, state("alice", ["b"])],
    ]);
    const locks = computeLocks(states);
    expect(locks.get("a")?.user.name).toBe("bob");
    expect(locks.get("b")?.user.name).toBe("alice");
  });

  it("only reports other clients' locks as locked-for-me", () => {
    const states = new Map([
      [3, state("alice", ["x"])],
      [7, state("me", ["x", "y"])],
    ]);
    const mine = lockedForMe(computeLocks(states), 7);
    expect([...mine.keys()]).toEqual(["x"]); // alice wins x; y is mine
  });

  it("ignores clients without a user or selection", () => {
    const states = new Map<number, Partial<AwarenessState>>([[1, {}], [2, { user: user("z") }]]);
    expect(computeLocks(states).size).toBe(0);
  });
});

describe("remotePeers", () => {
  it("excludes self and sorts by clientID", () => {
    const states = new Map([
      [9, state("c", [], { cursor: { x: 1, y: 2 } })],
      [2, state("a", [])],
      [5, state("self", [])],
    ]);
    expect(remotePeers(states, 5).map((p) => p.user.name)).toEqual(["a", "c"]);
  });
});

describe("loadIdentity", () => {
  it("persists and reuses the identity", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const first = loadIdentity(storage);
    expect(loadIdentity(storage)).toEqual(first);
  });

  it("survives corrupted storage", () => {
    const storage = { getItem: () => "{not json", setItem: () => undefined };
    expect(loadIdentity(storage).name).toMatch(/\w+ \w+/);
  });
});

it("canEdit: viewers cannot", () => {
  expect(canEdit("owner")).toBe(true);
  expect(canEdit("editor")).toBe(true);
  expect(canEdit("viewer")).toBe(false);
});
