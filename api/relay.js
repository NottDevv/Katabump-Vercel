import { Readable } from 'node:stream';

const SERVERS = {
  jabi83: { user: 'Jabi83', host: '51.75.118.75', port: '20000' },
  jabi7: { user: 'Jabi7', host: '193.70.34.27', port: '20278' },  
  meti: { user: 'Meti', host: '51.75.118.169', port: '20359' },
  masi: { user: 'Masi', host: '51.68.34.78', port: '20051' },
  f72: { user: 'F72', host: '51.75.118.79', port: '20353' },
  reza: { user: 'Reza', host: '51.75.118.17', port: '20229' },
  f38: { user: 'F38', host: '51.75.118.165', port: '20126' }
};

const SERVER_COOKIE = 'notdev_relay_server';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function findServerByKey(key) {
  if (!key) return null;
  return SERVERS[String(key).trim().toLowerCase()] || null;
}

function findServerByUser(username) {
  if (!username) return null;
  const wanted = String(username).trim().toLowerCase();
  return Object.values(SERVERS).find(server => server.user.toLowerCase() === wanted) || null;
}

function getServerKey(server) {
  for (const [key, value] of Object.entries(SERVERS)) {
    if (value === server) return key;
  }
  return '';
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

function getServer(request) {
  const url = new URL(request.url);

  const adminMatch = url.pathname.match(/^\/admin\/([^/]+)(?:\/|$)/i);
  if (adminMatch) {
    const adminServer = findServerByKey(adminMatch[1]) || findServerByUser(adminMatch[1]);
    if (adminServer) return adminServer;
  }

  const byKey = findServerByKey(url.searchParams.get('server'));
  if (byKey) return byKey;

  const byUser = findServerByUser(url.searchParams.get('user'));
  if (byUser) return byUser;

  return findServerByKey(getCookie(request, SERVER_COOKIE));
}

function upstreamOrigin(server) {
  return `http://${server.host}:${server.port}`;
}

function relayOrigin(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
}

function buildCookie(serverKey) {
  return `${SERVER_COOKIE}=${encodeURIComponent(serverKey)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
}

function rewriteUpstreamCookie(cookie, serverKey) {
  if (!cookie) return cookie;
  let result = cookie
    .replace(/;\s*Domain=[^;]+/ig, '')
    .replace(/;\s*Path=[^;]*/ig, '; Path=/');

  result = result.replace(/^admin_session=/i, `notdev_${serverKey}_admin_session=`);
  result = result.replace(/^user_sess_([^=;]+)=/i, `notdev_${serverKey}_user_sess_$1=`);
  return result;
}

function restoreUpstreamCookieHeader(cookieHeader, serverKey) {
  if (!cookieHeader) return '';
  return cookieHeader
    .replace(new RegExp(`notdev_${serverKey}_admin_session=`, 'g'), 'admin_session=')
    .replace(new RegExp(`notdev_${serverKey}_user_sess_`, 'g'), 'user_sess_');
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function copyResponseHeaders(upstreamResponse, serverKey) {
  const headers = new Headers();
  const skip = new Set([
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
    'set-cookie',
    'content-encoding'
  ]);

  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (!skip.has(key.toLowerCase())) headers.set(key, value);
  }

  for (const cookie of getSetCookies(upstreamResponse.headers)) {
    headers.append('set-cookie', rewriteUpstreamCookie(cookie, serverKey));
  }

  headers.set('cache-control', 'no-store');
  headers.set('access-control-allow-origin', '*');
  return headers;
}

function rewriteLocation(location, server, request) {
  if (!location) return location;

  const relay = relayOrigin(request);
  const origin = upstreamOrigin(server);
  const key = getServerKey(server);

  if (location.startsWith(origin)) {
    location = relay + location.slice(origin.length);
  }

  try {
    const parsed = new URL(location, relay);
    if (parsed.pathname === '/admin' || parsed.pathname.startsWith('/admin/')) {
      const suffix = parsed.pathname.slice('/admin'.length);
      parsed.pathname = `/admin/${key}${suffix}`;
      return parsed.toString();
    }
  } catch (_) {}

  return location;
}

function getRelayCore(searchParams, fallback = 'xray') {
  const allowed = new Set(['xray', 'singbox', 'mihomo']);
  const values = searchParams.getAll('core');
  for (let i = values.length - 1; i >= 0; i--) {
    const core = String(values[i] || '').trim().toLowerCase();
    if (allowed.has(core)) return core;
  }
  return fallback;
}

function getCoreFromSubscriptionPath(pathname, fallback = 'xray') {
  const match = String(pathname || '').match(/^\/sub\/(xray|singbox|mihomo)\/?$/i);
  return match ? match[1].toLowerCase() : fallback;
}

function isSubscriptionPath(pathname) {
  return pathname === '/sub' || pathname === '/sub/' || /^\/sub\/(xray|singbox|mihomo)\/?$/i.test(pathname);
}

function rewriteSubscriptionUrl(rawUrl, subscriptionBase, fallbackCore = 'xray') {
  try {
    const parsed = new URL(rawUrl);
    if (!isSubscriptionPath(parsed.pathname)) return rawUrl;
    const pathCore = getCoreFromSubscriptionPath(parsed.pathname, '');
    const core = getRelayCore(parsed.searchParams, pathCore || fallbackCore);
    const user = (parsed.searchParams.get('user') || '').trim();
    const server = (parsed.searchParams.get('server') || '').trim();
    const base = user
      ? `${relayOriginFromBase(subscriptionBase)}/sub?server=${encodeURIComponent(server || getServerUserFromSubscriptionBase(subscriptionBase))}&user=${encodeURIComponent(user)}`
      : subscriptionBase;
    return `${base}&core=${encodeURIComponent(core)}`;
  } catch (_) {
    return rawUrl;
  }
}

function getServerUserFromSubscriptionBase(subscriptionBase) {
  try {
    const parsed = new URL(subscriptionBase);
    return (parsed.searchParams.get('server') || '').trim();
  } catch (_) {
    return '';
  }
}

function relayOriginFromBase(subscriptionBase) {
  try {
    const parsed = new URL(subscriptionBase);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return subscriptionBase.replace(/\/sub\?.*$/i, '');
  }
}

function rewriteHtml(body, server, request) {
  const relay = relayOrigin(request);
  const origin = upstreamOrigin(server);
  const key = getServerKey(server);
  const requestUrl = new URL(request.url);
  const requestedUser = (requestUrl.searchParams.get('user') || '').trim();
  const subscriptionUser = requestedUser || server.user;
  const subscriptionServer = server.user;
  const subscriptionBase = `${relay}/sub?server=${encodeURIComponent(subscriptionServer)}&user=${encodeURIComponent(subscriptionUser)}`;

  // Rewrite every upstream origin we can see, including panels that use MY_DOMAIN
  // instead of the incoming Host header when generating subscription URLs.
  body = body.split(origin).join(relay);

  // Rewrite the panel's runtime base URL first. It must NOT contain a core value;
  // selectCore() appends exactly one core parameter when the user chooses a core.
  body = body.replace(
    /const\s+baseSubscriptionUrl\s*=\s*[^;]+;/i,
    `const baseSubscriptionUrl = ${JSON.stringify(subscriptionBase)};`
  );

  // Rewrite absolute subscription URLs and collapse duplicate core parameters.
  body = body.replace(
    /https?:\/\/[^\s"'<>\\]+\/sub\?[^\s"'<>\\]*/gi,
    match => rewriteSubscriptionUrl(match, subscriptionBase)
  );

  // Rewrite relative subscription URLs and collapse duplicate core parameters.
  body = body.replace(
    /((?:href|data-link|data-url|src)\s*=\s*["'])(\/sub(?:\/(?:xray|singbox|mihomo))?\/?(?:\?[^"']*)?)(["'])/gi,
    (_, prefix, value, suffix) => {
      const rewritten = rewriteSubscriptionUrl(new URL(value, relay).toString(), subscriptionBase);
      return `${prefix}${rewritten}${suffix}`;
    }
  );

  // Rewrite encoded data-link/data-url subscription values.
  body = body.replace(
    /((?:data-link|data-url)\s*=\s*["'])([^"']+)(["'])/gi,
    (_, prefix, encodedValue, suffix) => {
      try {
        const decoded = decodeURIComponent(encodedValue);
        const relaySub = rewriteSubscriptionUrl(decoded, subscriptionBase);
        if (relaySub !== decoded) {
          return `${prefix}${encodeURIComponent(relaySub)}${suffix}`;
        }
      } catch (_) {}
      return `${prefix}${encodedValue}${suffix}`;
    }
  );

  // The URL-rewrite passes above intentionally add a visible default core to
  // rendered subscription links, but never to the JavaScript base URL.
  body = body.replace(
    /const\s+baseSubscriptionUrl\s*=\s*[^;]+;/i,
    `const baseSubscriptionUrl = ${JSON.stringify(subscriptionBase)};`
  );

  // Keep User Dashboard links scoped to the selected Deno server.
  body = body.replace(
    /((?:href|data-link|data-url|src)\s*=\s*[\"'])([^\"']*\/configs\?[^\"']*)([\"'])/gi,
    (_, prefix, value, suffix) => {
      try {
        const parsed = new URL(value, relay);
        if (parsed.pathname !== '/configs') return `${prefix}${value}${suffix}`;
        const user = (parsed.searchParams.get('user') || requestedUser || server.user).trim();
        const params = new URLSearchParams();
        params.set('server', subscriptionServer);
        params.set('user', user);
        for (const [key, value] of parsed.searchParams.entries()) {
          if (key === 'server' || key === 'user') continue;
          params.append(key, value);
        }
        return `${prefix}${parsed.pathname}?${params.toString()}${suffix}`;
      } catch (_) {
        return `${prefix}${value}${suffix}`;
      }
    }
  );

  // Keep JavaScript-generated /configs URLs scoped to the selected Deno server.
  body = body.replace(
    /(['"`])\/configs\?([^'"`\s<>]+)/gi,
    (_, quote, query) => {
      try {
        const parsed = new URL(`${relay}/configs?${query}`);
        const user = (parsed.searchParams.get('user') || requestedUser || server.user).trim();
        const params = new URLSearchParams();
        params.set('server', subscriptionServer);
        params.set('user', user);
        for (const [key, value] of parsed.searchParams.entries()) {
          if (key === 'server' || key === 'user') continue;
          params.append(key, value);
        }
        return `${quote}/configs?${params.toString()}`;
      } catch (_) {
        return `${quote}/configs?${query}`;
      }
    }
  );

  // Keep all admin navigation/actions on the selected Deno admin path.
  body = body.replace(
    /(["'`])\/admin(?=\/|["'`])/g,
    (_, quote) => `${quote}/admin/${key}`
  );

  return body;
}

function getAdminUpstreamPath(pathname, server) {
  const key = getServerKey(server);
  const prefix = `/admin/${key}`;

  if (pathname === prefix || pathname === `${prefix}/`) return '/admin';
  if (pathname.startsWith(`${prefix}/`)) return `/admin${pathname.slice(prefix.length)}`;
  return pathname;
}

function buildUpstreamUrl(request, server) {
  const url = new URL(request.url);
  let pathname = url.pathname;

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    pathname = getAdminUpstreamPath(pathname, server);
  }

  const upstream = new URL(pathname + url.search, upstreamOrigin(server));
  upstream.searchParams.delete('server');

  if (isSubscriptionPath(pathname)) {
    const user = (url.searchParams.get('user') || server.user || '').trim();
    const pathCore = getCoreFromSubscriptionPath(pathname, '');
    const core = getRelayCore(url.searchParams, pathCore || 'xray');
    upstream.pathname = '/sub';
    upstream.searchParams.set('user', user);
    upstream.searchParams.delete('core');
    upstream.searchParams.set('core', core);
  }

  return upstream;
}

function getRequestBody(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  return request.body;
}

async function proxy(request, server) {
  const upstream = buildUpstreamUrl(request, server);
  const serverKey = getServerKey(server);
  const upstreamBase = upstreamOrigin(server);

  const headers = new Headers();
  const forwardHeaders = [
    'accept',
    'accept-language',
    'authorization',
    'content-type',
    'user-agent',
    'x-requested-with'
  ];

  for (const name of forwardHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const incomingCookie = restoreUpstreamCookieHeader(request.headers.get('cookie') || '', serverKey);
  if (incomingCookie) headers.set('cookie', incomingCookie);

  // The Node panel validates Origin/Referer for admin state-changing requests.
  // Make the forwarded request appear same-origin to the upstream panel.
  headers.set('host', `${server.host}:${server.port}`);
  headers.set('origin', upstreamBase);
  headers.set('referer', `${upstreamBase}${upstream.pathname}`);

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstream, {
      method: request.method,
      headers,
      body: getRequestBody(request),
      duplex: 'half',
      redirect: 'manual'
    });
  } catch (error) {
    return errorResponse(`Unable to connect to upstream panel: ${error.message}`, 502);
  }

  const responseHeaders = copyResponseHeaders(upstreamResponse, serverKey);

  // Keep the selected Core visible to the client and make debugging relay
  // routing straightforward. The upstream panel also receives ?core=...
  // in buildUpstreamUrl().
  if (upstream.pathname === '/sub' || upstream.pathname === '/sub/') {
    const core = (upstream.searchParams.get('core') || 'xray').toLowerCase();
    responseHeaders.set('X-NotDev-Subscription-Core', ['xray', 'singbox', 'mihomo'].includes(core) ? core : 'xray');
  }

  const location = upstreamResponse.headers.get('location');
  if (location) responseHeaders.set('location', rewriteLocation(location, server, request));

  const contentType = upstreamResponse.headers.get('content-type') || '';
  let body = upstreamResponse.body;

  if (contentType.toLowerCase().includes('text/html')) {
    body = rewriteHtml(await upstreamResponse.text(), server, request);
    responseHeaders.set('content-type', contentType);
  }

  responseHeaders.append('set-cookie', buildCookie(serverKey));

  return new Response(body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}

async function handle(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': '*',
        'access-control-max-age': '86400'
      }
    });
  }

  if (url.pathname === '/health') {
    return jsonResponse({ ok: true, service: 'NotDev Relay', status: 'online' });
  }

  const server = getServer(request);

  if (!server) {
    return errorResponse('Missing server. Open /configs?server=SERVER&user=USERNAME or /admin/USERNAME first.', 400);
  }

  return proxy(request, server);
}


