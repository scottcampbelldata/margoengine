// Vary keys, asset bundles and Expires/Age freshness on a real browser: real Request, Response and headers, real
// crypto.subtle, real IndexedDB and a real server, some of it on a second origin. Driven by scripts/test-browser.js.
import { AssetCache } from '../dist/index.js';
import { AssetBundles } from '../dist/bundles.js';
import { hashBytes } from '../dist/hashed.js';
import { varyKeys } from '../dist/vary.js';

const offlineFetch = () => Promise.reject(new TypeError('offline'));
/** The first byte of a response, or the error's name. */
const first = (promise) =>
  promise.then(
    async (response) => new Uint8Array(await response.arrayBuffer())[0],
    (error) => error.name,
  );

/** Stores variants of one URL, then reads each back from a cache that cannot reach the network. */
export async function varyProof() {
  const name = 'vary-browser';
  let user = 'alice';
  const keys = () => varyKeys({ partition: () => user });
  const online = new AssetCache({ name, keys: keys() });
  const url = new URL('/cache-files/lang', location.href).href;
  const asks = [
    { headers: { 'accept-language': 'en' } },
    { headers: { 'accept-language': 'fr' } },
    { headers: { 'accept-language': 'en', authorization: 'Bearer one' } },
    { headers: { 'accept-language': 'en' }, credentials: 'omit' },
  ];
  const stored = [];
  for (const init of asks) {
    stored.push(await first(online.fetch(url, init)));
    await online.flush();
  }
  const star = await first(online.fetch('/cache-files/star'));
  await online.flush();
  online.dispose();
  const away = new AssetCache({ name, keys: keys(), fetch: offlineFetch });
  const read = [];
  for (const init of asks) read.push(await first(away.fetch(url, init)));
  const unseen = await first(away.fetch(url, { headers: { 'accept-language': 'de' } }));
  const otherAuthorization = await first(
    away.fetch(url, { headers: { 'accept-language': 'en', authorization: 'Bearer two' } }),
  );
  user = 'bob';
  const otherUser = await first(away.fetch(url, asks[0]));
  user = 'alice';
  const again = await first(away.fetch(url, asks[0]));
  const starAway = await first(away.fetch('/cache-files/star'));
  away.dispose();
  return { stored, read, unseen, otherAuthorization, otherUser, again, star, starAway };
}

/** Loads a bundle with its dependency, reads it with no network, refuses wrong bytes and moves to a new release. */
export async function bundleProof(bytes) {
  const name = 'bundle-browser';
  const hash = async (value, length = 100) => hashBytes(new Uint8Array(length).fill(value));
  const manifest = {
    version: '1',
    bundles: {
      shared: { files: { '/cache-files/a': await hash(1) } },
      level: { files: { '/cache-files/chair.glb': bytes }, deps: ['shared'] },
    },
  };
  const cache = new AssetCache({ name });
  const bundles = new AssetBundles(cache, manifest);
  const progress = [];
  await bundles.load('level', { onProgress: ({ loaded, total }) => progress.push([loaded, total]), concurrency: 1 });
  const stored = await cache.usage();
  cache.dispose();
  const away = new AssetCache({ name, fetch: offlineFetch });
  const offline = new AssetBundles(away, manifest);
  const shared = await first(offline.fetch('/cache-files/a'));
  const chair = await hashBytes(await (await offline.fetch('/cache-files/chair.glb')).arrayBuffer());
  away.dispose();
  const next = new AssetCache({ name });
  const release = new AssetBundles(next, manifest);
  const wrong = await new AssetBundles(next, { bundles: { bad: { files: { '/cache-files/b': await hash(9) } } } })
    .load('bad')
    .then(
      () => 'loaded',
      (error) => error.code ?? error.name,
    );
  const update = await release.update({
    version: '2',
    bundles: {
      shared: { files: { '/cache-files/a': await hash(1) } },
      level: { files: { '/cache-files/c': await hash(3) }, deps: ['shared'] },
    },
  });
  await release.load('level');
  await next.flush();
  const after = await next.usage();
  next.dispose();
  return { progress, stored, shared, chair, wrong, update, after };
}

/** Fetches each URL in one cache and again in a new one, so only a response still fresh makes no second request. */
export async function freshnessRound(name, urls, freshness) {
  const cache = new AssetCache({ name, ...(freshness && { freshness }) });
  const out = [];
  for (const url of urls) out.push(await first(cache.fetch(url)));
  await cache.flush();
  cache.dispose();
  return out;
}
