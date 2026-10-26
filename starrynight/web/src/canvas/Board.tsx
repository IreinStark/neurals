"use client";

/**
 * The collaborative whiteboard (T3.1 viewport, T3.2 tools, T3.3 presence).
 *
 * Coordinate spaces: pointer events arrive in screen space and are converted to world
 * space with the viewport transform; everything stored in Yjs is world space.
 */
import type Konva from "konva";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Arrow, Ellipse, Group, Layer, Line, Rect, Shape, Stage, Text, Transformer } from "react-konva";
import type { BoardNode, Role } from "@/contracts/board";
import { canEdit, computeLocks, lockedForMe, remotePeers } from "@/collab/presence";
import { addNode, deleteNodes, getNodes, listNodes, updateNode } from "@/collab/schema";
import { useBoard } from "@/collab/useBoard";
import { NodeView } from "./NodeView";
import { simplifyFlatPoints } from "./simplify";
import { SpatialGrid } from "./spatial";
import { StickyEditor } from "./StickyEditor";
import { TOOL_SHORTCUTS, useCanvasStore } from "./store";
import { Toolbar } from "./Toolbar";
import {
  fitRect,
  normalizeRect,
  panBy,
  screenToWorld,
  visibleWorldRect,
  wheelZoomFactor,
  zoomAt,
  type Point,
  type Rect as WorldRect,
} from "./viewport";

const PRESENCE_INTERVAL_MS = 33; // ~30 Hz cursor / live-stroke broadcast
const GRID_SPACING = 32;

type Draft =
  | { kind: "pen"; points: number[] }
  | { kind: "rect" | "ellipse" | "arrow"; start: Point; end: Point }
  | { kind: "marquee"; start: Point; end: Point; additive: boolean }
  | { kind: "pan"; last: Point }
  | null;