// Vercel Node.js function adapter. All routing/proxy logic above is shared with Deno.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host || 'localhost';
    const forwardedProto = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) || 'https';
    const incomingUrl = new URL(`${proto}://${host}${req.url || '/'}`);
    // vercel.json carries the original path through __path while rewriting all routes.
    const originalPath = incomingUrl.searchParams.get('__path');
    incomingUrl.searchParams.delete('__path');
    const path = originalPath && originalPath.startsWith('/') ? originalPath : incomingUrl.pathname;
    const url = `${proto}://${host}${path}${incomingUrl.search}`;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) headers.set(name, value.join(', '));
      else if (value !== undefined) headers.set(name, String(value));
    }

    const method = String(req.method || 'GET').toUpperCase();
    const requestInit = { method, headers, redirect: 'manual' };
    if (method !== 'GET' && method !== 'HEAD') {
      requestInit.body = Readable.toWeb(req);
      requestInit.duplex = 'half';
    }
    const request = new Request(url, requestInit);
    const response = await handle(request);

    const outgoingHeaders = {};
    for (const [name, value] of response.headers.entries()) {
      if (name.toLowerCase() !== 'set-cookie') outgoingHeaders[name] = value;
    }
    if (typeof response.headers.getSetCookie === 'function') {
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoingHeaders['set-cookie'] = cookies;
    } else {
      const cookie = response.headers.get('set-cookie');
      if (cookie) outgoingHeaders['set-cookie'] = cookie;
    }
    res.writeHead(response.status, outgoingHeaders);
    if (!response.body || method === 'HEAD') {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: `Relay runtime error: ${error.message}` }));
  }
}
