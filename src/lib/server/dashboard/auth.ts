import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_ERROR = 'Incorrect username or password.';

export interface Login {
  readonly username: string;
  readonly password: string;
  readonly sessionKey: Uint8Array;
}

export function loginCredentials(username: string, password: string, secret: string): Login | null {
  if (Array.from(secret).length < 32) return null;

  return { username, password, sessionKey: createHmac('sha256', secret).update('jmp-digest-view-session-v1').digest() };
}

export type DashboardScheme = "http" | "https";

export interface ServeIdentity {
  readonly origin: string;
  readonly host: string;
  readonly owner: string;
}

export function serveIdentity(origin: string, owner: string): ServeIdentity | null {
  const url = URL.parse(origin);
  const dns = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/;

  if (url === null || url.origin !== origin || url.protocol !== "https:" || url.hostname.length > 253 || !dns.test(url.hostname)
    || owner.length === 0 || owner.length > 254 || /[^!-~]|,/.test(owner)) return null;

  return { origin, host: url.host, owner };
}

const proxyHeaders = [
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip",
  "tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-headers-info",
];

export function isProxyRequest(headers: Headers): boolean {
  return proxyHeaders.some((name) => headers.has(name));
}

export function csrfWriteAuthorized(request: Request, csrf: string, scheme: DashboardScheme): boolean {
  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const token = request.headers.get("x-csrf-token");

  return host !== null && origin?.toLowerCase() === `${scheme}://${host.toLowerCase()}`
    && token !== null && /^[0-9a-f]{64}$/.test(token) && equalBytes(Buffer.from(token), Buffer.from(csrf));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  // Compare fixed-size digests so different UTF-8 lengths do not short-circuit.
  const key = 'jmp-credential-comparison-v1';

  return timingSafeEqual(createHmac('sha256', key).update(a).digest(), createHmac('sha256', key).update(b).digest());
}

export function credentialsMatch(login: Login, username: string, password: string): boolean {
  const userOk = equalBytes(Buffer.from(username), Buffer.from(login.username));
  const passwordOk = equalBytes(Buffer.from(password), Buffer.from(login.password));

  return userOk && passwordOk;
}

function signature(key: Uint8Array, expires: string): string {
  return createHmac('sha256', key).update(`session-expiry:${expires}`).digest('hex');
}

export function signSession(key: Uint8Array, expiresAt: number): string {
  const expires = String(expiresAt);

  return `${expires}.${signature(key, expires)}`;
}

export function sessionIsValid(value: string, key: Uint8Array, now: number): boolean {
  const match = /^([0-9]{1,12})\.([0-9a-f]{64})$/.exec(value);

  if (!match || match[0] !== value) return false;
  const expires = match[1]!;

  return equalBytes(Buffer.from(match[2]!), Buffer.from(signature(key, expires))) && Number(expires) > now;
}

// Feedback requires one unambiguous session, even if the page gate accepted a cookie.
export function feedbackSession(request: Request, login: Login | null, now: number): string | undefined {
  if (login === null) return undefined;
  const sessions = [];

  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=');

    if (separator >= 0 && part.slice(0, separator).trim() === 'jmp_session') sessions.push(part.slice(separator + 1).trim());
  }

  const value = sessions[0];

  if (sessions.length !== 1 || value === undefined || !sessionIsValid(value, login.sessionKey, now)) return undefined;

  return createHmac('sha256', login.sessionKey).update('shortlist-feedback-csrf-v1\0' + value, 'ascii').digest('hex');
}

export function sessionCookie(value: string, maxAge: number): string {
  return `jmp_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function safeNext(value: string | null | undefined): string {
  if (!value || value.length > 512 || !/^[\x20-\x7e]+$/.test(value) || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /%2f|%5c/i.test(value)) return '/';

  return value;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; }
form { max-width: 320px; }
label { display: block; margin-bottom: 12px; }
input { display: block; width: 100%; box-sizing: border-box; font-size: 16px; padding: 8px; margin-top: 4px; }
button { font-size: 16px; padding: 8px 16px; }
.error { color: #b00020; }
</style>
<h1>Sign in</h1>
ERROR_SLOT
<form method="post" action="">
<input type="hidden" name="next" value="NEXT_SLOT">
<label>Username<input name="username" autocomplete="username" autocapitalize="none"></label>
<label>Password<input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button>
</form>
`;

export function loginPage(nextPath: string, error?: string | null): Uint8Array {
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';

  return Buffer.from(LOGIN_PAGE.replace('ERROR_SLOT', () => errorHtml).replace('NEXT_SLOT', () => escapeHtml(nextPath)));
}

export function isLoopback(address: string): boolean {
  const version = isIP(address);

  if (version === 4) return address.split('.')[0] === '127';

  if (version !== 6 || address.includes('%')) return false;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);

  if (canonical === '::1') return true;
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(canonical);

  return mapped !== null && (parseInt(mapped[1]!, 16) >> 8) === 127;
}

export function clientAddress(mode: 'local' | 'railway', socketAddress: string, headers: Headers): string {
  return mode === 'railway' ? (headers.get('x-real-ip') ?? '') : socketAddress;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ADDRESSES = 10_000;

export interface LoginLimiter {
  isLimited(address: string, now: number): boolean;
  recordFailure(address: string, now: number): void;
  clear(address: string): void;
}

// At capacity, unknown addresses are denied until an existing window expires.
export function createLoginLimiter(): LoginLimiter {
  const failures = new Map<string, number[]>();

  function prune(now: number): void {
    for (const [address, times] of failures) {
      const active = times.filter((time) => time > now - WINDOW_MS);

      if (active.length) failures.set(address, active); else failures.delete(address);
    }
  }

  return {
    isLimited(address, now) {
      prune(now);

      return (failures.get(address)?.length ?? (failures.size >= MAX_ADDRESSES ? 10 : 0)) >= 10;
    },
    recordFailure(address, now) {
      prune(now);
      const times = failures.get(address);

      if (times) { if (times.length < 10) times.push(now); }
      else if (failures.size < MAX_ADDRESSES) failures.set(address, [now]);
    },
    clear(address) { failures.delete(address); },
  };
}
