import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { clientAddress, createLoginLimiter, credentialsMatch, isLoopback, loginPage, loginCredentials as makeLogin, safeNext, sessionCookie, sessionIsValid, signSession, SESSION_MAX_AGE_SECONDS } from '../../src/lib/server/dashboard/auth';

const login = makeLogin('å', 'päss', '12345678901234567890123456789012')!;

describe('dashboard auth', () => {
  it('requires a 32 Unicode character secret, and compares both UTF-8 credentials', () => {
    expect(makeLogin('u', 'p', '😀'.repeat(31))).toBeNull();
    expect(makeLogin('u', 'p', '😀'.repeat(32))).not.toBeNull();
    expect(credentialsMatch(login, 'å', 'päss')).toBe(true);
    expect(credentialsMatch(login, 'a', 'päss')).toBe(false);
    expect(credentialsMatch(login, 'å', 'pass')).toBe(false);
  });
  it('matches an independent OpenSSL session vector and enforces expiry and flags', () => {
    expect(Buffer.from(login.sessionKey).toString('hex')).toBe('ff151b87dd978b21921c88ce5fd9672ec32479dcb3d0204c1c8775d59fa39684');
    const value = signSession(login.sessionKey, 1700000000);
    expect(value).toBe('1700000000.b71a4fd9108e7e2c4c06ef9f61a04daf1b38ac1a412c0cde1bb44dd7205e853f');
    expect(sessionIsValid(value, login.sessionKey, 1699999999)).toBe(true);
    expect(sessionIsValid(value, login.sessionKey, 1700000000)).toBe(false);
    expect(sessionIsValid('1234567890123.' + 'a'.repeat(64), login.sessionKey, 0)).toBe(false);
    expect(sessionIsValid(value + 'x', login.sessionKey, 0)).toBe(false);
    expect(sessionCookie(value, SESSION_MAX_AGE_SECONDS)).toBe(`jmp_session=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`);
  });
  it('rejects unsafe redirects and escapes the login form without replacement interpolation', () => {
    for (const path of ['//evil', '/%2Fhost', '/%5c', '/\\evil', '/é', '/\n', 'https://evil', '/' + 'a'.repeat(512)]) expect(safeNext(path)).toBe('/');
    expect(safeNext('/jobs?q=one')).toBe('/jobs?q=one');
    const html = Buffer.from(loginPage('/?$&\'"', '<error>')).toString();
    expect(html).toContain('value="/?$&amp;&#x27;&quot;"');
    expect(html).toContain('<p class="error" role="alert">&lt;error&gt;</p>');
  });
  it('accepts only actual loopback addresses and ignores spoofed local headers', () => {
    for (const address of ['127.0.0.1', '127.255.1.2', '::1', '::ffff:127.0.0.1']) expect(isLoopback(address)).toBe(true);

    for (const address of ['localhost', '127.0.0.1:80', '::2', '::ffff:128.0.0.1', '1.2.3.4', '::1%lo']) expect(isLoopback(address)).toBe(false);
    const headers = new Headers({ 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' });
    expect(clientAddress('local', '8.8.8.8', headers)).toBe('8.8.8.8');
    expect(clientAddress('railway', '8.8.8.8', headers)).toBe('127.0.0.1');
  });
  it('does not let more failures or address resets bypass the active window', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 20 }), (count) => {
      const limiter = createLoginLimiter();

      for (let index = 0; index < count; index++) limiter.recordFailure('192.0.2.1', index * 1000);

      expect(limiter.isLimited('192.0.2.1', 20_000)).toBe(count >= 10);
      expect(limiter.isLimited('192.0.2.2', 20_000)).toBe(false);
      expect(limiter.isLimited('192.0.2.1', 920_000)).toBe(false);
    }), { numRuns: 30 });
  });
  it('limits ten failures per address until the rolling window expires', () => {
    const limiter = createLoginLimiter();

    for (let i = 0; i < 10; i++) { expect(limiter.isLimited('a', i)).toBe(false); limiter.recordFailure('a', i); }

    expect(limiter.isLimited('a', 10)).toBe(true);
    expect(limiter.isLimited('b', 10)).toBe(false);
    expect(limiter.isLimited('a', 900000)).toBe(false);
    limiter.clear('a');
    expect(limiter.isLimited('a', 10)).toBe(false);
  });
});
