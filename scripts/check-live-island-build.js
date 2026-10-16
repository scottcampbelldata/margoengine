// Read-only comparison of the published island with the current local build.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const pageURL = new URL('https://margoengine.com/gameplay-sandbox/');
const localHTML = resolve('site/dist/gameplay-sandbox/index.html');
const script = (html) => /<script\b[^>]*\bsrc=["']([^"']+\.js)["']/i.exec(html)?.[1];
const info = (bytes) => ({
  raw: bytes.length,
  gzip: gzipSync(bytes).length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
const report = { recordedAt: new Date().toISOString(), readOnly: true, publishedByThisCheck: false };
try {
  const response = await fetch(pageURL, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok, `Live HTML HTTP ${response.status}`);
  const html = await response.text(),
    asset = new URL(script(html), pageURL);
  assert.equal(asset.origin, pageURL.origin, 'Unexpected live script origin');
  const javascript = await fetch(asset, { signal: AbortSignal.timeout(30000) });
  assert.ok(javascript.ok, `Live JavaScript HTTP ${javascript.status}`);
  const live = Buffer.from(await javascript.arrayBuffer());
  const localName = script(await readFile(localHTML, 'utf8'));
  assert.ok(localName, 'Local module entry missing');
  const localPath = resolve(dirname(localHTML), localName),
    local = await readFile(localPath);
  report.live = {
    url: asset.href,
    ...info(live),
    etag: javascript.headers.get('etag'),
    cache: javascript.headers.get('cf-cache-status'),
  };
  report.local = { path: localPath, ...info(local) };
  report.sameEntryBytes = report.live.sha256 === report.local.sha256;
  report.limits =
    'Entry identity only: no FPS, startup, physical-device, deployment-permission or deferred-chunk acceptance.';
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
}
await mkdir('test-results', { recursive: true });
await writeFile('test-results/live-island-build-current.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
