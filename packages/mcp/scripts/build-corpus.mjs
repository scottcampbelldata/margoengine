// Writes the data the server ships, read from the repository once at build time: dist/corpus.json (the READMEs, API
// reports, docs and example list the server searches, from the same reader scripts/build-llms.mjs uses for llms.txt)
// dist/porting.json (the porting guides: each parity matrix page of the docs with its "Coming from" guide) and
// dist/error-codes.json (the entries of the error help page, from its one source scripts/errors/entries.js).
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { entries } from '../../../scripts/errors/entries.js';
import { collectCorpus } from '../../../scripts/support/llms-corpus.mjs';
import { portingGuidesFromCorpus } from '../dist/porting.js';

const dist = resolve(import.meta.dirname, '../dist');
const corpus = collectCorpus();
await mkdir(dist, { recursive: true });
await writeFile(resolve(dist, 'corpus.json'), JSON.stringify(corpus));
console.log(
  `mcp corpus: ${corpus.packages.length} packages, ${corpus.docs.length} docs, ${corpus.examples.length} examples`,
);
const porting = portingGuidesFromCorpus(corpus);
if (!porting.length) throw new Error('mcp porting: no parity matrix page found in the docs corpus');
await writeFile(resolve(dist, 'porting.json'), JSON.stringify(porting));
for (const guide of porting)
  console.log(`mcp porting guide: ${guide.library}, ${guide.rows.length} rows, ${guide.sections.length} guide sections`);
await writeFile(resolve(dist, 'error-codes.json'), JSON.stringify(entries));
console.log(`mcp error help: ${entries.length} entries, ${entries.reduce((n, e) => n + e.messages.length, 0)} messages`);
