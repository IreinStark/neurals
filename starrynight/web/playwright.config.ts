import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Webcam tests: a synthetic camera, auto-granted.
        permissions: ["camera"],
        // Optional: point at an already-installed Chromium instead of `npx playwright install`.
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
          // Optional: point at an already-installed Chromium instead of `npx playwright install`.
          ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
        },
      },
    },
  ],
  webServer: [
    {
      command: `npm run start -- -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Board sync server (dev auth). Needs `npm install` in ../party once.
      command: "npm run dev",
      cwd: "../party",
      url: "http://127.0.0.1:1999/parties/main/healthcheck",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
