// Download only standard test data. Callers pin a URL, a byte ceiling and the expected digest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readResponse } from '../../packages/shared/loading.js';

/** Fetches a pinned fixture or fails; no HTTP, size or digest failure can turn into a successful skip. */
export async function fetchFixture(url, file, sha256, { fetch: request = fetch, maxBytes = 1 << 20 } = {}) {
  const response = await request(url, { signal: AbortSignal.timeout(90_000) });
  assert.ok(response.ok, `Required fixture ${file}: HTTP ${response.status} from ${url}`);
  const bytes = await readResponse(response, { maxBytes, label: `Required fixture ${file} from ${url}` });
  const actual = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actual, sha256, `Required fixture ${file}: SHA-256 mismatch from ${url}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  console.log(`${url} -> ${file} (${bytes.length} B, SHA-256 ${actual})`);
}
