// Loaded through NODE_OPTIONS=--import by scripts/record-wgsl-corpus.mjs only: when MARGO_WGSL_CORPUS names a folder,
// every browser this Node process launches records its WGSL modules into a shard there (scripts/support/wgsl-corpus.mjs).
// npm's own processes launch no browser and are left alone.
import { installCorpusHook } from './wgsl-corpus.mjs';

const dir = process.env.MARGO_WGSL_CORPUS;
if (dir && !/npm-cli|npx-cli/.test(process.argv[1] ?? '')) installCorpusHook(dir);
