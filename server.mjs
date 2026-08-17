// Self-hosted host process for the SpeakHub API and static pages.
//
// Why this file exists
// -------------------
// The API handlers in api/ and lib/api/ are plain web handlers:
//   export default { async fetch(request: Request): Promise<Response> }
// They use no Vercel-specific API at all - no @vercel/*, no process.env.VERCEL,
// no waitUntil, no `export const config`. Node 22 provides Request, Response,
// URL and crypto globally, so the exact same files run here unchanged.
//
// That is the whole point: during the migration described in
// docs/MIGRATION-OFF-SUPABASE.md this process runs the *current* handlers
// against the *current* database, so the transport layer can be proven before
// any data-access code is touched.
//
// The route table below mirrors vercel.json. CI asserts the two agree, so a
// rewrite added there without a route here fails the build.

import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

// A placement audio upload is capped at 12MB by api/admin.js; 25MB leaves room
// for multipart overhead while still refusing an obvious abuse attempt before
// any handler allocates.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 25 * 1024 * 1024);

// --- API routes -------------------------------------------------------------
// Path -> module to import, plus the query params vercel.json injects.
// Keep in sync with vercel.json; .github/workflows/ci.yml enforces it.

const API_ROUTES = new Map([
  ['/api/admin', { module: './api/admin.js' }],
  ['/api/sessions', { module: './api/sessions.js' }],
  ['/api/teacher', { module: './api/teacher.js' }],
  ['/api/topics', { module: './api/topics.js' }],
  ['/api/vocabulary', { module: './api/vocabulary.js' }],
  ['/api/router', { module: './api/router.js' }],

  // vercel.json rewrites: pretty path -> router with group/action.
  ['/api/bookings/create', { module: './api/router.js', group: 'bookings', action: 'create' }],
  ['/api/bookings/reschedule', { module: './api/router.js', group: 'bookings', action: 'reschedule' }],
  ['/api/customers/history', { module: './api/router.js', group: 'customers', action: 'history' }],
  ['/api/customers/login', { module: './api/router.js', group: 'customers', action: 'login' }],
  ['/api/orders/cancel', { module: './api/router.js', group: 'orders', action: 'cancel' }],
  ['/api/orders/status', { module: './api/router.js', group: 'orders', action: 'status' }],
  ['/api/payos/create', { module: './api/router.js', group: 'payos', action: 'create' }],
  ['/api/payos/reconcile', { module: './api/router.js', group: 'payos', action: 'reconcile' }],
  ['/api/payos/webhook', { module: './api/router.js', group: 'payos', action: 'webhook' }]
]);

// vercel.json rewrites for pages.
const PAGE_REWRITES = new Map([
  ['/', '/index.html'],
  ['/teacher', '/teacher/index.html'],
  ['/teacher/', '/teacher/index.html'],
  ['/admin', '/admin.html']
]);

const MIME = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2'
}));

// --- handler loading --------------------------------------------------------
// Eager, at boot, on purpose. Every handler builds its Supabase client at module
// scope, so a missing environment variable throws on import. Failing at boot is
// correct: a half-loaded process that 500s per request is worse than one that
// refuses to start.

const handlers = new Map();

async function loadHandlers() {
  const modules = new Set([...API_ROUTES.values()].map((r) => r.module));
  const failures = [];

  for (const spec of modules) {
    try {
      const mod = await import(spec);
      if (typeof mod.default?.fetch !== 'function') {
        failures.push(`${spec}: default export has no fetch()`);
        continue;
      }
      handlers.set(spec, mod.default);
    } catch (error) {
      failures.push(`${spec}: ${error?.message || error}`);
    }
  }

  if (failures.length) {
    for (const line of failures) console.error(`handler load failed - ${line}`);
    throw new Error(`${failures.length} handler module(s) failed to load`);
  }
}

// --- node:http <-> web Request/Response ------------------------------------

function toWebRequest(req, origin) {
  const url = new URL(req.url, origin);
  const route = API_ROUTES.get(url.pathname);

  // Apply the query parameters vercel.json injects via its rewrite destination.
  // Client-supplied values never override them: on Vercel the destination wins.
  if (route?.group) url.searchParams.set('group', route.group);
  if (route?.action) url.searchParams.set('action', route.action);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }

  // Size-cap the body with a counting Transform rather than a 'data' listener on
  // req: attaching 'data' puts the socket in flowing mode and would race the
  // Request that is about to consume it, silently truncating uploads.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  if (!hasBody) {
    return new Request(url, { method: req.method, headers });
  }

  let seen = 0;
  const limiter = new Transform({
    transform(chunk, _enc, done) {
      seen += chunk.length;
      if (seen > MAX_BODY_BYTES) {
        done(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413 }));
        return;
      }
      done(null, chunk);
    }
  });

  pipeline(req, limiter).catch(() => { /* surfaced by the handler's body read */ });

  return new Request(url, {
    method: req.method,
    headers,
    body: Readable.toWeb(limiter),
    duplex: 'half'
  });
}

