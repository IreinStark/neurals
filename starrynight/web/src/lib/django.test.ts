import { describe, expect, it, vi } from "vitest";
import { ApiError, createDjangoClient } from "./django";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("createDjangoClient", () => {
  it("sends the bearer token and parses JSON", async () => {
    const fetchImpl = vi.fn(async () => json(200, { status: "ok", service: "starrynight-backend", api: "v2" }));
    const client = createDjangoClient({ baseUrl: "http://api.test/", getAccessToken: () => "tok", fetchImpl });
    await expect(client.health()).resolves.toMatchObject({ status: "ok" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.test/api/v2/health/");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
  });

  it("maps the v2 error envelope to ApiError", async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: { code: "invalid_style", message: "Unknown style" } }));
    const client = createDjangoClient({ fetchImpl });
    const err = await client.getVideoJob("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_style", message: "Unknown style" });
  });

  it("builds multipart video job requests", async () => {
    const fetchImpl = vi.fn(async () => json(202, { job_id: "j1", status: "queued", execution_mode: "thread" }));
    const client = createDjangoClient({ fetchImpl });
    await client.createVideoJob({ video: new Blob(["x"]), styleId: "mosaic", mode: "per-frame" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;
    expect(form.get("style_id")).toBe("mosaic");
    expect(form.get("mode")).toBe("per-frame");
  });
});
