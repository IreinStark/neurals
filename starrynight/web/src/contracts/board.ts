/**
 * CRDT document + awareness contract (ARCHITECTURE_SPEC §4).
 */
import type { StyleId } from "./styles";

export const BOARD_SCHEMA_VERSION = 1;

export type Role = "owner" | "editor" | "viewer";

export const NODE_TYPES = ["stroke", "rect", "ellipse", "arrow", "sticky", "image"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface BaseNode {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface StrokeNode extends BaseNode {
  type: "stroke";
  /** Flat [x0, y0, x1, y1, ...] relative to (x, y), RDP-simplified. */
  points: number[];
  color: string;
  width: number;
  opacity: number;
}

export interface BoxNode extends BaseNode {
  type: "rect" | "ellipse";
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

export interface ArrowNode extends BaseNode {
  type: "arrow";
  points: [number, number, number, number];
  stroke: string;
  strokeWidth: number;
}

export interface StickyNode extends BaseNode {
  type: "sticky";
  width: number;
  height: number;
  /** Stored as Y.Text in the doc; serialized to string in snapshots. */
  text: string;
  color: string;
}

export interface ImageNode extends BaseNode {
  type: "image";
  width: number;
  height: number;
  src: string;
  assetId: string;
  styleId?: StyleId;
  sourceNodeIds?: string[];
}

export type BoardNode = StrokeNode | BoxNode | ArrowNode | StickyNode | ImageNode;

/** Distributive Omit so each union member keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface BoardMeta {
  schemaVersion: number;
  activeStyleId: StyleId | null;
  styleStrength: number;
}

export interface AwarenessState {
  user: { id: string; name: string; color: string; role: Role };
  cursor: { x: number; y: number } | null;
  selection: string[];
  drawing: { points: number[]; color: string; width: number } | null;
  viewport?: { x: number; y: number; scale: number };
}
