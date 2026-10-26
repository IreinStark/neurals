"use client";

import { useEffect, useRef } from "react";
import type * as Y from "yjs";
import type { StickyNode } from "@/contracts/board";
import { updateNode } from "@/collab/schema";
import { worldToScreen, type Viewport } from "./viewport";

/**
 * HTML textarea overlaid on a sticky note while editing. Each keystroke goes into the
 * note's Y.Text as a minimal diff, so collaborators see typing live and concurrent
 * edits merge.
 */
export function StickyEditor({
  doc,
  node,
  viewport,
  onClose,
}: {
  doc: Y.Doc;
  node: StickyNode;
  viewport: Viewport;
  onClose: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Keep remote edits visible without moving the caret when the text is unchanged.
  useEffect(() => {
    const el = ref.current;
    if (el && el.value !== node.text) {
      const { selectionStart, selectionEnd } = el;
      el.value = node.text;
      el.setSelectionRange(selectionStart, selectionEnd);
    }
  }, [node.text]);

  const topLeft = worldToScreen(viewport, { x: node.x, y: node.y });
  const scale = viewport.scale * (node.scaleX ?? 1);

  return (
    <textarea
      ref={ref}
      aria-label="Sticky note text"
      defaultValue={node.text}
      onChange={(e) => updateNode(doc, node.id, { text: e.target.value })}
      onBlur={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        e.stopPropagation();
      }}
      className="absolute resize-none border-none bg-transparent outline-none"
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width: node.width,
        height: node.height,
        transform: `scale(${scale}) rotate(${node.rotation}deg)`,
        transformOrigin: "top left",
        padding: 14,
        fontSize: 18,
        lineHeight: 1.3,
        color: "#1e1e24",
        fontFamily: "Arial, sans-serif",
      }}
    />
  );
}
