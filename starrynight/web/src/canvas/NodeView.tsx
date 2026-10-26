"use client";

import type Konva from "konva";
import { memo } from "react";
import { Arrow, Ellipse, Group, Line, Rect, Text } from "react-konva";
import type { BoardNode } from "@/contracts/board";
import type { LockInfo } from "@/collab/presence";

export interface NodeViewProps {
  node: BoardNode;
  draggable: boolean;
  lock: LockInfo | undefined;
  /** Hide the text while it is being edited in the HTML overlay. */
  hideText: boolean;
  onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>, id: string) => void;
  onDragMove: (e: Konva.KonvaEventObject<DragEvent>, id: string) => void;
  onDragEnd: (e: Konva.KonvaEventObject<DragEvent>, id: string) => void;
  onDblClick: (id: string) => void;
}

/** Renders one board node. Memoised: remote edits re-render only the nodes they touch. */
export const NodeView = memo(function NodeView({
  node,
  draggable,
  lock,
  hideText,
  onPointerDown,
  onDragMove,
  onDragEnd,
  onDblClick,
}: NodeViewProps) {
  const common = {
    id: node.id,
    name: "board-node",
    x: node.x,
    y: node.y,
    rotation: node.rotation,
    scaleX: node.scaleX,
    scaleY: node.scaleY,
    draggable,
    perfectDrawEnabled: false,
    onPointerDown: (e: Konva.KonvaEventObject<PointerEvent>) => onPointerDown(e, node.id),
    onDragMove: (e: Konva.KonvaEventObject<DragEvent>) => onDragMove(e, node.id),
    onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => onDragEnd(e, node.id),
    onDblClick: () => onDblClick(node.id),
    onDblTap: () => onDblClick(node.id),
  };
  const lockStroke = lock ? { shadowColor: lock.user.color, shadowBlur: 8, shadowOpacity: 0.9 } : {};

  switch (node.type) {
    case "stroke":
      return (
        <Line
          {...common}
          {...lockStroke}
          points={node.points}
          stroke={node.color}
          strokeWidth={node.width}
          opacity={node.opacity}
          lineCap="round"
          lineJoin="round"
          tension={0.4}
          hitStrokeWidth={Math.max(12, node.width)}
        />
      );
    case "rect":
      return (
        <Rect
          {...common}
          {...lockStroke}
          width={node.width}
          height={node.height}
          fill={node.fill}
          stroke={node.stroke}
          strokeWidth={node.strokeWidth}
          cornerRadius={4}
        />
      );
    case "ellipse":
      return (
        <Ellipse
          {...common}
          {...lockStroke}
          radiusX={node.width / 2}
          radiusY={node.height / 2}
          fill={node.fill}
          stroke={node.stroke}
          strokeWidth={node.strokeWidth}
        />
      );
    case "arrow":
      return (
        <Arrow
          {...common}
          {...lockStroke}
          points={node.points}
          stroke={node.stroke}
          fill={node.stroke}
          strokeWidth={node.strokeWidth}
          pointerLength={node.strokeWidth * 3 + 6}
          pointerWidth={node.strokeWidth * 3 + 6}
          hitStrokeWidth={Math.max(12, node.strokeWidth)}
        />
      );
    case "sticky":
      return (
        <Group {...common}>
          <Rect
            width={node.width}
            height={node.height}
            fill={node.color}
            cornerRadius={6}
            shadowColor={lock ? lock.user.color : "#000"}
            shadowBlur={lock ? 10 : 6}
            shadowOpacity={lock ? 0.9 : 0.15}
            shadowOffsetY={lock ? 0 : 2}
            perfectDrawEnabled={false}
          />
          {!hideText && (
            <Text
              text={node.text || ""}
              width={node.width}
              height={node.height}
              padding={14}
              fontSize={18}
              lineHeight={1.3}
              fill="#1e1e24"
              wrap="word"
              ellipsis
              listening={false}
            />
          )}
        </Group>
      );
    case "image":
      // Image upload arrives with Supabase Storage (T3.2 remainder); show a placeholder.
      return (
        <Group {...common}>
          <Rect width={node.width} height={node.height} fill="#ececf1" stroke="#a3a3ad" dash={[6, 4]} />
          <Text text="image" width={node.width} height={node.height} align="center" verticalAlign="middle" fill="#5c5c66" />
        </Group>
      );
  }
});
