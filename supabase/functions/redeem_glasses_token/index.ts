import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";

const RedeemBody = z.object({ code: z.string().regex(/^\d{6}$/) });

serve(async (req) => {
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  );

  const { data: allowed } = await supabaseAdmin.rpc("check_rate_limit", {
    p_key: `redeem_glasses:${clientIp}`,
    p_window_seconds: 60,
    p_max_requests: 5,
  });
  if (allowed === false) {
    return new Response(JSON.stringify({ error: "Too many attempts" }), {
      status: 429, headers: { "Content-Type": "application/json" },
    });
  }

  const raw = await req.json().catch(() => ({}));
  const parsed = RedeemBody.safeParse(raw);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "Invalid code format" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  const { code } = parsed.data;

  const { data: token } = await supabaseAdmin
    .from("glasses_tokens")
    .select("code, user_id, expires_at, used_at")
    .eq("code", code)
    .single();

  if (!token) {
    return new Response(JSON.stringify({ error: "Invalid or expired code" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  if (token.used_at) {
    return new Response(JSON.stringify({ error: "Code already used" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }
  if (new Date(token.expires_at) < new Date()) {
    return new Response(JSON.stringify({ error: "Code expired" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // Mark used before provisioning to prevent race conditions
  await supabaseAdmin
    .from("glasses_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("code", code);

  // Create a glasses device user
  const deviceEmail = `glasses-${crypto.randomUUID()}@device.agentvisor`;
  const devicePassword = crypto.randomUUID();

  const { data: createdUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
    email: deviceEmail,
    password: devicePassword,
    email_confirm: true,
    app_metadata: { is_glasses: true, owner_id: token.user_id },
  });

  if (createError || !createdUser.user) {
    console.error("[redeem_glasses_token] createUser failed:", createError?.message);
    return new Response(JSON.stringify({ error: "Failed to provision glasses account" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // Sign in server-side and return only the session tokens — raw credentials never leave the server
  const supabaseSignIn = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );
  const { data: sessionData, error: signInError } = await supabaseSignIn.auth.signInWithPassword({
    email: deviceEmail,
    password: devicePassword,
  });

  if (signInError || !sessionData.session) {
    console.error("[redeem_glasses_token] signIn failed:", signInError?.message);
    return new Response(JSON.stringify({ error: "Failed to create session" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      status: "approved",
      session: {
        access_token:  sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_at:    sessionData.session.expires_at,
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
