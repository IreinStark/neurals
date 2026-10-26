/**
 * Local (per-user, non-shared) canvas UI state. Shared board content lives in Yjs;
 * this store only holds what one user is doing: tool, style, viewport, selection.
 */
import { create } from "zustand";
import { IDENTITY, type Viewport } from "./viewport";

export const TOOLS = ["select", "pan", "pen", "rect", "ellipse", "arrow", "sticky"] as const;
export type Tool = (typeof TOOLS)[number];

export const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: "select",
  h: "pan",
  p: "pen",
  r: "rect",
  o: "ellipse",
  a: "arrow",
  n: "sticky",
};

export const PALETTE = ["#1e1e24", "#e5484d", "#f76b15", "#ffc53d", "#46a758", "#0090ff", "#6e56cf", "#ffffff"] as const;
export const STICKY_COLORS = ["#fff3a3", "#ffd6e0", "#c9f2d3", "#cfe3ff", "#e6dcff"] as const;
export const STROKE_WIDTHS = [2, 4, 8, 16] as const;

interface CanvasState {
  tool: Tool;
  color: string;
  strokeWidth: number;
  stickyColor: string;
  viewport: Viewport;
  selection: string[];
  editingStickyId: string | null;
  setTool: (tool: Tool) => void;
  setColor: (color: string) => void;
  setStrokeWidth: (w: number) => void;
  setStickyColor: (c: string) => void;
  setViewport: (v: Viewport | ((prev: Viewport) => Viewport)) => void;
  setSelection: (ids: string[]) => void;
  setEditingSticky: (id: string | null) => void;
}

export const useCanvasStore = create<CanvasState>((set) => ({
  tool: "select",
  color: PALETTE[0],
  strokeWidth: 4,
  stickyColor: STICKY_COLORS[0],
  viewport: IDENTITY,
  selection: [],
  editingStickyId: null,
  setTool: (tool) => set({ tool, editingStickyId: null }),
  setColor: (color) => set({ color }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),
  setStickyColor: (stickyColor) => set({ stickyColor }),
  setViewport: (v) => set((s) => ({ viewport: typeof v === "function" ? v(s.viewport) : v })),
  setSelection: (selection) =>
    set((s) =>
      s.selection.length === selection.length && s.selection.every((id, i) => id === selection[i]) ? s : { selection },
    ),
  setEditingSticky: (editingStickyId) => set({ editingStickyId }),
}));
