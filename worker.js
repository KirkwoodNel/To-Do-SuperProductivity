/**
 * sp-todo-sync — PHASE 1: read-only reconnaissance
 *
 * Does not write to Dropbox or Microsoft To Do.
 *
 * Secrets:
 *   DEBUG_SECRET
 *   DROPBOX_APP_KEY
 *   DROPBOX_APP_SECRET
 * Optional secret (or stored via /auth/callback into KV):
 *   DROPBOX_REFRESH_TOKEN
 *
 * Binding:
 *   KV SP_KV
 *
 * Routes:
 *   GET  /auth/start
 *   GET  /auth/callback
 *   GET  /debug/locate
 *   GET  /debug/structure
 *   GET  /debug/webhook
 *   GET  /webhook/dropbox
 *   POST /webhook/dropbox
 *   GET  /health
 */

const DBX_API = "https://api.dropboxapi.com/2";
const DBX_CONTENT = "https://content.dropboxapi.com/2";
const READ_SCOPES = "account_info.read files.metadata.read files.content.read";
const KNOWN_PATH = "/apps/super_productivity/sync-data.json";

const SAFE_KEYS = new Set([
  "syncVersion", "schemaVersion", "modelVersion", "version",
  "clientId", "lastUpdate", "oldestOpSyncVersion",
  "opType", "type", "actionType", "entityType",
  "isCompressed", "isEncrypted", "crc",
]);

const MAX_DEPTH = 6;
const MAX_ARRAY_SAMPLE = 3;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isAuthed(request, env) {
  return (request.headers.get("Authorization") || "") === `Bearer ${env.DEBUG_SECRET}`;
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401);
}

async function getRefreshToken(env) {
  if (env.DROPBOX_REFRESH_TOKEN) return env.DROPBOX_REFRESH_TOKEN;
  return env.SP_KV.get("dropbox_refresh_token");
}

async function getAccessToken(env) {
  const refresh = await getRefreshToken(env);
  if (!refresh) {
    throw new Error("No Dropbox refresh token. Visit /auth/start first.");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!resp.ok) throw new Error(`Dropbox token refresh failed: ${resp.status} ${await resp.text()}`);
  return (await resp.json()).access_token;
}

