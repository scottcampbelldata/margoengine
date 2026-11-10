import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSource } from '@margoengine/sciviz/stream';
test('SSE preserves caller Accept headers in every HeadersInit form and defaults only when absent', {
  timeout: 1000,
}, async () => {
  for (const headers of [
    undefined,
    { Authorization: 'Bearer example' },
    { Accept: 'text/event-stream;q=1' },
    { accept: 'text/event-stream;q=1' },
    [['aCcEpT', 'text/event-stream;q=1']],
    new Headers({ Accept: 'text/event-stream;q=1' }),
    { Accept: '' },
  ]) {
    const original = new Headers(headers),
      seen = [];
    const events = [];
    for await (const event of eventSource('https://example.invalid/events', {
      request: { headers },
      fetch: async (_url, init) => {
        seen.push(new Headers(init.headers));
        return new Response('data: 42\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      },
    }))
      events.push(event.data);
    assert.deepEqual(events, [42]);
    assert.equal(seen[0].get('accept'), original.has('accept') ? original.get('accept') : 'text/event-stream');
    assert.equal(seen[0].get('authorization'), original.get('authorization'));
    assert.deepEqual([...new Headers(headers)], [...original]);
  }
});
