import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("home page renders and has no critical/serious a11y violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("StarryNight Board");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
});

test("ONNX model assets are served", async ({ request }) => {
  const res = await request.head("/models/starry-night.onnx");
  expect(res.status()).toBe(200);
});
