import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TTL_MINUTES = 5;

serve(async (req) => {
  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: req.headers.get("Authorization") } } }
  );

  const { data: { user } } = await supabaseAuth.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  // Rate limit: 10 tokens per minute per user
  const { data: allowed } = await supabaseAdmin.rpc("check_rate_limit", {
    p_key: `glasses_token:${user.id}`,
    p_window_seconds: 60,
    p_max_requests: 10,
  });
  if (allowed === false) {
    return new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429, headers: { "Content-Type": "application/json" },
    });
  }

  // Invalidate any existing unused tokens for this user
  await supabaseAdmin
    .from("glasses_tokens")
    .delete()
    .eq("user_id", user.id)
    .is("used_at", null);

  // Generate a 6-digit code
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const code = (100000 + (buf[0] % 900000)).toString();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString();

  const { error } = await supabaseAdmin
    .from("glasses_tokens")
    .insert({ code, user_id: user.id, expires_at: expiresAt });

  if (error) {
    console.error("[create_glasses_token] insert failed:", error.message);
    return new Response(JSON.stringify({ error: "Failed to create token" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({ code, expires_at: expiresAt }),
    { headers: { "Content-Type": "application/json" } }
  );
});
