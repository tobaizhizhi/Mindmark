import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServerEnvironment } from "./config";

let cachedClient: SupabaseClient | undefined;

export function getSupabaseAdmin(): SupabaseClient {
  if (!cachedClient) {
    const environment = getServerEnvironment();
    cachedClient = createClient(
      environment.SUPABASE_URL,
      environment.SUPABASE_SERVICE_ROLE_KEY,
      {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { "X-Client-Info": "mindmark-web-server" } },
      },
    );
  }
  return cachedClient;
}

