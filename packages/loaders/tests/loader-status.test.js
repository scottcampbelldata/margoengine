// KB-LOADER-STATUS1: a refused request threw LoaderError code 'fetch' with the HTTP status only in its message, so a
// caller could not tell a 403, a 429 or a 503 (with its Retry-After) from a network failure without parsing text.
// LoaderError now carries `status`, and `retryAfter` in seconds when the answer sent Retry-After (RFC 9110 10.2.3:
// delay-seconds or an HTTP-date).
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError, fetchBytes, fetchResource } from '../dist/index.js';
import { resolveFromURL } from '../dist/ldraw.js';

const answer =
  (status, headers = {}) =>
  async () =>
    new Response(status === 204 ? null : 'no', { status, headers });
const caught = async (promise) => {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LoaderError, String(error));
    return error;
  }
  assert.fail('expected a LoaderError');
};

test('a refused request carries its HTTP status and Retry-After as fields', async () => {
  const forbidden = await caught(fetchBytes('https://a.test/x', { fetch: answer(403) }));
  assert.equal(forbidden.code, 'fetch');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.retryAfter, undefined);
  assert.match(forbidden.message, /returned HTTP 403/);

  const limited = await caught(fetchResource('https://a.test/x', { fetch: answer(429, { 'retry-after': '120' }) }));
  assert.deepEqual([limited.code, limited.status, limited.retryAfter], ['fetch', 429, 120]);

  // An HTTP-date counts the seconds from now to it, rounded up; a date already past is 0.
  const later = new Date(Date.now() + 90_500).toUTCString(),
    busy = await caught(fetchResource('https://a.test/x', { fetch: answer(503, { 'retry-after': later }) }));
  assert.equal(busy.status, 503);
  assert.ok(busy.retryAfter >= 88 && busy.retryAfter <= 91, String(busy.retryAfter));
  const past = await caught(
    fetchResource('https://a.test/x', { fetch: answer(503, { 'retry-after': 'Sun, 06 Nov 1994 08:49:37 GMT' }) }),
  );
  assert.equal(past.retryAfter, 0);
  // An unreadable value is left out rather than guessed.
  const odd = await caught(fetchResource('https://a.test/x', { fetch: answer(503, { 'retry-after': 'soon' }) }));
  assert.deepEqual([odd.status, odd.retryAfter], [503, undefined]);
});

test('a redirect with no Location carries its status; network failures and parse errors carry none', async () => {
  const lost = await caught(fetchResource('https://a.test/x', { fetch: answer(302), maxRedirects: 3 }));
  assert.deepEqual([lost.code, lost.status], ['fetch', 302]);
  const down = await caught(
    fetchBytes('https://a.test/x', {
      fetch: async () => {
        throw new Error('connection reset');
      },
    }),
  );
  assert.deepEqual([down.code, down.status, down.retryAfter], ['fetch', undefined, undefined]);
  assert.ok(!('status' in down) && !('retryAfter' in down), 'no own fields when there was no answer');
  assert.equal(new LoaderError('stl', 'syntax', 'bad').status, undefined);
});

test('the LDraw URL resolver passes the status of a missing part on', async () => {
  const error = await caught(resolveFromURL('https://a.test/ldraw/', { fetch: answer(404) })('parts/3001.dat'));
  assert.deepEqual([error.code, error.status], ['unsupported', 404]);
});