function useThrottle<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(fn);
  latest.current = fn;
  return useCallback(
    (...args: T) => {
      const now = performance.now();
      if (pending.current) clearTimeout(pending.current);
      if (now - last.current >= ms) {
        last.current = now;
        latest.current(...args);
      } else {
        // trailing call so the final position is always sent
        pending.current = setTimeout(() => {
          last.current = performance.now();
          latest.current(...args);
        }, ms - (now - last.current));
      }
    },
    [ms],
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export interface BoardProps {
  roomId: string;
  role: Role;
  debug?: boolean;
}

export default function Board({ roomId, role, debug = false }: BoardProps) {
  const board = useBoard(roomId, role);
  const editable = canEdit(role);

  const tool = useCanvasStore((s) => s.tool);
  const color = useCanvasStore((s) => s.color);
  const strokeWidth = useCanvasStore((s) => s.strokeWidth);
  const stickyColor = useCanvasStore((s) => s.stickyColor);
  const viewport = useCanvasStore((s) => s.viewport);
  const selection = useCanvasStore((s) => s.selection);
  const editingStickyId = useCanvasStore((s) => s.editingStickyId);
  const { setTool, setViewport, setSelection, setEditingSticky } = useCanvasStore.getState();

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft>(null);
  const draftRef = useRef<Draft>(null);
  draftRef.current = draft;
  const [spaceDown, setSpaceDown] = useState(false);

  // ---------------------------------------------------------------- layout ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Centre the world origin on first layout.
  const centred = useRef(false);
  useEffect(() => {
    if (centred.current || size.width === 0) return;
    centred.current = true;
    setViewport({ x: size.width / 2, y: size.height / 2, scale: 1 });
  }, [size, setViewport]);

  // ------------------------------------------------------- spatial / culling ---
  const grid = useMemo(() => new SpatialGrid(), []);
  const nodesById = useMemo(() => {
    grid.reset(board.nodes);
    return new Map(board.nodes.map((n) => [n.id, n]));
  }, [board.nodes, grid]);

  const visibleNodes = useMemo(() => {
    if (size.width === 0) return [];
    const ids = grid.query(visibleWorldRect(viewport, size.width, size.height, 200));
    return board.nodes.filter((n) => ids.has(n.id) || selection.includes(n.id));
  }, [board.nodes, grid, viewport, size, selection]);

  // ----------------------------------------------------------- presence/locks ---
  const locks = useMemo(
    () => lockedForMe(computeLocks(board.awareness), board.selfClientId),
    [board.awareness, board.selfClientId],
  );
  const peers = useMemo(() => remotePeers(board.awareness, board.selfClientId), [board.awareness, board.selfClientId]);

  // Drop selected ids that were deleted remotely or got locked by someone else. Check the doc
  // itself, not `nodes`: React state lags one frame behind a node we have just created.
  useEffect(() => {
    const live = getNodes(board.doc);
    const kept = selection.filter((id) => live.has(id) && !locks.has(id));
    if (kept.length !== selection.length) setSelection(kept);
  }, [board.doc, board.nodes, locks, selection, setSelection]);

  // Mirror selection into awareness. Viewers never broadcast a selection, so they can't lock nodes.
  useEffect(() => {
    board.setPresence({ selection: editable ? selection : [] });
  }, [selection, editable, board]);

  const sendCursor = useThrottle((p: Point | null) => board.setPresence({ cursor: p }), PRESENCE_INTERVAL_MS);
  const sendDrawing = useThrottle(
    (points: number[] | null) =>
      board.setPresence({ drawing: points ? { points, color, width: strokeWidth } : null }),
    PRESENCE_INTERVAL_MS,
  );

  // -------------------------------------------------------------- transformer ---
  useEffect(() => {
    const tr = transformerRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const targets =
      tool === "select" && editable
        ? selection
            .map((id) => stage.findOne(`#${CSS.escape(id)}`))
            .filter((n): n is Konva.Node => !!n && !locks.has(n.id()))
        : [];
    tr.nodes(targets);
    tr.getLayer()?.batchDraw();
  }, [selection, tool, editable, locks, visibleNodes]);

  // ------------------------------------------------------------------ helpers ---
  const pointerWorld = useCallback((): Point | null => {
    const p = stageRef.current?.getPointerPosition();
    return p ? screenToWorld(useCanvasStore.getState().viewport, p) : null;
  }, []);

  const pointerScreen = useCallback((): Point | null => stageRef.current?.getPointerPosition() ?? null, []);

  const commitPositions = useCallback(
    (ids: string[]) => {
      const stage = stageRef.current;
      if (!stage) return;
      board.doc.transact(() => {
        for (const id of ids) {
          const k = stage.findOne(`#${CSS.escape(id)}`);
          if (k) updateNode(board.doc, id, { x: k.x(), y: k.y() });
        }
      }, "local");
    },
    [board.doc],
  );

  const liveMove = useThrottle((ids: string[]) => commitPositions(ids), PRESENCE_INTERVAL_MS);

  const zoomBy = useCallback(
    (factor: number) => setViewport((v) => zoomAt(v, { x: size.width / 2, y: size.height / 2 }, factor)),
    [setViewport, size],
  );

  const zoomToFit = useCallback(() => {
    const bounds = grid.totalBounds();
    if (bounds) setViewport(fitRect(bounds, size.width, size.height));
    else setViewport({ x: size.width / 2, y: size.height / 2, scale: 1 });
  }, [grid, setViewport, size]);

  const deleteSelection = useCallback(() => {
    if (!editable) return;
    const ids = useCanvasStore.getState().selection.filter((id) => !locks.has(id));
    if (ids.length === 0) return;
    deleteNodes(board.doc, ids);
    setSelection([]);
  }, [board.doc, editable, locks, setSelection]);

  // ----------------------------------------------------------------- keyboard ---
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceDown(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!editable) return;
        if (e.shiftKey) board.redo();
        else board.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        if (editable) board.redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (editable) setSelection(listNodes(board.doc).map((n) => n.id).filter((id) => !locks.has(id)));
        return;
      }
      if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomBy(1.2);
        return;
      }
      if (mod && e.key === "-") {
        e.preventDefault();
        zoomBy(1 / 1.2);
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        zoomToFit();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (e.key === "Escape") {
        setSelection([]);
        setTool("select");
        return;
      }
      if (!mod && !e.altKey) {
        const t = TOOL_SHORTCUTS[e.key.toLowerCase()];
        if (t && (editable || t === "select" || t === "pan")) setTool(t);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [board, editable, locks, deleteSelection, setSelection, setTool, zoomBy, zoomToFit]);

  // ---------------------------------------------------------- pointer handling ---
  const panning = spaceDown || tool === "pan";

  const onStagePointerDown = (e: Konva.KonvaEventObject<PointerEvent>) => {
    const screen = pointerScreen();
    const world = pointerWorld();
    if (!screen || !world) return;
    const onEmpty = e.target === e.target.getStage();

    if (e.evt.button === 1 || panning) {
      setDraft({ kind: "pan", last: screen });
      return;
    }
    if (e.evt.button !== 0) return;

    if (!editable || tool === "select") {
      if (onEmpty) {
        if (editable) setDraft({ kind: "marquee", start: world, end: world, additive: e.evt.shiftKey });
        if (!e.evt.shiftKey) setSelection([]);
      }
      return;
    }

    switch (tool) {
      case "pen":
        setDraft({ kind: "pen", points: [world.x, world.y] });
        return;
      case "rect":
      case "ellipse":
      case "arrow":
        setDraft({ kind: tool, start: world, end: world });
        return;
      case "sticky": {
        const id = addNode(board.doc, {
          type: "sticky",
          x: world.x - 100,
          y: world.y - 100,
          width: 200,
          height: 200,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          text: "",
          color: stickyColor,
          createdBy: board.identity.id,
        });
        setTool("select");
        setSelection([id]);
        setEditingSticky(id);
        return;
      }
    }
  };

  const onStagePointerMove = () => {
    const screen = pointerScreen();
    const world = pointerWorld();
    if (!screen || !world) return;
    sendCursor(world);

    const d = draftRef.current;
    if (!d) return;
    switch (d.kind) {
      case "pan":
        setViewport((v) => panBy(v, screen.x - d.last.x, screen.y - d.last.y));
        setDraft({ kind: "pan", last: screen });
        return;
      case "pen": {
        const pts = d.points;
        const lx = pts[pts.length - 2]!;
        const ly = pts[pts.length - 1]!;
        // skip sub-pixel jitter (in screen space)
        if (Math.hypot(world.x - lx, world.y - ly) * viewport.scale < 1.5) return;
        const next = [...pts, world.x, world.y];
        setDraft({ kind: "pen", points: next });
        sendDrawing(next);
        return;
      }
      default:
        setDraft({ ...d, end: world });
    }
  };

  const onStagePointerUp = () => {
    const d = draftRef.current;
    setDraft(null);
    if (!d) return;

    if (d.kind === "pen") {
      sendDrawing(null);
      const pts = d.points.length === 2 ? [...d.points, d.points[0]! + 0.1, d.points[1]!] : d.points;
      const simplified = simplifyFlatPoints(pts, 1 / viewport.scale);
      const ox = simplified[0]!;
      const oy = simplified[1]!;
      addNode(board.doc, {
        type: "stroke",
        x: ox,
        y: oy,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        points: simplified.map((v, i) => (i % 2 === 0 ? v - ox : v - oy)),
        color,
        width: strokeWidth,
        opacity: 1,
        createdBy: board.identity.id,
      });
      return;
    }

    if (d.kind === "marquee") {
      const r = normalizeRect({ x: d.start.x, y: d.start.y, width: d.end.x - d.start.x, height: d.end.y - d.start.y });
      if (r.width * viewport.scale < 3 && r.height * viewport.scale < 3) return;
      const hits = [...grid.queryContained(r)].filter((id) => !locks.has(id));
      const current = useCanvasStore.getState().selection;
      setSelection(d.additive ? [...new Set([...current, ...hits])] : hits);
      return;
    }

    if (d.kind === "rect" || d.kind === "ellipse" || d.kind === "arrow") {
      const minSize = 4 / viewport.scale;
      const dx = d.end.x - d.start.x;
      const dy = d.end.y - d.start.y;
      if (Math.abs(dx) < minSize && Math.abs(dy) < minSize) return;
      const common = { rotation: 0, scaleX: 1, scaleY: 1, createdBy: board.identity.id };
      let id: string;
      if (d.kind === "arrow") {
        id = addNode(board.doc, {
          ...common,
          type: "arrow",
          x: d.start.x,
          y: d.start.y,
          points: [0, 0, dx, dy],
          stroke: color,
          strokeWidth,
        });
      } else {
        const r = normalizeRect({ x: d.start.x, y: d.start.y, width: dx, height: dy });
        id = addNode(board.doc, {
          ...common,
          type: d.kind,
          // ellipses are centre-anchored in Konva
          x: d.kind === "ellipse" ? r.x + r.width / 2 : r.x,
          y: d.kind === "ellipse" ? r.y + r.height / 2 : r.y,
          width: r.width,
          height: r.height,
          fill: "transparent",
          stroke: color,
          strokeWidth,
        });
      }
      setTool("select");
      setSelection([id]);
    }
  };

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const p = pointerScreen();
    if (!p) return;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // pinch-zoom on trackpads arrives as ctrl+wheel
      setViewport((v) => zoomAt(v, p, wheelZoomFactor(e.evt.deltaY)));
    } else {
      setViewport((v) => panBy(v, -e.evt.deltaX, -e.evt.deltaY));
    }
  };

  // -------------------------------------------------------- node interactions ---
  const onNodePointerDown = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>, id: string) => {
      const { tool: t, selection: sel } = useCanvasStore.getState();
      if (t !== "select" || e.evt.button !== 0 || spaceDown) return;
      e.cancelBubble = true;
      if (!editable || locks.has(id)) return;
      if (e.evt.shiftKey) {
        setSelection(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
      } else if (!sel.includes(id)) {
        setSelection([id]);
      }
    },
    [editable, locks, setSelection, spaceDown],
  );

  const onNodeDragMove = useCallback(
    (_e: Konva.KonvaEventObject<DragEvent>, id: string) => {
      const sel = useCanvasStore.getState().selection;
      liveMove(sel.includes(id) ? sel : [id]);
    },
    [liveMove],
  );

  const onNodeDragEnd = useCallback(
    (_e: Konva.KonvaEventObject<DragEvent>, id: string) => {
      const sel = useCanvasStore.getState().selection;
      commitPositions(sel.includes(id) ? sel : [id]);
    },
    [commitPositions],
  );

  const onNodeDblClick = useCallback(
    (id: string) => {
      const n = nodesById.get(id);
      if (n?.type === "sticky" && editable && !locks.has(id)) {
        setSelection([id]);
        setEditingSticky(id);
      }
    },
    [nodesById, editable, locks, setSelection, setEditingSticky],
  );

  const onTransformEnd = useCallback(() => {
    const tr = transformerRef.current;
    if (!tr) return;
    board.doc.transact(() => {
      for (const k of tr.nodes()) {
        const node = nodesById.get(k.id());
        if (!node) continue;
        const sx = k.scaleX();
        const sy = k.scaleY();
        const base = { x: k.x(), y: k.y(), rotation: k.rotation() };
        if (node.type === "stroke" || node.type === "arrow") {
          updateNode(board.doc, node.id, { ...base, scaleX: sx, scaleY: sy });
        } else {
          // Bake scale into width/height so text and stroke widths stay crisp.
          k.scaleX(1);
          k.scaleY(1);
          updateNode(board.doc, node.id, {
            ...base,
            width: Math.max(8, node.width * sx),
            height: Math.max(8, node.height * sy),
            scaleX: 1,
            scaleY: 1,
          });
        }
      }
    }, "local");
  }, [board.doc, nodesById]);

  // ------------------------------------------------------------- debug hook ---
  useEffect(() => {
    if (!debug) return;
    const w = window as unknown as Record<string, unknown>;
    w.__board = {
      doc: board.doc,
      nodes: () => listNodes(board.doc),
      viewport: () => useCanvasStore.getState().viewport,
      peers: () => peers,
      locks: () => [...locks.keys()],
      awareness: () => [...board.awareness.entries()],
    };
  }, [debug, board.doc, board.awareness, peers, locks]);

  // ------------------------------------------------------------------ render ---
  const cursor = panning ? (draft?.kind === "pan" ? "grabbing" : "grab") : tool === "select" ? "default" : "crosshair";
  const s = viewport.scale;

  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <Toolbar
        board={board}
        editable={editable}
        peers={peers}
        nodeCount={board.nodes.length}
        onZoomIn={() => zoomBy(1.2)}
        onZoomOut={() => zoomBy(1 / 1.2)}
        onZoomFit={zoomToFit}
        onDelete={deleteSelection}
        roomId={roomId}
        debug={debug}
      />
      <div ref={containerRef} className="absolute inset-0" style={{ cursor }} data-testid="board-canvas">
        {size.width > 0 && (
          <Stage
            ref={stageRef}
            width={size.width}
            height={size.height}
            x={viewport.x}
            y={viewport.y}
            scaleX={s}
            scaleY={s}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerLeave={() => sendCursor(null)}
            onWheel={onWheel}
          >
            {/* Dot grid: drawn only for the visible area, spacing adapts to zoom. */}
            <Layer listening={false}>
              <Shape
                sceneFunc={(ctx) => {
                  let spacing = GRID_SPACING;
                  while (spacing * s < 14) spacing *= 2;
                  const r = visibleWorldRect(viewport, size.width, size.height);
                  const x0 = Math.floor(r.x / spacing) * spacing;
                  const y0 = Math.floor(r.y / spacing) * spacing;
                  const dot = 1.2 / s;
                  ctx.fillStyle = "rgba(120,120,135,0.35)";
                  for (let x = x0; x <= r.x + r.width; x += spacing) {
                    for (let y = y0; y <= r.y + r.height; y += spacing) ctx.fillRect(x - dot, y - dot, dot * 2, dot * 2);
                  }
                }}
              />
            </Layer>

            <Layer>
              {visibleNodes.map((n: BoardNode) => (
                <NodeView
                  key={n.id}
                  node={n}
                  draggable={editable && tool === "select" && !spaceDown && !locks.has(n.id)}
                  lock={locks.get(n.id)}
                  hideText={editingStickyId === n.id}
                  onPointerDown={onNodePointerDown}
                  onDragMove={onNodeDragMove}
                  onDragEnd={onNodeDragEnd}
                  onDblClick={onNodeDblClick}
                />
              ))}
              <Transformer
                ref={transformerRef}
                rotateEnabled
                flipEnabled={false}
                ignoreStroke
                anchorSize={8}
                borderStroke="#2f4cdd"
                anchorStroke="#2f4cdd"
                onTransformEnd={onTransformEnd}
                boundBoxFunc={(oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox)}
              />
            </Layer>

            {/* Drafts, lock labels, remote live strokes and cursors */}
            <Layer listening={false}>
              {draft?.kind === "pen" && (
                <Line points={draft.points} stroke={color} strokeWidth={strokeWidth} lineCap="round" lineJoin="round" tension={0.4} />
              )}
              {(draft?.kind === "rect" || draft?.kind === "ellipse") &&
                (() => {
                  const r = normalizeRect({
                    x: draft.start.x,
                    y: draft.start.y,
                    width: draft.end.x - draft.start.x,
                    height: draft.end.y - draft.start.y,
                  });
                  return draft.kind === "rect" ? (
                    <Rect {...r} stroke={color} strokeWidth={strokeWidth} cornerRadius={4} />
                  ) : (
                    <Ellipse
                      x={r.x + r.width / 2}
                      y={r.y + r.height / 2}
                      radiusX={r.width / 2}
                      radiusY={r.height / 2}
                      stroke={color}
                      strokeWidth={strokeWidth}
                    />
                  );
                })()}
              {draft?.kind === "arrow" && (
                <Arrow
                  points={[draft.start.x, draft.start.y, draft.end.x, draft.end.y]}
                  stroke={color}
                  fill={color}
                  strokeWidth={strokeWidth}
                  pointerLength={strokeWidth * 3 + 6}
                  pointerWidth={strokeWidth * 3 + 6}
                />
              )}
              {draft?.kind === "marquee" && (
                <Rect
                  {...normalizeRect({
                    x: draft.start.x,
                    y: draft.start.y,
                    width: draft.end.x - draft.start.x,
                    height: draft.end.y - draft.start.y,
                  })}
                  fill="rgba(47,76,221,0.08)"
                  stroke="#2f4cdd"
                  strokeWidth={1}
                  strokeScaleEnabled={false}
                />
              )}

              {[...locks].map(([id, info]) => {
                const b: WorldRect | undefined = grid.boundsOf(id);
                if (!b) return null;
                return (
                  <Group key={`lock-${id}`} x={b.x} y={b.y} scaleX={1 / s} scaleY={1 / s}>
                    <Rect y={-22} width={info.user.name.length * 7 + 14} height={18} fill={info.user.color} cornerRadius={4} />
                    <Text y={-19} x={7} text={info.user.name} fontSize={12} fill="#fff" />
                  </Group>
                );
              })}

              {peers.map((p) =>
                p.drawing ? (
                  <Line
                    key={`draw-${p.clientId}`}
                    points={p.drawing.points}
                    stroke={p.drawing.color}
                    strokeWidth={p.drawing.width}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.4}
                    opacity={0.8}
                  />
                ) : null,
              )}

              {peers.map((p) =>
                p.cursor ? (
                  <Group key={`cur-${p.clientId}`} x={p.cursor.x} y={p.cursor.y} scaleX={1 / s} scaleY={1 / s}>
                    <Line points={[0, 0, 0, 16, 4.5, 12, 11, 11]} closed fill={p.user.color} stroke="#fff" strokeWidth={1.5} />
                    <Rect x={12} y={14} width={p.user.name.length * 7 + 14} height={20} fill={p.user.color} cornerRadius={4} />
                    <Text x={19} y={18} text={p.user.name} fontSize={12} fill="#fff" />
                  </Group>
                ) : null,
              )}
            </Layer>
          </Stage>
        )}
      </div>

      {editingStickyId && nodesById.get(editingStickyId)?.type === "sticky" && (
        <StickyEditor
          doc={board.doc}
          node={nodesById.get(editingStickyId) as Extract<BoardNode, { type: "sticky" }>}
          viewport={viewport}
          onClose={() => setEditingSticky(null)}
        />
      )}
    </div>
  );
}
