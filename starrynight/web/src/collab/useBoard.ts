"use client";

/**
 * Connects a room's Y.Doc to the PartyKit sync server and exposes React-friendly state
 * (T2.3 client side + T3.3). Doc and awareness changes are batched to one React update
 * per animation frame so rapid remote edits can't flood rendering.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import YPartyKitProvider from "y-partykit/provider";
import * as Y from "yjs";
import type { AwarenessState, BoardNode, Role } from "@/contracts/board";
import { publicEnv } from "@/lib/env";
import { loadIdentity, type Identity } from "./presence";
import { createUndoManager, initBoard, listNodes } from "./schema";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface BoardConnection {
  doc: Y.Doc;
  identity: Identity;
  role: Role;
  nodes: BoardNode[];
  status: ConnectionStatus;
  synced: boolean;
  /** Consecutive failed connection attempts (auth rejections show up here). */
  failedAttempts: number;
  awareness: ReadonlyMap<number, Partial<AwarenessState>>;
  selfClientId: number;
  setPresence: (patch: Partial<Pick<AwarenessState, "cursor" | "selection" | "drawing" | "viewport">>) => void;
  undo: () => void;
  redo: () => void;
}

function rafBatch(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

export function useBoard(roomId: string, role: Role, token?: string | null): BoardConnection {
  const identity = useMemo(() => loadIdentity(), []);
  // One doc per room. Not destroyed on unmount: React StrictMode re-runs effects with the same
  // memoised doc, and an unreferenced Y.Doc is simply garbage-collected.
  const doc = useMemo(() => new Y.Doc(), [roomId]); // eslint-disable-line react-hooks/exhaustive-deps
  const providerRef = useRef<YPartyKitProvider | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);

  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [awareness, setAwareness] = useState<ReadonlyMap<number, Partial<AwarenessState>>>(new Map());

  useEffect(() => {
    const params: Record<string, string> = { role, uid: identity.id };
    if (token) params.token = token;
    const provider = new YPartyKitProvider(publicEnv.partykitHost, roomId, doc, {
      party: "main",
      params,
      maxBackoffTime: 5000,
    });
    providerRef.current = provider;
    undoRef.current = createUndoManager(doc);

    provider.awareness.setLocalState({
      user: { id: identity.id, name: identity.name, color: identity.color, role },
      cursor: null,
      selection: [],
      drawing: null,
    } satisfies AwarenessState);

    const refreshNodes = rafBatch(() => setNodes(listNodes(doc)));
    const refreshAwareness = rafBatch(
      () => setAwareness(new Map(provider.awareness.getStates() as Map<number, Partial<AwarenessState>>)),
    );

    doc.on("update", refreshNodes);
    provider.awareness.on("change", refreshAwareness);
    provider.on("status", ({ status: s }: { status: ConnectionStatus }) => {
      setStatus(s);
      setFailedAttempts(provider.wsUnsuccessfulReconnects);
    });
    provider.on("sync", (isSynced: boolean) => {
      setSynced(isSynced);
      if (isSynced && role !== "viewer") initBoard(doc);
      refreshNodes();
    });
    refreshNodes();

    return () => {
      doc.off("update", refreshNodes);
      provider.awareness.off("change", refreshAwareness);
      undoRef.current?.destroy();
      provider.destroy();
      providerRef.current = null;
    };
  }, [doc, roomId, role, token, identity]);

  const setPresence = useCallback<BoardConnection["setPresence"]>((patch) => {
    const aw = providerRef.current?.awareness;
    if (!aw) return;
    const current = aw.getLocalState() ?? {};
    aw.setLocalState({ ...current, ...patch });
  }, []);

  const undo = useCallback(() => undoRef.current?.undo(), []);
  const redo = useCallback(() => undoRef.current?.redo(), []);

  return {
    doc,
    identity,
    role,
    nodes,
    status,
    synced,
    failedAttempts,
    awareness,
    selfClientId: doc.clientID,
    setPresence,
    undo,
    redo,
  };
}
