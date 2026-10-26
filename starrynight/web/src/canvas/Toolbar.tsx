"use client";

/**
 * Functional toolbar (plain styling on purpose — the visual redesign comes later).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { BoardConnection } from "@/collab/useBoard";
import type { Peer } from "@/collab/presence";
import { PALETTE, STICKY_COLORS, STROKE_WIDTHS, useCanvasStore, type Tool } from "./store";

const TOOL_BUTTONS: { tool: Tool; label: string; key: string; editOnly: boolean }[] = [
  { tool: "select", label: "Select", key: "V", editOnly: false },
  { tool: "pan", label: "Pan", key: "H", editOnly: false },
  { tool: "pen", label: "Pen", key: "P", editOnly: true },
  { tool: "rect", label: "Rectangle", key: "R", editOnly: true },
  { tool: "ellipse", label: "Ellipse", key: "O", editOnly: true },
  { tool: "arrow", label: "Arrow", key: "A", editOnly: true },
  { tool: "sticky", label: "Sticky note", key: "N", editOnly: true },
];

const btnBase =
  "rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent";
const btn = `${btnBase} border-border bg-surface hover:bg-background`;
/** Button classes for toggle buttons (only one background class at a time). */
const toggle = (active: boolean) =>
  active ? `${btnBase} border-accent bg-accent text-white` : `${btnBase} border-border bg-surface hover:bg-background`;

function useFps(enabled: boolean): number | null {
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        const value = (frames * 1000) / (t - last);
        setFps(Math.round(value));
        (window as unknown as { __fps?: number }).__fps = value;
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
  return fps;
}

export interface ToolbarProps {
  board: BoardConnection;
  editable: boolean;
  peers: Peer[];
  nodeCount: number;
  roomId: string;
  debug: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomFit: () => void;
  onDelete: () => void;
}

