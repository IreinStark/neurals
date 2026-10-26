"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewBoardButton() {
  const router = useRouter();
  const [code, setCode] = useState("");

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <button
        type="button"
        className="rounded-lg bg-accent px-4 py-2 font-medium text-white hover:opacity-90"
        onClick={() => router.push(`/board/${crypto.randomUUID()}`)}
      >
        New board
      </button>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const id = code.trim().toLowerCase();
          if (id) router.push(`/board/${encodeURIComponent(id)}`);
        }}
      >
        <label className="flex flex-col text-sm">
          <span className="text-muted">Join with a board code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="e.g. demo"
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>
        <button type="submit" className="self-end rounded-lg border border-border bg-surface px-4 py-2">
          Join
        </button>
      </form>
    </div>
  );
}
