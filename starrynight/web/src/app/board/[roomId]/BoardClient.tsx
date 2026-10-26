"use client";

import dynamic from "next/dynamic";
import type { Role } from "@/contracts/board";

// Konva needs `window`, so the board renders only in the browser.
const Board = dynamic(() => import("@/canvas/Board"), {
  ssr: false,
  loading: () => <p className="p-6 text-muted">Loading board…</p>,
});

export function BoardClient(props: { roomId: string; role: Role; debug: boolean }) {
  return <Board {...props} />;
}
