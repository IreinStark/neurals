/**
 * Public runtime config (ARCHITECTURE_SPEC §11).
 * NEXT_PUBLIC_* values are inlined at build time, so they must be referenced
 * literally (process.env.NEXT_PUBLIC_X), never via dynamic keys.
 */
export interface PublicEnv {
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  partykitHost: string;
  djangoUrl: string;
}

export const publicEnv: PublicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || null,
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null,
  partykitHost: process.env.NEXT_PUBLIC_PARTYKIT_HOST || "127.0.0.1:1999",
  djangoUrl: process.env.NEXT_PUBLIC_DJANGO_URL || "http://127.0.0.1:8000",
};

export function isSupabaseConfigured(env: PublicEnv = publicEnv): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

export function requireSupabaseEnv(env: PublicEnv = publicEnv): { url: string; anonKey: string } {
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new Error(
      "Supabase is not configured. Copy web/.env.example to web/.env.local and set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  return { url: env.supabaseUrl, anonKey: env.supabaseAnonKey };
}
