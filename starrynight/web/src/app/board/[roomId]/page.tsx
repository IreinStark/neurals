import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Role } from "@/contracts/board";
import { BoardClient } from "./BoardClient";

export const metadata: Metadata = { title: "Board · StarryNight" };

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i;

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { roomId } = await params;
  const query = await searchParams;
  if (!ROOM_RE.test(roomId)) notFound();

  // Dev mode: the role comes from the link (?role=viewer). The sync server enforces it.
  // Once Supabase auth (T2.2) is on, the role comes from room_members instead.
  const role: Role = query.role === "viewer" ? "viewer" : query.role === "owner" ? "owner" : "editor";
  const debug = query.debug === "1";

  return (
    <main>
      <h1 className="sr-only">Whiteboard {roomId}</h1>
      <BoardClient roomId={roomId.toLowerCase()} role={role} debug={debug} />
    </main>
  );
}
