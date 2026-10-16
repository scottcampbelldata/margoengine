// Checks a deployed margoengine.com against site/dist: every file answers 200 with a non-HTML type (HTML pages
// excepted) and no long-lived cache, and a missing file answers 404 rather than the home page. Retries while a new deployment propagates.
// Usage: node scripts/site-check.mjs [origin]   (default https://margoengine.com)
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const origin = (process.argv[2] ?? 'https://margoengine.com').replace(/\/$/, '');
const root = resolve('site/dist');
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && !entry.name.startsWith('_'))
  .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'));

async function problem(path, expectMissing = false) {
  // Cache-busting query so neither the edge nor an intermediate cache answers from an older deployment.
  const response = await fetch(`${origin}/${encodeURI(path)}?check=${Date.now()}`, { method: 'HEAD' });
  const type = response.headers.get('content-type') ?? '';
  if (expectMissing)
    return response.status === 404 && /no-store/.test(response.headers.get('cache-control') ?? '')
      ? null
      : `${response.status} ${response.headers.get('cache-control')}`;
  if (response.status !== 200) return `status ${response.status}`;
  // The margoengine.com zone's Browser Cache TTL (4 h) overrides _headers; anything longer is a regression.
  const cache = response.headers.get('cache-control') ?? '';
  if (/immutable/.test(cache) || Number(/max-age=(\d+)/.exec(cache)?.[1] ?? 0) > 14400) return `long cache ${cache}`;
  return path.endsWith('.html') === type.startsWith('text/html') ? null : `content-type ${type}`;
}

async function check() {
  const failures = [],
    queue = [...files];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let path; (path = queue.shift()); ) {
        const error = await problem(path).catch((e) => e.message);
        if (error) failures.push(`${path}: ${error}`);
      }
    }),
  );
  const missing = await problem('demos/assets/site-check-missing.js', true);
  if (missing) failures.push(`missing file should be 404 no-store, got ${missing}`);
  return failures;
}

for (let attempt = 1; ; attempt++) {
  const failures = await check();
  if (!failures.length) {
    console.log(`site-check: ${files.length} files OK on ${origin}`);
    break;
  }
  console.error(`site-check attempt ${attempt}: ${failures.length} problems\n  ${failures.slice(0, 20).join('\n  ')}`);
  if (attempt === 6) process.exit(1);
  await new Promise((done) => setTimeout(done, 10_000));
}
