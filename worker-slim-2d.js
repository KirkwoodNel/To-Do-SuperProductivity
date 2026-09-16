/**
 * slim 2d: push open SP tasks to To Do Tasks list
 */
const DBX_API = "https://api.dropboxapi.com/2";
const DBX_CONTENT = "https://content.dropboxapi.com/2";
const GRAPH_AUTHORITY = "https://login.microsoftonline.com/73234503-195d-4792-8e06-f09746f05f11";
const GRAPH_SCOPES = "offline_access User.Read Tasks.ReadWrite";
const KNOWN_PATH = "/apps/super_productivity/sync-data.json";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
function isAuthed(request, env) {
  return (request.headers.get("Authorization") || "") === `Bearer ${env.DEBUG_SECRET}`;
}
async function getRefreshToken(env) {
  return env.DROPBOX_REFRESH_TOKEN || env.SP_KV.get("dropbox_refresh_token");
}
async function getAccessToken(env) {
  const refresh = await getRefreshToken(env);
  if (!refresh) throw new Error("No Dropbox refresh");
  const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  if (!resp.ok) throw new Error(`dbx token ${resp.status}`);
  return (await resp.json()).access_token;
}
async function parseSp(env) {
  const token = await getAccessToken(env);
  const path = (await env.SP_KV.get("sp_file_path")) || KNOWN_PATH;
  const resp = await fetch(`${DBX_CONTENT}/files/download`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!resp.ok) throw new Error(`download ${resp.status} ${await resp.text()}`);
  const meta = JSON.parse(resp.headers.get("Dropbox-API-Result") || "{}");
  let text = await resp.text();
  if (text.startsWith("pf_")) {
    const end = text.indexOf("__", 3);
    text = text.slice(end + 2);
  }
  return { path, rev: meta.rev, size: meta.size, data: JSON.parse(text) };
}
async function getGraphToken(env) {
  const cached = await env.SP_KV.get("graph_access_token");
  if (cached) return cached;
  const refresh = env.GRAPH_REFRESH_TOKEN || (await env.SP_KV.get("graph_refresh_token"));
  if (!refresh) throw new Error("No Graph refresh");
  const clientId = env.GRAPH_CLIENT_ID || "d924cf88-067c-49e5-b4bc-fc4105664437";
  const resp = await fetch(`${GRAPH_AUTHORITY}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: env.GRAPH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: GRAPH_SCOPES,
    }),
  });
  const payload = await resp.json();
  if (!resp.ok) throw new Error(`graph refresh ${resp.status} ${JSON.stringify(payload)}`);
  if (payload.refresh_token) await env.SP_KV.put("graph_refresh_token", payload.refresh_token);
  await env.SP_KV.put("graph_access_token", payload.access_token, { expirationTtl: 3000 });
  return payload.access_token;
}
async function graphGetAll(env, path) {
  const items = [];
  let url = `https://graph.microsoft.com/v1.0${path}`;
  const token = await getGraphToken(env);
  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`graph ${resp.status} ${await resp.text()}`);
    const data = await resp.json();
    items.push(...(data.value || []));
    url = data["@odata.nextLink"] || null;
  }
  return items;
}
function normTitle(s) { return s.toLowerCase().replace(/\s+/g, " ").trim(); }
async function handlePushSp(env, apply) {
  const { path, rev, size, data } = await parseSp(env);
  const entities = (data.state && data.state.task && data.state.task.entities) || {};
  const lists = await graphGetAll(env, "/me/todo/lists");
  const wanted = lists.filter((l) => l.wellknownListName === "defaultList" || l.wellknownListName === "flaggedEmails");
  const existing = new Set();
  let defaultListId = null;
  for (const list of wanted) {
    if (list.wellknownListName === "defaultList") defaultListId = list.id;
    const tasks = await graphGetAll(env, `/me/todo/lists/${list.id}/tasks?$filter=status+ne+'completed'&$top=100`);
    for (const t of tasks) existing.add(normTitle(t.title || ""));
  }
  if (!defaultListId) throw new Error("no default list");
  let creates = 0, skips = 0, created = 0;
  const token = await getGraphToken(env);
  for (const t of Object.values(entities)) {
    if (t.isDone) continue;
    const title = String(t.title || "").trim();
    if (!title) continue;
    const n = normTitle(title);
    if (existing.has(n)) { skips++; continue; }
    existing.add(n);
    creates++;
    if (!apply) continue;
    const body = { title, body: { content: String(t.notes || t.note || "").slice(0, 4000), contentType: "text" } };
    if (t.dueDay) body.dueDateTime = { dateTime: `${t.dueDay}T00:00:00`, timeZone: "UTC" };
    else if (t.dueWithTime || t.due) {
      const d = new Date(t.dueWithTime || t.due);
      if (Number.isFinite(d.getTime())) body.dueDateTime = { dateTime: d.toISOString().replace("Z", ""), timeZone: "UTC" };
    }
    const resp = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${defaultListId}/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`create ${resp.status} ${await resp.text()}`);
    created++;
  }
  return json({ dryRun: !apply, path, rev, size, plannedCreates: creates, plannedSkips: skips, created: apply ? created : 0 });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        phase: "2d-push",
        hasDropboxRefresh: !!(await getRefreshToken(env)),
        hasGraphRefresh: !!(env.GRAPH_REFRESH_TOKEN || (await env.SP_KV.get("graph_refresh_token"))),
      });
    }
    if (url.pathname === "/debug/push-sp") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      try { return await handlePushSp(env, url.searchParams.get("apply") === "1"); }
      catch (e) { return json({ error: e.message }, 500); }
    }
    return new Response("Not found", { status: 404 });
  },
};