async function sendWebResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers) headers[key] = value;
  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  await pipeline(Readable.fromWeb(response.body), res);
}

// --- static files -----------------------------------------------------------
//
// Vercel decides what is public from the build output. A self-hosted process
// serves a working copy, so the repository root contains files that must never
// reach a browser: server code, dependency manifests, and - if an operator ever
// drops one next to the app - .env.local. Denial is explicit, not incidental.

const DENY_DIRS = ['api', 'lib', 'node_modules', 'docs', '.github', '.git', 'db'];
const DENY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'vercel.json',
  'server.mjs',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md'
]);

function resolveStatic(pathname) {
  const rewritten = PAGE_REWRITES.get(pathname) || pathname;

  let decoded;
  try {
    decoded = decodeURIComponent(rewritten);
  } catch {
    return null; // malformed percent-encoding
  }

  if (decoded.includes('\0')) return null;

  const clean = normalize(decoded).replace(/^\/+/, '');
  const segments = clean.split('/').filter(Boolean);

  // Any dotfile at any depth: .env.local, .git/config, .npmrc.
  if (segments.some((s) => s.startsWith('.') && s !== '.well-known')) return null;
  if (segments.length && DENY_DIRS.includes(segments[0])) return null;
  if (segments.length === 1 && DENY_FILES.has(segments[0])) return null;
  if (segments.at(-1)?.endsWith('.mjs')) return null;

  const abs = join(ROOT, clean);

  // Refuse anything that escapes the repository root.
  if (!abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return null;
  return abs;
}

async function serveStatic(req, res, pathname) {
  const abs = resolveStatic(pathname);
  if (!abs) return sendPlain(res, 403, 'Forbidden');

  let info;
  try {
    info = await stat(abs);
  } catch {
    return sendPlain(res, 404, 'Not found');
  }
  if (!info.isFile()) return sendPlain(res, 404, 'Not found');

  const ext = extname(abs).toLowerCase();
  const type = MIME.get(ext) || 'application/octet-stream';

  // HTML must never be cached: a stale admin.html against a new API is a
  // support incident. Assets are content-addressed by filename only, so an
  // hour is the honest ceiling.
  const cache = ext === '.html'
    ? 'no-store, must-revalidate'
    : 'public, max-age=3600';

  res.writeHead(200, {
    'content-type': type,
    'content-length': String(info.size),
    'cache-control': cache,
    'x-content-type-options': 'nosniff'
  });

  if (req.method === 'HEAD') return res.end();
  return pipeline(createReadStream(abs), res);
}

function sendPlain(res, status, message) {
  const body = `${message}\n`;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body))
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store'
  });
  res.end(body);
}

// --- request loop -----------------------------------------------------------

// Cheap pre-check on the declared length. The real enforcement is the counting
// Transform in toWebRequest(), which also catches a lying Content-Length.
function rejectOversizedDeclaration(req, res) {
  if (Number(req.headers['content-length'] || 0) <= MAX_BODY_BYTES) return false;
  sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', limit: MAX_BODY_BYTES });
  req.destroy();
  return true;
}

async function handle(req, res) {
  const origin = `http://${req.headers.host || `${HOST}:${PORT}`}`;
  const { pathname } = new URL(req.url, origin);

  if (API_ROUTES.has(pathname)) {
    if (rejectOversizedDeclaration(req, res)) return;

    const { module: spec } = API_ROUTES.get(pathname);
    const handler = handlers.get(spec);

    const request = toWebRequest(req, origin);
    const response = await handler.fetch(request);
    return sendWebResponse(res, response);
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'API_ROUTE_NOT_FOUND', path: pathname });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendPlain(res, 405, 'Method not allowed');
  }

  return serveStatic(req, res, pathname);
}

const server = createServer((req, res) => {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // No query string, no request body, no headers: those carry phone numbers
    // and bearer tokens. Guarded by the PII check in .github/workflows/security.yml.
    const path = req.url?.split('?')[0] || '';
    console.log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });

  handle(req, res).catch((error) => {
    console.error('unhandled request error', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL_ERROR' });
    else res.end();
  });
});

function shutdown(signal) {
  console.log(`${signal} received, draining`);
  server.close(() => process.exit(0));
  // systemd sends SIGKILL after TimeoutStopSec; leave before that so in-flight
  // PayOS webhook processing is not cut mid-write.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await loadHandlers();

server.listen(PORT, HOST, () => {
  console.log(`speakhub server listening on http://${HOST}:${PORT}`);
  console.log(`${API_ROUTES.size} api routes, ${handlers.size} handler modules`);
});
