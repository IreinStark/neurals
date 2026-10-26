import type { NextConfig } from "next";

const djangoUrl = (process.env.NEXT_PUBLIC_DJANGO_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Django URLs end in "/"; keep them intact instead of redirecting to the slash-less form.
  skipTrailingSlashRedirect: true,
  // Same-origin proxy to Django so the browser never needs CORS for the v2 API or media.
  async rewrites() {
    return [
      // The designer's Neural Style Studio page (built into public/studio by scripts/build-studio.mjs).
      { source: "/", destination: "/studio/index.html" },
      // GP1 Django endpoints used by the Neural Style Studio page (auth, video jobs).
      { source: "/accounts/:path*/", destination: `${djangoUrl}/accounts/:path*/` },
      { source: "/style_transfer/:path*/", destination: `${djangoUrl}/style_transfer/:path*/` },
      // Order matters: the slash-terminated form must win so Django's trailing "/" is preserved.
      { source: "/api/v2/:path*/", destination: `${djangoUrl}/api/v2/:path*/` },
      { source: "/api/v2/:path*", destination: `${djangoUrl}/api/v2/:path*` },
      { source: "/media/:path*", destination: `${djangoUrl}/media/:path*` },
    ];
  },
  async headers() {
    // Cross-origin isolation lets onnxruntime-web use multi-threaded WASM on the studio page.
    // "credentialless" keeps the design's CDN stylesheet/fonts working without CORP headers.
    const isolation = [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
    ];
    return [
      { source: "/", headers: isolation },
      { source: "/studio/:path*", headers: isolation },
      {
        // ONNX models are content-addressed by style id and large: cache hard.
        source: "/models/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800, immutable" }],
      },
    ];
  },
};

export default nextConfig;
