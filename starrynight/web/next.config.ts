import type { NextConfig } from "next";

const djangoUrl = (process.env.NEXT_PUBLIC_DJANGO_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Django URLs end in "/"; keep them intact instead of redirecting to the slash-less form.
  skipTrailingSlashRedirect: true,
  // Same-origin proxy to Django so the browser never needs CORS for the v2 API or media.
  async rewrites() {
    return [
      // Order matters: the slash-terminated form must win so Django's trailing "/" is preserved.
      { source: "/api/v2/:path*/", destination: `${djangoUrl}/api/v2/:path*/` },
      { source: "/api/v2/:path*", destination: `${djangoUrl}/api/v2/:path*` },
      { source: "/media/:path*", destination: `${djangoUrl}/media/:path*` },
    ];
  },
  async headers() {
    return [
      {
        // ONNX models are content-addressed by style id and large: cache hard.
        source: "/models/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800, immutable" }],
      },
    ];
  },
};

export default nextConfig;
