import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parseAdminNetworkAllowlist } from '../modules/auth/network-policy.js';

const publicFiles = new Set([
  '/', '/portal', '/portal/', '/portal/index.html', '/portal/app.js',
  '/portal/navigation.js', '/portal/attendance.js', '/portal/security.js', '/portal/styles.css',
  '/panel/attendance-script.js', '/privacy', '/data-deletion',
]);
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originUrl(value, allowInsecure) {
  const url = new URL(value);
  if (!['https:', ...(allowInsecure ? ['http:'] : [])].includes(url.protocol)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || value !== url.origin) throw new TypeError('V2 ingress exige origem exata e HTTPS fora do ensaio local.');
  return url;
}

function upstreamUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Upstream fixo inválido.');
  return url;
}

// Check the raw target, before WHATWG URL/Express or an upstream can normalize it.
export function canonicalIngressPath(target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')
    || /[\\#\u0000-\u0020\u007f]/u.test(target)) return null;
  const path = target.split('?', 1)[0];
  if (/[^\x21-\x7e]|%|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)) return null;
  return path;
}

export function permittedIngressPath(surface, path) {
  if (surface === 'public') return publicFiles.has(path) || /^\/api\/(?:account|app)\/v1(?:\/|$)/u.test(path);
  if (surface === 'admin') return /^\/api\/admin(?:\/|$)/u.test(path)
    || /^\/panel(?:\/|$)/u.test(path) || ['/metrics', '/health/live', '/health/ready'].includes(path);
  return false;
}

function cleanHeaders(headers) {
  const blocked = new Set([...hopHeaders, ...String(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function refuse(response, status) {
  response.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  response.end(status === 502 ? 'Serviço temporariamente indisponível.' : 'Acesso indisponível.');
}

function exactPeers(value) {
  if (String(value).split(',').some(peer => peer.includes('/') && !peer.trim().endsWith('/32'))) {
    throw new TypeError('Peers exigem endereços exatos, sem rede Docker ampla.');
  }
  return parseAdminNetworkAllowlist(value);
}

function forwardedClientIp(request, trustedPeers) {
  const peer = request.socket.remoteAddress;
  if (!trustedPeers.some(matches => matches(peer))) return peer;
  // The explicitly trusted proxy must append the actual connecting client.
  // Earlier entries and RFC Forwarded never establish identity here.
  const header = request.headers['x-forwarded-for'];
  if (typeof header !== 'string') return null;
  const client = header.split(',').at(-1).trim();
  return isIP(client) ? client : null;
}

/** Two independently bound surfaces. No request can select the upstream or peer identity. */
export function createV2Ingress({ surface, origin, upstream, adminPeerAllowlist = '', trustedProxyPeers = '', allowInsecure = false } = {}) {
  if (!['public', 'admin'].includes(surface)) throw new TypeError('Superfície V2 obrigatória.');
  const publicOrigin = originUrl(origin, allowInsecure);
  const target = upstreamUrl(upstream);
  const peers = exactPeers(adminPeerAllowlist);
  const trustedPeers = exactPeers(trustedProxyPeers);
  if (surface === 'admin' && !peers.length) throw new TypeError('Allowlist explícita de peer administrativo obrigatória.');
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const server = createServer((request, response) => {
    const path = canonicalIngressPath(request.url);
    if (!path || request.headers.host !== publicOrigin.host || !permittedIngressPath(surface, path)) return refuse(response, 404);
    if (surface === 'admin' && !peers.some(matches => matches(request.socket.remoteAddress))) return refuse(response, 403);
    const clientIp = forwardedClientIp(request, trustedPeers);
    if (!clientIp) return refuse(response, 400);
    if ((request.headers.origin && request.headers.origin !== publicOrigin.origin)
      || (unsafeMethods.has(request.method) && request.headers.origin !== publicOrigin.origin)) return refuse(response, 403);
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) return refuse(response, 405);
    const headers = cleanHeaders(request.headers);
    for (const key of Object.keys(headers)) {
      if (/^(?:forwarded|x-forwarded-.*|x-real-ip|x-original-url|x-rewrite-url)$/iu.test(key)) delete headers[key];
    }
    headers.host = publicOrigin.host;
    headers['x-forwarded-for'] = clientIp;
    headers['x-real-ip'] = clientIp;
    headers['x-forwarded-host'] = publicOrigin.host;
    headers['x-forwarded-proto'] = publicOrigin.protocol.slice(0, -1);
    const forwarded = send({ hostname: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80),
      method: request.method, path: request.url, headers, timeout: 30_000 }, upstreamResponse => {
      upstreamResponse.on('error', () => response.destroy());
      const output = cleanHeaders(upstreamResponse.headers);
      const cookies = upstreamResponse.headers['set-cookie'] || [];
      // Host-only cookies are mandatory; an invalid upstream must not widen their scope.
      if (cookies.some(cookie => /;\s*domain\s*=/iu.test(cookie)
        || (!allowInsecure && !/;\s*secure(?:;|$)/iu.test(cookie)))) {
        upstreamResponse.resume();
        return refuse(response, 502);
      }
      response.writeHead(upstreamResponse.statusCode, output);
      upstreamResponse.pipe(response);
    });
    forwarded.on('timeout', () => forwarded.destroy());
    forwarded.on('error', () => { if (!response.headersSent) refuse(response, 502); else response.destroy(); });
    request.on('aborted', () => forwarded.destroy());
    response.on('close', () => { if (!response.writableFinished) forwarded.destroy(); });
    request.pipe(forwarded);
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}
