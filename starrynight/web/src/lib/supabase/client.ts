"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseEnv } from "@/lib/env";

let browserClient: SupabaseClient | null = null;

/** Singleton Supabase client for Client Components. */
export function getSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    const { url, anonKey } = requireSupabaseEnv();
    browserClient = createBrowserClient(url, anonKey);
  }
  return browserClient;
}
