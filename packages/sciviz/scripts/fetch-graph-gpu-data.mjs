// Data only, no external source code. OpenAlex metadata and citation links are CC0.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const url =
  'https://api.openalex.org/works?search=graph%20drawing&per-page=80&select=id,display_name,referenced_works,publication_year';
const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
const raw = await response.json();
const works = raw.results.map((w) => ({
  id: w.id,
  title: w.display_name,
  year: w.publication_year,
  references: w.referenced_works,
}));
const text =
    JSON.stringify(works, null, 2).replace(/[\u2013\u2014]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`) + '\n',
  directory = new URL('../tests/fixtures/graph-gpu/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('openalex.json', directory), text);
await writeFile(
  new URL('source.json', directory),
  JSON.stringify(
    {
      source: url,
      retrieved: new Date().toISOString(),
      license: 'CC0-1.0',
      licenseURL: 'https://help.openalex.org/api/',
      sha256: createHash('sha256').update(text).digest('hex'),
      records: works.length,
      description:
        'Original OpenAlex work IDs, titles, publication years and outgoing citation links. Referenced IDs are retained as nodes even when their metadata is outside the query.',
    },
    null,
    2,
  ) + '\n',
);
console.log(`Saved ${works.length} original OpenAlex works`);
