/**
 * Neural Style Studio (designer's UI) — checks that every screen is wired to real
 * functionality. Style inference is real (TransformerNet ONNX in the worker); Django
 * endpoints are mocked here so the suite runs without the Python backend (the full
 * live-Django run is in docs/GP2_SETUP.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIX = join(__dirname, "fixtures");

async function mockDjango(page: Page) {
  let polls = 0;
  await page.route("**/accounts/login/", (r) =>
    r.fulfill({ json: { access: "a.b.c", refresh: "d.e.f" } }),
  );
  await page.route("**/accounts/register/", (r) => r.fulfill({ status: 201, json: { username: "x" } }));
  await page.route("**/accounts/forgot-password/", (r) =>
    r.fulfill({ json: { message: "Reset link generated.", uid: "MQ", token: "tok-123" } }),
  );
  await page.route("**/accounts/reset-password/", async (r) => {
    const body = r.request().postDataJSON() as { uid: string; token: string; password: string };
    expect(body).toMatchObject({ uid: "MQ", token: "tok-123" });
    await r.fulfill({ json: { message: "Password updated." } });
  });
  await page.route("**/style_transfer/webcam-video/", async (r) => {
    expect(r.request().postData()).toContain('name="style"');
    await r.fulfill({ json: { job_id: "job-1", status: "queued", execution_mode: "thread" } });
  });
  await page.route("**/api/v2/adain/video/", async (r) => {
    const body = r.request().postData() ?? "";
    expect(body).toContain('name="style"');
    expect(body).toContain('name="alpha"');
    await r.fulfill({ status: 202, json: { job_id: "job-1", status: "queued", execution_mode: "thread", style: "custom" } });
  });
  await page.route("**/style_transfer/video-status/job-1/", (r) => {
    polls++;
    return r.fulfill({
      json:
        polls < 2
          ? { status: "processing", progress: 50, video_url: null, error: null }
          : { status: "completed", progress: 100, video_url: "/media/output/video-job-1.webm", error: null },
    });
  });
  await page.route("**/media/output/video-job-1.webm", (r) =>
    r.fulfill({ contentType: "video/webm", body: readFileSync(join(FIX, "styled.webm")) }),
  );
}

