# sp-todo-sync

A Cloudflare Worker that acts as a WebDAV server for Super Productivity to
sync against, instead of Dropbox/Nextcloud/etc. Backed by Cloudflare KV.

## Why this exists

Super Productivity has no public cloud API - only a "Local REST API" that
only runs on whichever machine has the desktop app open. Its WebDAV sync
provider, though, is fully documented and cloud-reachable, so we host the
sync file ourselves here instead.

## What this milestone does (and doesn't) do

- Stores and serves whatever Super Productivity writes via WebDAV, exactly
  as sent. This is safe by construction - we never interpret or modify the
  file's contents, so there's no risk of corrupting anything Super
  Productivity's own app relies on internally.
- Honors `If-Unmodified-Since` on writes (the real conflict-detection
  mechanism SP's WebDAV provider uses), so it won't silently clobber a
  change SP itself hasn't seen yet.
- Does **not** yet talk to Microsoft To Do. That needs a real sample of what
  SP actually writes into the file first (see "Inspecting the synced file"
  below) so the task field-mapping is built against real data, not guesses.

## Setup (via the Cloudflare dashboard - no wrangler needed)

1. **Create the KV namespace**: Cloudflare dashboard -> Workers & Pages ->
   KV -> Create a namespace. Name it e.g. `sp_sync_kv`. Copy its ID.
2. **Create the Worker**: Workers & Pages -> Create -> Create Worker. Name
   it `sp-todo-sync` (or anything you like).
3. **Paste the code**: open the Worker's editor and replace the default
   code with the contents of `worker.js` from this repo. Deploy.
4. **Bind the KV namespace**: Worker -> Settings -> Bindings -> Add binding
   -> KV Namespace. Variable name must be exactly `SP_SYNC_KV`, pointing at
   the namespace you created in step 1.
5. **Set secrets**: Worker -> Settings -> Variables and Secrets -> add
   three **secret** (encrypted) variables:
   - `WEBDAV_USER` - make up a username
   - `WEBDAV_PASS` - make up a password
   - `DEBUG_TOKEN` - any random string (used only to protect the inspection
     endpoint below)
6. Note your Worker's URL - it'll be something like
   `https://sp-todo-sync.<your-subdomain>.workers.dev`.

## Pointing Super Productivity at it

In Super Productivity: Settings -> Sync -> choose **WebDAV** as the
provider, and enter:

- **Base URL**: your Worker's URL from step 6 above
- **Username / Password**: the `WEBDAV_USER` / `WEBDAV_PASS` you set
- **Sync file path**: anything you like (e.g. `/superproductivity/`) - this
  Worker doesn't care what path SP uses, it just stores whatever it's given

Trigger a manual sync in SP once you've saved those settings.

## Inspecting the synced file

Once SP has synced at least once, see what actually landed in KV:

```bash
# List every path SP has written to:
curl "https://<your-worker>.workers.dev/debug/dump?token=<DEBUG_TOKEN>"

# Dump one file's raw content and metadata:
curl "https://<your-worker>.workers.dev/debug/dump?token=<DEBUG_TOKEN>&path=/superproductivity/some-file.json"
```

Share that output back so the real Microsoft To Do field-mapping can be
built against your actual data instead of guesses from documentation.

## Security note

Anyone with your Worker's URL + WebDAV credentials can read and write your
synced task data - treat `WEBDAV_USER`/`WEBDAV_PASS`/`DEBUG_TOKEN` like
passwords, the same way the existing `gtd-todo-sync` Worker treats its own
`WORKER_SECRET`.
