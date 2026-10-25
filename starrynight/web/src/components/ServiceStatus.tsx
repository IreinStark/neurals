"use client";

import { useEffect, useState } from "react";
import { createDjangoClient } from "@/lib/django";

type State = "checking" | "up" | "down";

/** Pings Django through the same-origin /api/v2 rewrite. */
export function DjangoStatus() {
  const [state, setState] = useState<State>("checking");

  useEffect(() => {
    const controller = new AbortController();
    const client = createDjangoClient({
      fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    });
    client
      .health()
      .then(() => setState("up"))
      .catch(() => {
        if (!controller.signal.aborted) setState("down");
      });
    return () => controller.abort();
  }, []);

  const label = { checking: "Checking…", up: "Reachable", down: "Not reachable" }[state];
  const tone = state === "up" ? "text-ok" : state === "down" ? "text-warn" : "text-muted";
  return <span className={tone}>{label}</span>;
}