test.describe("Neural Style Studio", () => {
  test.beforeEach(async ({ page }) => {
    await mockDjango(page);
  });

  test("landing renders and sign-in goes through the accounts API", async ({ page }) => {
    await page.goto("/");
    await page.locator("#cta").click();
    await page.fill("#af input[type=email]", "irein.ogunsan@neu.edu.tr");
    await page.fill("#af input[type=password]", "Starry-Night-2026");
    await page.locator("#sb").click();
    await expect(page).toHaveURL(/#\/image/);
    await expect(page.locator("header a[aria-label=Profile]")).toHaveText("IO");
  });

  test("image transfer runs the real style model in the worker", async ({ page }) => {
    await page.goto("/#/image");
    await expect(page.locator("#tg")).toHaveText(/^Botanical · \d+ ms · (WASM|WEBGPU|WEBGL)$/, { timeout: 90_000 });
    expect(await page.getAttribute("#sImg", "src")).toMatch(/^data:image\/jpeg;base64,/);

    await page.locator("#scards .sc[data-k=wave]").click();
    await expect(page.locator("#tg")).toHaveText(/^Great Wave · \d+ ms/, { timeout: 90_000 });
  });

  test("webcam stylizes the camera feed live", async ({ page }) => {
    await page.goto("/#/webcam");
    await expect(page.locator("#cs")).toHaveText(/Camera active|demo feed/, { timeout: 20_000 });
    await page.locator(".ws[data-k=starry]").click();
    await expect(page.locator("#fpsb")).toHaveText(/^\d+ FPS · (WASM|WEBGPU|WEBGL)$/, { timeout: 90_000 });
    await page.locator("#modeLive").click();
    await expect(page.locator("#latency")).toHaveText(/^\d+ms$/, { timeout: 10_000 });
  });

  test("live stream mode falls back to in-browser styling when the server is unreachable", async ({ page }) => {
    await page.routeWebSocket("**/ws/live/**", (ws) => ws.close({ code: 1011, reason: "down" }));
    await page.goto("/#/webcam");
    await expect(page.locator("#cs")).toHaveText(/Camera active|demo feed/, { timeout: 20_000 });
    await page.locator(".ws[data-k=starry]").click();
    await page.locator("#modeLive").click();
    await expect(page.locator("#tm")).toContainText("styling in your browser instead", { timeout: 15_000 });
    await expect(page.locator("#liveBanner")).toBeVisible();
    await expect(page.locator("#fpsb")).toHaveText(/^\d+ FPS · (WASM|WEBGPU|WEBGL)$/, { timeout: 90_000 });
    await expect(page.locator("#latency")).toHaveText(/^\d+ms$/, { timeout: 10_000 });
  });

  test("video upload submits a backend job, tracks progress and plays the result", async ({ page }) => {
    await page.goto("/#/video-upload");
    await page.setInputFiles("#vuFile", join(FIX, "clip.mp4"));
    await page.locator("#scards .sc[data-k=cyber]").click();
    await page.locator("#vuGo").click();
    await expect(page.locator("#vuStatus")).toHaveText("Complete", { timeout: 30_000 });
    await expect
      .poll(() => page.evaluate(() => document.querySelector<HTMLVideoElement>("#vuResultArea video")?.readyState ?? 0))
      .toBeGreaterThanOrEqual(2);
  });

  test("custom style (AdaIN) applies any uploaded painting in the browser", async ({ page }) => {
    await page.goto("/#/image");
    await page.locator("#tabAdaIN").click();
    await page.locator(".qsp").nth(1).click(); // quick reference: Great Wave
    await expect(page.locator("#tg")).toHaveText(/^Custom style · \d+ ms · (WASM|WEBGPU|WEBGL)$/, { timeout: 120_000 });
    expect(await page.getAttribute("#sImg", "src")).toMatch(/^data:image\/jpeg;base64,/);
  });

  test("video upload can use a custom style image (AdaIN job)", async ({ page }) => {
    await page.goto("/#/video-upload");
    await page.setInputFiles("#vuFile", join(FIX, "clip.mp4"));
    await page.locator("#vuTabCustom").click();
    await page.locator(".vqsp").first().click();
    await page.locator("#vuGo").click();
    await expect(page.locator("#vuStatus")).toHaveText("Complete", { timeout: 30_000 });
    await expect(page.locator("#vuResultStyle")).toHaveText("Custom (AdaIN)");
  });

  test("forgot + reset password use the Django reset flow", async ({ page }) => {
    await page.goto("/#/forgot");
    await page.fill("#fgEmail", "irein@neu.edu.tr");
    await page.locator("#fgForm button[type=submit]").click();
    await expect(page).toHaveURL(/#\/reset/, { timeout: 10_000 });
    await page.fill("#rp1", "Brand-New-Pass-1");
    await page.fill("#rp2", "Brand-New-Pass-1");
    await page.locator("#rsForm button[type=submit]").click();
    await expect(page).toHaveURL(/#\/image/, { timeout: 10_000 });
  });

  test("signed-in gallery comes from the server and shares a public link", async ({ page, browser }) => {
    const work = {
      id: 7, title: "Golden Gate — Starry Night", kind: "image", style: "starry", media_url: "/media/gallery/7/a.jpg",
      poster_url: null, duration: "", likes: 2, views: 5, liked: false, created_at: "2026-10-27T08:00:00Z",
      client_id: "abc", share_token: null, size_bytes: 120000, shared: false, owner: { name: "Irein" },
    };
    const stats = { works: 1, views: 5, favorites: 0, used_bytes: 120000, quota_bytes: 1073741824 };
    await page.addInitScript(() =>
      localStorage.setItem("ns.session", JSON.stringify({ email: "irein@neu.edu.tr", access: "a.b.c", refresh: "d.e.f" })),
    );
    await page.route("**/api/v2/gallery/?*", (r) => r.fulfill({ json: { works: [work], stats } }));
    await page.route("**/api/v2/gallery/", (r) => r.fulfill({ json: { works: [work], stats } }));
    let liked = false;
    await page.route("**/api/v2/gallery/7/like/", (r) => {
      liked = true;
      return r.fulfill({ json: { liked: true, likes: 3 } });
    });
    await page.route("**/api/v2/gallery/7/share/", (r) =>
      r.fulfill({ json: { token: "tok123", url: "x", page_url: "y" } }),
    );
    await page.route("**/media/gallery/7/a.jpg", (r) => r.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));

    await page.goto("/#/gallery");
    await expect(page.locator("#gag article")).toHaveCount(1); // demo works are not shown to signed-in users
    await expect(page.locator("#gag h3")).toHaveText("Golden Gate — Starry Night");
    await expect(page.getByText("117 KB of 1.0 GB used")).toBeVisible();

    await page.locator("#gag .lk").click();
    await expect.poll(() => liked).toBe(true);

    await page.locator("#gag article").hover();
    await page.locator("#gag .ga[data-c=share]").click();
    await expect(page.locator("#shareUrl")).toHaveValue(/\/s\/tok123\/$/);

    const anon = await browser.newPage();
    await anon.route("**/api/v2/share/tok123/", (r) => r.fulfill({ json: { ...work, views: 6 } }));
    await anon.route("**/media/gallery/7/a.jpg", (r) => r.fulfill({ contentType: "image/svg+xml", body: "<svg xmlns='http://www.w3.org/2000/svg'/>" }));
    await anon.goto("/#/share/tok123");
    await expect(anon.locator("main h1")).toHaveText("Golden Gate — Starry Night", { timeout: 10_000 });
    await expect(anon.locator("main .btn-accent.rounded-full").first()).toHaveText("I");
    await anon.close();
  });

  test("a removed share link says so", async ({ page }) => {
    await page.route("**/api/v2/share/gone/", (r) => r.fulfill({ status: 404, json: { detail: "Not found." } }));
    await page.goto("/#/share/gone");
    await expect(page.locator("main h1")).toHaveText("This link is no longer available", { timeout: 10_000 });
  });

  test("saved works persist in the gallery across reloads", async ({ page }) => {
    await page.goto("/#/image");
    await expect(page.locator("#tg")).toHaveText(/ms ·/, { timeout: 90_000 });
    await page.locator("#svBtn").click();
    // Saving renders the full-resolution result first, then confirms with a toast.
    await expect(page.locator("#tm")).toHaveText("Saved to your gallery", { timeout: 90_000 });
    await page.goto("/#/gallery");
    await page.reload();
    await expect(page.locator("#gag h3", { hasText: "Styled Photo — Botanical" })).toBeVisible({ timeout: 10_000 });
  });
});