async function dbxRpc(env, path, args, accessToken) {
  const token = accessToken || (await getAccessToken(env));
  const resp = await fetch(`${DBX_API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`Dropbox ${path} failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function locateSyncFile(env, accessToken) {
  const cached = await env.SP_KV.get("sp_file_path");
  if (cached) return cached;

  const res = await dbxRpc(env, "/files/search_v2", {
    query: "sync-data.json",
    options: { filename_only: true, max_results: 25 },
  }, accessToken);

  const paths = (res.matches || [])
    .map((m) => m.metadata?.metadata?.path_lower)
    .filter(Boolean);

  const preferred =
    paths.find((p) => p === KNOWN_PATH) ||
    paths.find((p) => p.startsWith("/apps/super_productivity")) ||
    paths.find((p) => p.startsWith("/apps/")) ||
    paths[0];

  if (!preferred) {
    throw new Error(
      "sync-data.json not found. If this Dropbox app is App-folder scoped it cannot see Super Productivity's file — recreate as Full Dropbox."
    );
  }

  await env.SP_KV.put("sp_file_path", preferred);
  return preferred;
}

async function downloadFile(env, path, accessToken) {
  const token = accessToken || (await getAccessToken(env));
  const resp = await fetch(`${DBX_CONTENT}/files/download`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path }),
    },
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${await resp.text()}`);
  const meta = JSON.parse(resp.headers.get("Dropbox-API-Result") || "{}");
  return { text: await resp.text(), rev: meta.rev, size: meta.size };
}

function parseHeader(raw) {
  if (!raw.startsWith("pf_")) {
    return { ok: false, reason: "missing pf_ prefix", head: describeHead(raw) };
  }
  const end = raw.indexOf("__", 3);
  if (end === -1) {
    return { ok: false, reason: "no __ terminator found", head: describeHead(raw) };
  }
  let flags = raw.slice(3, end);
  const compressed = flags.startsWith("C");
  if (compressed) flags = flags.slice(1);
  const encrypted = flags.startsWith("E");
  if (encrypted) flags = flags.slice(1);

  return {
    ok: true,
    compressed,
    encrypted,
    modelVersion: flags,
    header: raw.slice(0, end + 2),
    bodyOffset: end + 2,
  };
}

function describeHead(raw) {
  const head = raw.slice(0, 40);
  if (/^\s*[[{]/.test(head)) return "json";
  if (/^\s*</.test(head)) return "markup";
  if (/^[A-Za-z0-9+/=]{20,}/.test(head)) return "base64";
  return "other";
}

function describe(value, depth = 0) {
  if (value === null) return "null";
  if (depth >= MAX_DEPTH) return "<max-depth>";

  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    return {
      _type: `array[${value.length}]`,
      _sample: value.slice(0, MAX_ARRAY_SAMPLE).map((v) => describe(v, depth + 1)),
    };
  }

  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SAFE_KEYS.has(k) ? v : describe(v, depth + 1);
    }
    return out;
  }

  if (typeof value === "string") return `<string:${value.length}>`;
  if (typeof value === "number") return "<number>";
  if (typeof value === "boolean") return "<boolean>";
  return `<${typeof value}>`;
}

async function verifySignature(rawBody, signatureHex, appSecret) {
  if (!signatureHex) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== signatureHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signatureHex.charCodeAt(i);
  }
  return diff === 0;
}

async function recordWebhookHit(env, verified) {
  const raw = await env.SP_KV.get("webhook_hits");
  const hits = raw ? JSON.parse(raw) : [];
  hits.unshift({ at: new Date().toISOString(), verified });
  await env.SP_KV.put("webhook_hits", JSON.stringify(hits.slice(0, 50)));
}

async function handleLocate(env) {
  const token = await getAccessToken(env);
  const path = await locateSyncFile(env, token);
  const folder = path.slice(0, path.lastIndexOf("/"));
  const listing = await dbxRpc(env, "/files/list_folder", { path: folder }, token);

  return json({
    resolvedPath: path,
    folder,
    entries: (listing.entries || []).map((e) => ({
      name: e.name,
      tag: e[".tag"],
      size: e.size,
      rev: e.rev,
      modified: e.server_modified,
    })),
    looksLikeV3Split: (listing.entries || []).some((e) => e.name === "sync-ops.json"),
  });
}

async function handleStructure(env) {
  const token = await getAccessToken(env);
  const path = await locateSyncFile(env, token);
  const { text, rev, size } = await downloadFile(env, path, token);

  const header = parseHeader(text);
  if (!header.ok) {
    return json({ path, rev, size, header, error: "could not parse pf_ header" }, 500);
  }
  if (header.encrypted) {
    return json({ path, rev, size, header, error: "file is encrypted — design assumes plaintext" }, 500);
  }
  if (header.compressed) {
    return json({ path, rev, size, header, error: "file is compressed — decompression not implemented in Phase 1" }, 500);
  }

  const body = text.slice(header.bodyOffset);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return json({ path, rev, size, header, error: `JSON parse failed: ${e.message}`, bodyHead: describeHead(body) }, 500);
  }

  return json({
    path,
    rev,
    size,
    header: { compressed: header.compressed, encrypted: header.encrypted, modelVersion: header.modelVersion },
    topLevelKeys: Object.keys(parsed),
    structure: describe(parsed),
  });
}

async function handleWebhookDebug(env) {
  const raw = await env.SP_KV.get("webhook_hits");
  return json({
    hits: raw ? JSON.parse(raw) : [],
    note: "If this stays empty after you change a task in SP and wait a minute, fall back to a 5-minute cron poll.",
  });
}

function handleAuthStart(request, env) {
  const redirectUri = new URL("/auth/callback", request.url).toString();
  const u = new URL("https://www.dropbox.com/oauth2/authorize");
  u.searchParams.set("client_id", env.DROPBOX_APP_KEY);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("token_access_type", "offline");
  u.searchParams.set("scope", READ_SCOPES);
  u.searchParams.set("redirect_uri", redirectUri);
  return Response.redirect(u.toString(), 302);
}

async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const err = url.searchParams.get("error");
  if (err) return json({ error: err, description: url.searchParams.get("error_description") }, 400);
  const code = url.searchParams.get("code");
  if (!code) return json({ error: "missing code" }, 400);

  const redirectUri = new URL("/auth/callback", request.url).toString();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await resp.json();
  if (!resp.ok) return json({ error: "token exchange failed", detail: payload }, 500);
  if (!payload.refresh_token) {
    return json({ error: "no refresh_token returned — token_access_type=offline required" }, 500);
  }

  await env.SP_KV.put("dropbox_refresh_token", payload.refresh_token);
  return json({
    ok: true,
    scope: payload.scope,
    account_id: payload.account_id,
    note: "Refresh token stored in KV. Do not paste it into chat. You can also copy it into the DROPBOX_REFRESH_TOKEN Worker secret.",
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/auth/start" && request.method === "GET") {
      return handleAuthStart(request, env);
    }
    if (url.pathname === "/auth/callback" && request.method === "GET") {
      return handleAuthCallback(request, env);
    }

    if (url.pathname === "/webhook/dropbox" && request.method === "GET") {
      const challenge = url.searchParams.get("challenge");
      if (challenge === null) return new Response("missing challenge", { status: 400 });
      return new Response(challenge, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (url.pathname === "/webhook/dropbox" && request.method === "POST") {
      const rawBody = await request.text();
      const sig = request.headers.get("X-Dropbox-Signature");
      const verified = await verifySignature(rawBody, sig, env.DROPBOX_APP_SECRET);
      ctx.waitUntil(recordWebhookHit(env, verified));
      return new Response("", { status: 200 });
    }

    if (url.pathname === "/health") {
      const raw = await env.SP_KV.get("webhook_hits");
      const hits = raw ? JSON.parse(raw) : [];
      const hasRefresh = !!(await getRefreshToken(env));
      return json({ ok: true, hasRefreshToken: hasRefresh, webhookHits: hits.length, lastHit: hits[0]?.at || null });
    }

    if (url.pathname.startsWith("/debug/")) {
      if (!isAuthed(request, env)) return unauthorized();
      try {
        if (url.pathname === "/debug/locate") return await handleLocate(env);
        if (url.pathname === "/debug/structure") return await handleStructure(env);
        if (url.pathname === "/debug/webhook") return await handleWebhookDebug(env);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        name: "sp-todo-sync",
        phase: 1,
        mode: "dropbox-read-only",
        next: "GET /auth/start after secrets and redirect URI are set",
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
