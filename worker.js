/**
 * sp-todo-sync - Milestone 1
 *
 * A minimal WebDAV server, backed by Cloudflare KV, that Super Productivity's
 * "WebDAV" sync provider can point at instead of Dropbox/Nextcloud/etc.
 *
 * Why this exists: Super Productivity has no public cloud API for its task
 * data - only a Local REST API that only runs on whichever machine has the
 * desktop app open. Its WebDAV sync provider, though, is a fully documented,
 * first-class sync target - so instead of Dropbox, we host the sync file
 * ourselves and get a cloud-reachable, always-on copy of it.
 *
 * This milestone deliberately does NOT try to parse or rewrite the file's
 * contents to talk to Microsoft To Do yet - we don't have a real sample of
 * what Super Productivity actually writes into it. It only stores and serves
 * whatever bytes SP's client sends, faithfully, which is safe by
 * construction: SP's own app is still the only thing that understands and
 * writes its internal format. We're just the file store.
 *
 * Once you've pointed SP at this Worker and it's synced at least once, use
 * GET /debug/dump (see below) to fetch the real file content and mapping to
 * Microsoft To Do fields can be built against real data instead of guesses.
 *
 * --- Required setup (see README.md for full steps) ---
 * 1. Create a KV namespace and bind it to this Worker as `SP_SYNC_KV`.
 * 2. Set two secrets: WEBDAV_USER and WEBDAV_PASS (Basic Auth credentials -
 *    make these up yourself, then enter the same values in Super
 *    Productivity's WebDAV sync settings).
 * 3. Set a third secret: DEBUG_TOKEN (any random string) to protect the
 *    /debug/dump inspection endpoint.
 */

function unauthorized() {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="sp-todo-sync"' }
  });
}

function checkBasicAuth(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === env.WEBDAV_USER && pass === env.WEBDAV_PASS;
}

// Cloudflare KV keys can't contain characters that would be ambiguous, and we
// want one flat namespace per WebDAV path - normalize leading/trailing slashes.
function pathToKey(pathname) {
  return 'file:' + decodeURIComponent(pathname).replace(/^\/+/, '').replace(/\/+$/, '');
}

function isCollectionPath(pathname) {
  return pathname.endsWith('/') || pathname === '';
}

async function handlePropfind(request, env, pathname) {
  const depth = request.headers.get('Depth') || '1';
  const key = pathToKey(pathname);
  const isCollection = isCollectionPath(pathname);
  const stored = isCollection ? null : await env.SP_SYNC_KV.getWithMetadata(key);

  // Minimal PROPFIND response: we don't try to enumerate real children for
  // collections (Depth: 1 on a directory) - Super Productivity's WebDAV
  // client falls back to a HEAD request when a full listing isn't available,
  // per its own source (see README.md notes on providers/webdav fallbacks).
  const lastModified = stored?.metadata?.lastModified
    ? new Date(stored.metadata.lastModified).toUTCString()
    : new Date().toUTCString();
  const contentLength = stored?.value ? new TextEncoder().encode(stored.value).length : 0;

  const resourceType = isCollection
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : '<D:resourcetype/>';

  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${escapeXml(pathname)}</D:href>
    <D:propstat>
      <D:prop>
        ${resourceType}
        <D:getlastmodified>${lastModified}</D:getlastmodified>
        <D:getcontentlength>${contentLength}</D:getcontentlength>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

  return new Response(body, {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}

function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

async function handleGet(request, env, pathname, includeBody) {
  const key = pathToKey(pathname);
  const stored = await env.SP_SYNC_KV.getWithMetadata(key);
  if (stored.value === null) return new Response('Not Found', { status: 404 });
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Last-Modified': new Date(stored.metadata?.lastModified || Date.now()).toUTCString()
  };
  return new Response(includeBody ? stored.value : null, { status: 200, headers });
}

async function handlePut(request, env, pathname) {
  const key = pathToKey(pathname);

  // Conflict detection: if the client says "only save this if nobody's
  // touched it since I last read it", honor that against our stored
  // Last-Modified. This is the actual mechanism Super Productivity's WebDAV
  // provider uses (If-Unmodified-Since), not an exotic vector-clock scheme.
  const ifUnmodifiedSince = request.headers.get('If-Unmodified-Since');
  if (ifUnmodifiedSince) {
    const existing = await env.SP_SYNC_KV.getWithMetadata(key);
    if (existing.value !== null && existing.metadata?.lastModified) {
      const clientTime = new Date(ifUnmodifiedSince).getTime();
      const storedTime = new Date(existing.metadata.lastModified).getTime();
      if (storedTime > clientTime) {
        return new Response('Precondition Failed', { status: 412 });
      }
    }
  }

  const content = await request.text();
  const lastModified = new Date().toISOString();
  await env.SP_SYNC_KV.put(key, content, { metadata: { lastModified } });
  return new Response(null, { status: 201, headers: { 'Last-Modified': new Date(lastModified).toUTCString() } });
}

async function handleMkcol(request, env, pathname) {
  // We don't have real directories - a flat KV namespace doesn't need them -
  // but WebDAV clients expect MKCOL to succeed before they PUT into a "folder".
  // Store an empty marker so PROPFIND on this path resolves as a collection.
  const key = pathToKey(pathname.endsWith('/') ? pathname : pathname + '/');
  const existing = await env.SP_SYNC_KV.get(key);
  if (existing !== null) return new Response('Already Exists', { status: 405 });
  await env.SP_SYNC_KV.put(key, '', { metadata: { lastModified: new Date().toISOString(), collection: true } });
  return new Response(null, { status: 201 });
}

async function handleDelete(request, env, pathname) {
  await env.SP_SYNC_KV.delete(pathToKey(pathname));
  return new Response(null, { status: 204 });
}

// Lets you (or the person you're debugging with) see exactly what Super
// Productivity actually wrote, once it's synced at least once - e.g.:
//   curl "https://<worker>.workers.dev/debug/dump?token=...&path=/some/file"
async function handleDebugDump(request, env, url) {
  const token = url.searchParams.get('token');
  if (!token || token !== env.DEBUG_TOKEN) return new Response('Unauthorized', { status: 401 });
  const path = url.searchParams.get('path');
  if (!path) {
    const list = await env.SP_SYNC_KV.list({ prefix: 'file:' });
    return Response.json({ keys: list.keys.map((k) => k.name) });
  }
  const stored = await env.SP_SYNC_KV.getWithMetadata(pathToKey(path));
  return Response.json({ metadata: stored.metadata, content: stored.value });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/debug/dump') {
      return handleDebugDump(request, env, url);
    }

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response('sp-todo-sync WebDAV endpoint is running.', { status: 200 });
    }

    if (!checkBasicAuth(request, env)) return unauthorized();

    const pathname = url.pathname;

    switch (request.method) {
      case 'OPTIONS':
        return new Response(null, {
          status: 200,
          headers: {
            DAV: '1',
            Allow: 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL'
          }
        });
      case 'PROPFIND':
        return handlePropfind(request, env, pathname);
      case 'GET':
        return handleGet(request, env, pathname, true);
      case 'HEAD':
        return handleGet(request, env, pathname, false);
      case 'PUT':
        return handlePut(request, env, pathname);
      case 'MKCOL':
        return handleMkcol(request, env, pathname);
      case 'DELETE':
        return handleDelete(request, env, pathname);
      default:
        return new Response('Method Not Allowed', { status: 405 });
    }
  }
};