export function Toolbar({ board, editable, peers, nodeCount, roomId, debug, onZoomIn, onZoomOut, onZoomFit, onDelete }: ToolbarProps) {
  const tool = useCanvasStore((s) => s.tool);
  const color = useCanvasStore((s) => s.color);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const stickyColor = useCanvasStore((s) => s.stickyColor);
  const scale = useCanvasStore((s) => s.viewport.scale);
  const selectionCount = useCanvasStore((s) => s.selection.length);
  const { setTool, setColor, setStrokeWidth, setStickyColor } = useCanvasStore.getState();
  const [copied, setCopied] = useState<string | null>(null);
  const fps = useFps(debug);

  const copyLink = async (role: "editor" | "viewer") => {
    const url = new URL(window.location.href);
    url.search = role === "viewer" ? "?role=viewer" : "";
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(role);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      window.prompt("Copy this link", url.toString());
    }
  };

  const statusLabel =
    board.status === "connected"
      ? "Live"
      : board.failedAttempts > 2
        ? "Can't reach sync server"
        : board.status === "connecting"
          ? "Connecting…"
          : "Offline — reconnecting";

  return (
    <>
      {/* Top bar: room, status, people, share */}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-wrap items-center justify-between gap-2 p-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-sm">
          <Link href="/" className="font-semibold">
            StarryNight Board
          </Link>
          <span className="text-muted" title={roomId}>
            · {roomId.slice(0, 8)}
          </span>
          <span
            role="status"
            className={board.status === "connected" ? "text-ok" : "text-warn"}
            data-testid="connection-status"
          >
            ● {statusLabel}
          </span>
          {!editable && <span className="rounded bg-background px-1.5 py-0.5 text-xs text-muted">View only</span>}
        </div>

        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm shadow-sm">
          <ul className="flex -space-x-1" aria-label="People in this board">
            <li
              title={`${board.identity.name} (you)`}
              className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface text-xs font-semibold text-white"
              style={{ background: board.identity.color }}
            >
              {board.identity.name[0]}
            </li>
            {peers.map((p) => (
              <li
                key={p.clientId}
                title={`${p.user.name}${p.user.role === "viewer" ? " (viewer)" : ""}`}
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-surface text-xs font-semibold text-white"
                style={{ background: p.user.color }}
              >
                {p.user.name[0]}
              </li>
            ))}
          </ul>
          <span className="text-muted" data-testid="peer-count">
            {peers.length + 1} here
          </span>
          <button type="button" className={btn} onClick={() => copyLink("editor")}>
            {copied === "editor" ? "Copied!" : "Copy edit link"}
          </button>
          <button type="button" className={btn} onClick={() => copyLink("viewer")}>
            {copied === "viewer" ? "Copied!" : "Copy view link"}
          </button>
        </div>
      </header>

      {/* Left: tools + style */}
      <nav
        aria-label="Tools"
        className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-lg border border-border bg-surface p-2 shadow-sm"
      >
        {TOOL_BUTTONS.map((t) => (
          <button
            key={t.tool}
            type="button"
            aria-pressed={tool === t.tool}
            aria-keyshortcuts={t.key}
            title={`${t.label} (${t.key})`}
            disabled={t.editOnly && !editable}
            className={`${toggle(tool === t.tool)} text-left`}
            onClick={() => setTool(t.tool)}
          >
            {t.label}
          </button>
        ))}

        {editable && (
          <>
            <hr className="my-1 border-border" />
            <fieldset className="grid grid-cols-4 gap-1">
              <legend className="mb-1 text-xs text-muted">Colour</legend>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Colour ${c}`}
                  aria-pressed={color === c}
                  className={`h-6 w-6 rounded-full border ${color === c ? "ring-2 ring-accent ring-offset-1" : "border-border"}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </fieldset>
            <fieldset className="grid grid-cols-4 gap-1">
              <legend className="mb-1 text-xs text-muted">Width</legend>
              {STROKE_WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-label={`Stroke width ${w}`}
                  aria-pressed={strokeWidth === w}
                  className={`${toggle(strokeWidth === w)} px-0`}
                  onClick={() => setStrokeWidth(w)}
                >
                  {w}
                </button>
              ))}
            </fieldset>
            <fieldset className="grid grid-cols-5 gap-1">
              <legend className="mb-1 text-xs text-muted">Sticky</legend>
              {STICKY_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Sticky colour ${c}`}
                  aria-pressed={stickyColor === c}
                  className={`h-5 w-5 rounded border ${stickyColor === c ? "ring-2 ring-accent ring-offset-1" : "border-border"}`}
                  style={{ background: c }}
                  onClick={() => setStickyColor(c)}
                />
              ))}
            </fieldset>
            <hr className="my-1 border-border" />
            <button type="button" className={btn} onClick={board.undo} title="Undo (⌘Z)">
              Undo
            </button>
            <button type="button" className={btn} onClick={board.redo} title="Redo (⇧⌘Z)">
              Redo
            </button>
            <button type="button" className={btn} onClick={onDelete} disabled={selectionCount === 0} title="Delete (⌫)">
              Delete
            </button>
          </>
        )}
      </nav>

      {/* Bottom-right: zoom */}
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-lg border border-border bg-surface p-2 text-sm shadow-sm">
        <button type="button" className={btn} onClick={onZoomOut} aria-label="Zoom out">
          −
        </button>
        <span className="w-14 text-center tabular-nums" data-testid="zoom-level">
          {Math.round(scale * 100)}%
        </span>
        <button type="button" className={btn} onClick={onZoomIn} aria-label="Zoom in">
          +
        </button>
        <button type="button" className={btn} onClick={onZoomFit}>
          Fit
        </button>
      </div>

      {/* Bottom-left: counts (+ FPS in debug mode) */}
      <div className="absolute bottom-3 left-3 z-10 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-muted shadow-sm">
        <span data-testid="node-count">{nodeCount} objects</span>
        {selectionCount > 0 && <span> · {selectionCount} selected</span>}
        {debug && fps !== null && <span data-testid="fps"> · {fps} fps</span>}
      </div>
    </>
  );
}
