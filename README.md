# sp-todo-sync — Phase 1

Read-only Cloudflare Worker. Super Productivity stays on Dropbox.
This Worker only finds and inspects `/Apps/super_productivity/sync-data.json`.
It does not write Dropbox or Microsoft To Do.

Replaces the abandoned WebDAV Worker in this repo.

## Dropbox app

- Name: `sp-todo-sync-cranberry`
- App key: `a1gln76r3jc50zn`
- Public clients: Disallow
- Scopes requested at OAuth: `account_info.read files.metadata.read files.content.read`
- Must be **Full Dropbox** (cannot see SP’s app folder otherwise)

## Deploy (dashboard)

1. Workers → Create Worker named `sp-todo-sync` (or open it if it exists).
2. Paste `worker.js`. Deploy.
3. Settings → Bindings → KV. Variable name **exactly** `SP_KV`. Namespace `sp_sync_kv` (`084c7fc8b473467da90bc3001fbbd95f`).
4. Secrets:
   - `DEBUG_SECRET` — long random string
   - `DROPBOX_APP_KEY`
   - `DROPBOX_APP_SECRET`
5. On the Dropbox app Settings page add Redirect URI:

   `https://sp-todo-sync.<your-subdomain>.workers.dev/auth/callback`

6. Visit `https://sp-todo-sync.<your-subdomain>.workers.dev/auth/start` and Allow.
7. Confirm `/health` shows `"hasRefreshToken": true`.

## Probe (values redacted)

```bash
curl -sS -H "Authorization: Bearer $DEBUG_SECRET" \
  https://sp-todo-sync.<subdomain>.workers.dev/debug/locate

curl -sS -H "Authorization: Bearer $DEBUG_SECRET" \
  https://sp-todo-sync.<subdomain>.workers.dev/debug/structure
```

Expected locate path: `/apps/super_productivity/sync-data.json`.
If search finds nothing, the Dropbox app is App-folder scoped — delete it and recreate as Full Dropbox.

## Webhook test (optional in Phase 1)

Add Webhook URI:

`https://sp-todo-sync.<subdomain>.workers.dev/webhook/dropbox`

Change a task in Super Productivity, wait one minute, then:

```bash
curl -sS -H "Authorization: Bearer $DEBUG_SECRET" \
  https://sp-todo-sync.<subdomain>.workers.dev/debug/webhook
```

Empty hits → Full Dropbox does not notify for another app’s folder → 5-minute cron later.
