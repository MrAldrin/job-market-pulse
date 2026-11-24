import { afterEach, expect, test, vi } from 'vitest';
import { loadFeedback, saveFeedback } from '../../src/lib/feedback';

const csrf = 'a'.repeat(64);
const state = { starred: true, reaction: 'up' };
const payload = { csrf_token: csrf, listing_ids: ['job-1'], states: { 'job-1': state } };

function respond(body: string, status = 200): void {
  vi.stubGlobal('window', { location: new URL('http://localhost/app/') });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })));
}

afterEach(() => vi.unstubAllGlobals());

test('decodes exact feedback keys and maps each listed state', async () => {
  respond(JSON.stringify(payload));
  const loaded = await loadFeedback('/app/');
  expect(loaded.available).toBe(true);
  expect(loaded.csrf).toBe(csrf);
  expect(loaded.states).toEqual(new Map([['job-1', state]]));
});

test.each([
  'not json',
  JSON.stringify({ ...payload, extra: true }),
  JSON.stringify({ ...payload, csrf_token: 'invalid' }),
  JSON.stringify({ ...payload, listing_ids: ['invalid id'] }),
  JSON.stringify({ ...payload, listing_ids: ['job-1', 'job-1'] }),
  JSON.stringify({ ...payload, listing_ids: ['job-2'] }),
  JSON.stringify({ ...payload, listing_ids: [] }),
  JSON.stringify({ ...payload, states: { 'job-1': { ...state, extra: true } } }),
  JSON.stringify({ ...payload, states: { 'job-1': { starred: 1, reaction: 'up' } } }),
  JSON.stringify({ ...payload, states: { 'job-1': { starred: true, reaction: 'other' } } }),
  JSON.stringify({ ...payload, states: { 'invalid id': state } }),
])('rejects malformed feedback without leaking parsing detail: %s', async (body) => {
  respond(body);
  await expect(loadFeedback('/app/')).rejects.toThrow('Invalid feedback response.');
});

test.each([401, 404, 303])('keeps feedback optional for status %s', async (status) => {
  respond('', status);
  expect(await loadFeedback('/app/')).toEqual({ available: false, csrf: '', states: new Map() });
});

test('decodes saved state and retains same-origin POST/CSRF transport', async () => {
  respond(JSON.stringify({ state }));
  expect(await saveFeedback('job-1', { field: 'starred', value: true }, csrf, '/app/')).toEqual(state);
  expect(fetch).toHaveBeenCalledWith('http://localhost/app/shortlist-feedback', {
    credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'manual',
    method: 'POST', referrerPolicy: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify({ listing_id: 'job-1', field: 'starred', value: true }),
  });
});

test.each([
  { state, extra: true },
  { state: { ...state, extra: true } },
  { state: { starred: true } },
])('rejects malformed save responses: %s', async (body) => {
  respond(JSON.stringify(body));
  await expect(saveFeedback('job-1', { field: 'reaction', value: null }, csrf, '/app/'))
    .rejects.toThrow('Invalid feedback response.');
});

test('rejects cross-origin endpoints and invalid IDs before transport', async () => {
  respond('{}');
  await expect(loadFeedback('https://example.invalid/')).rejects.toThrow('Feedback must use the same origin.');
  await expect(saveFeedback('invalid id', { field: 'starred', value: true }, csrf)).rejects.toThrow('Invalid feedback change.');
  expect(fetch).not.toHaveBeenCalled();
});
