/**
 * Live sync tests against a running server (TC-E2E-01, sync half).
 * Skipped unless PARTYKIT_HOST is set, e.g.:
 *   npm run dev            # terminal 1
 *   PARTYKIT_HOST=127.0.0.1:1999 npm test   # terminal 2
 */
import { afterEach, describe, expect, it } from "vitest";
import YProvider from "y-partykit/provider";
import * as Y from "yjs";

// Tests run in Node; the package itself is typed for the Workers runtime (no @types/node).
declare const process: { env: Record<string, string | undefined> };
const HOST = process.env.PARTYKIT_HOST;
const providers: YProvider[] = [];

function join(room: string, role: "owner" | "editor" | "viewer") {
  const doc = new Y.Doc();
  const provider = new YProvider(HOST!, room, doc, {
    params: { role, uid: `${role}-${Math.random().toString(36).slice(2, 8)}` },
    disableBc: true, // force everything through the server, not BroadcastChannel
  });
  providers.push(provider);
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.once("synced", () => resolve());
  });
  return { doc, provider, synced };
}

function waitFor(check: () => boolean, timeoutMs = 3000): Promise<number> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve(performance.now() - start);
      if (performance.now() - start > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 2);
    };
    tick();
  });
}

afterEach(() => {
  for (const p of providers.splice(0)) p.destroy();
});

describe.skipIf(!HOST)("board sync server", () => {
  const room = () => `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  it("converges between two editors within 100 ms", async () => {
    const r = room();
    const a = join(r, "owner");
    const b = join(r, "editor");
    await Promise.all([a.synced, b.synced]);

    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      a.doc.getMap("nodes").set(`n${i}`, new Y.Map([["x", i]]) as Y.Map<unknown>);
      samples.push(await waitFor(() => b.doc.getMap("nodes").has(`n${i}`)));
    }
    samples.sort((x, y) => x - y);
    const median = samples[Math.floor(samples.length / 2)]!;
    console.log(`sync latency (ms) median=${median.toFixed(1)} max=${samples.at(-1)!.toFixed(1)}`);
    expect(median).toBeLessThanOrEqual(100);
  });

  it("drops document writes from viewers but still syncs state to them", async () => {
    const r = room();
    const editor = join(r, "editor");
    const viewer = join(r, "viewer");
    await Promise.all([editor.synced, viewer.synced]);

    editor.doc.getMap("nodes").set("fromEditor", 1);
    await waitFor(() => viewer.doc.getMap("nodes").has("fromEditor"));

    viewer.doc.getMap("nodes").set("fromViewer", 1);
    await new Promise((r) => setTimeout(r, 400));
    expect(editor.doc.getMap("nodes").has("fromViewer")).toBe(false);

    // A fresh client sees only the editor's change.
    const late = join(r, "editor");
    await late.synced;
    expect(late.doc.getMap("nodes").has("fromEditor")).toBe(true);
    expect(late.doc.getMap("nodes").has("fromViewer")).toBe(false);
  });

  it("relays viewer awareness (cursors) to editors", async () => {
    const r = room();
    const editor = join(r, "editor");
    const viewer = join(r, "viewer");
    await Promise.all([editor.synced, viewer.synced]);
    viewer.provider.awareness.setLocalStateField("cursor", { x: 10, y: 20 });
    await waitFor(() =>
      [...editor.provider.awareness.getStates().values()].some((s) => s.cursor?.x === 10 && s.cursor?.y === 20),
    );
  });
});
