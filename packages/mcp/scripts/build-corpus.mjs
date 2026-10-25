// Writes dist/corpus.json: the READMEs, API reports, docs and example list the server searches, read from the
// repository once at build time (the same reader scripts/build-llms.mjs uses for llms.txt).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collectCorpus } from '../../../scripts/support/llms-corpus.mjs';

const target = resolve(import.meta.dirname, '../dist/corpus.json');
const corpus = collectCorpus();
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(corpus));
console.log(
  `mcp corpus: ${corpus.packages.length} packages, ${corpus.docs.length} docs, ${corpus.examples.length} examples`,
);
