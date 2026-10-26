/**
 * Multi-user whiteboard E2E (TC-E2E-01 sync half, TC-NFR-01 partial).
 * Runs against the production build + local PartyKit dev server (see playwright.config.ts).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";

type BoardHook = {
  nodes: () => Array<{ id: string; type: string; x: number; y: number; text?: string }>;
  peers: () => Array<{ user: { name: string }; cursor: { x: number; y: number } | null }>;
  doc: { getMap: (name: string) => { set: (k: string, v: unknown) => void } };
};

const room = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function openBoard(browser: Browser, roomId: string, role: "editor" | "viewer" = "editor"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/board/${roomId}?debug=1${role === "viewer" ? "&role=viewer" : ""}`);
  await expect(page.getByTestId("connection-status")).toContainText("Live", { timeout: 15_000 });
  return page;
}

const nodes = (page: Page) => page.evaluate(() => (window as unknown as { __board: BoardHook }).__board.nodes());

/** Drag on the canvas between two screen points (relative to the canvas). */
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.getByTestId("board-canvas").boundingBox())!;
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      box.x + from[0] + ((to[0] - from[0]) * i) / 8,
      box.y + from[1] + ((to[1] - from[1]) * i) / 8,
    );
  }
  await page.mouse.up();
}

test.describe("collaborative board", () => {
  test("a rectangle drawn by one editor appears for another", async ({ browser }) => {
    const id = room();
    const a = await openBoard(browser, id);
    const b = await openBoard(browser, id);

    await a.keyboard.press("r");
    await drag(a, [500, 300], [700, 450]);

    await expect.poll(() => nodes(b).then((n) => n.map((x) => x.type))).toEqual(["rect"]);
    await expect(b.getByTestId("node-count")).toHaveText("1 objects");
    await expect(a.getByTestId("peer-count")).toHaveText("2 here");
  });

  test("freehand strokes, arrows, ellipses and sticky notes sync", async ({ browser }) => {
    const id = room();
    const a = await openBoard(browser, id);
    const b = await openBoard(browser, id);

    await a.keyboard.press("p");
    await drag(a, [300, 300], [420, 360]);
    await a.keyboard.press("o");
    await drag(a, [600, 200], [700, 260]);
    await a.keyboard.press("a");
    await drag(a, [600, 500], [800, 520]);

    await a.keyboard.press("n");
    const box = (await a.getByTestId("board-canvas").boundingBox())!;
    await a.mouse.click(box.x + 900, box.y + 300);
    await a.getByLabel("Sticky note text").fill("Demo on Nov 6");
    await a.keyboard.press("Escape");

    await expect
      .poll(() => nodes(b).then((n) => n.map((x) => x.type).sort()))
      .toEqual(["arrow", "ellipse", "sticky", "stroke"]);
    await expect.poll(() => nodes(b).then((n) => n.find((x) => x.type === "sticky")?.text)).toBe("Demo on Nov 6");
  });

  test("remote cursors are shared", async ({ browser }) => {
    const id = room();
    const a = await openBoard(browser, id);
    const b = await openBoard(browser, id);
    const box = (await a.getByTestId("board-canvas").boundingBox())!;
    await a.mouse.move(box.x + 640, box.y + 400);
    await a.mouse.move(box.x + 650, box.y + 410);
    await expect
      .poll(() => b.evaluate(() => (window as unknown as { __board: BoardHook }).__board.peers().filter((p) => p.cursor).length))
      .toBe(1);
  });

  test("a node selected by one user is locked for others", async ({ browser }) => {
    const id = room();
    const a = await openBoard(browser, id);
    const b = await openBoard(browser, id);

    await a.keyboard.press("r");
    await drag(a, [500, 300], [700, 450]); // creates and selects the rect on A
    await expect.poll(() => nodes(b).then((n) => n.length)).toBe(1);
    const before = (await nodes(b))[0]!;

    // B tries to drag the locked rect: it must not move.
    await drag(b, [600, 380], [900, 600]);
    await b.waitForTimeout(300);
    const after = (await nodes(a))[0]!;
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });

    // Once A deselects, the lock is released and B can move it.
    await a.keyboard.press("Escape");
    await b.waitForTimeout(300);
    await drag(b, [600, 380], [700, 480]);
    await expect.poll(() => nodes(a).then((n) => n[0]!.x)).toBe(before.x + 100);
  });

  test("viewers can watch but their edits never reach others", async ({ browser }) => {
    const id = room();
    const editor = await openBoard(browser, id);
    const viewer = await openBoard(browser, id, "viewer");

    await expect(viewer.getByText("View only")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Rectangle" })).toBeDisabled();

    await editor.keyboard.press("r");
    await drag(editor, [400, 300], [600, 400]);
    await expect.poll(() => nodes(viewer).then((n) => n.length)).toBe(1);

    // Bypass the UI and write straight into the viewer's doc: the server must drop it.
    await viewer.evaluate(() => {
      const hook = (window as unknown as { __board: BoardHook }).__board;
      hook.doc.getMap("nodes").set("forged", { type: "rect" });
    });
    await editor.waitForTimeout(500);
    expect((await nodes(editor)).map((n) => n.id)).not.toContain("forged");
  });

  test("board page has no critical/serious accessibility violations", async ({ browser }) => {
    const page = await openBoard(browser, room());
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("stays smooth while panning a 200-node board (TC-NFR-01)", async ({ browser }) => {
    const page = await openBoard(browser, room());
    await page.evaluate(() => {
      const hook = (window as unknown as { __board: { doc: import("yjs").Doc } }).__board;
      const doc = hook.doc;
      const nodesMap = doc.getMap("nodes");
      const order = doc.getArray("order");
      const Ctor = nodesMap.constructor as unknown as new () => { set: (k: string, v: unknown) => void };
      doc.transact(() => {
        for (let i = 0; i < 200; i++) {
          const m = new Ctor();
          const fields: Record<string, unknown> = {
            id: `perf${i}`, type: i % 2 ? "rect" : "ellipse", x: (i % 20) * 60 - 600, y: Math.floor(i / 20) * 60 - 300,
            rotation: 0, scaleX: 1, scaleY: 1, width: 40, height: 40, fill: "#cfe3ff", stroke: "#0090ff",
            strokeWidth: 2, createdBy: "perf", createdAt: 0, updatedAt: 0,
          };
          for (const [k, v] of Object.entries(fields)) m.set(k, v);
          nodesMap.set(`perf${i}`, m);
          order.push([`perf${i}`]);
        }
      });
    });
    await expect(page.getByTestId("node-count")).toHaveText("200 objects");

    const box = (await page.getByTestId("board-canvas").boundingBox())!;
    await page.mouse.move(box.x + 640, box.y + 400);
    const start = Date.now();
    while (Date.now() - start < 2500) {
      await page.mouse.wheel(4, 3);
    }
    const fps = await page.evaluate(() => (window as unknown as { __fps?: number }).__fps ?? 0);
    console.log(`fps while panning 200 nodes: ${fps.toFixed(1)}`);
    expect(fps).toBeGreaterThanOrEqual(55);
  });
});
