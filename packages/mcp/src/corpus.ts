import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fault, typeError } from '../../shared/errors.js';

/** One package's documentation. */
export interface CorpusPackage {
  /** Folder name, `sciviz`. */
  id: string;
  /** npm name, `@margoengine/sciviz`. */
  name: string;
  description: string;
  /** Catalog layer, for example `Rendering and lighting`. */
  category: string;
  /** The package README (markdown). */
  readme: string;
  /** One API report per exported entry point. */
  entries: { specifier: string; subpath: string; report: string }[];
}

/** One docs page. */
export interface CorpusDoc {
  /** Path in the repository, `docs/conventions.md`. */
  path: string;
  title: string;
  summary: string;
  text: string;
}

/** One runnable example page or project. */
export interface CorpusExample {
  id: string;
  title: string;
  /** Path in the repository, `examples/flight-helmet.html`. */
  path: string;
  description: string;
  section: string;
}

/** Everything the server can search and return. Built by `scripts/build-corpus.mjs` from the repository. */
export interface Corpus {
  packages: CorpusPackage[];
  docs: CorpusDoc[];
  examples: CorpusExample[];
  /** The repository README. */
  readme: string;
}

/** Where a search hit comes from. */
export type HitKind = 'readme' | 'api' | 'doc' | 'example';

/** One ranked search result. */
export interface SearchHit {
  kind: HitKind;
  /** Package id for `readme` and `api` hits, else undefined. */
  package?: string;
  /** For `api` hits, the entry point (`@margoengine/sciviz/colormaps`). */
  entry?: string;
  /** Page path for `doc` and `example` hits. */
  path?: string;
  title: string;
  /** A few lines around the best match. */
  snippet: string;
  score: number;
}

/** Options of {@link searchCorpus}. */
export interface SearchOptions {
  /** Only these kinds (default all). */
  kinds?: readonly HitKind[];
  /** Only this package (id or npm name). */
  package?: string;
  /** Results to return (default 8, at most 25). */
  limit?: number;
}

interface Chunk {
  kind: HitKind;
  package?: string;
  entry?: string;
  path?: string;
  title: string;
  text: string;
  length: number;
}

/** A search index over a {@link Corpus}; build once with {@link createIndex}. */
export interface CorpusIndex {
  readonly corpus: Corpus;
  /** @internal */
  readonly chunks: readonly Chunk[];
  /** @internal term to [chunk, count] pairs */
  readonly postings: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  /** @internal */
  readonly average: number;
}

/** The id (`sciviz`) of a package named `sciviz`, `@margoengine/sciviz` or `margoengine/sciviz`. */
export function packageId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^@?margoengine\//, '')
    .replace(/^@/, '');
}

const WORD = /[A-Za-z][A-Za-z0-9]*|[0-9]+/g;

/** Lower-case search terms of a text: each word, plus the parts of a camelCase or kebab name. */
function terms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(WORD) ?? []) {
    out.push(word.toLowerCase());
    const parts = word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g);
    if (parts && parts.length > 1) for (const part of parts) if (part.length > 1) out.push(part.toLowerCase());
  }
  return out;
}

const WINDOW = 3500;

/** Splits markdown at headings (levels 1 to 3), skipping headings inside code fences; long sections are windowed. */
function sections(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let heading = '',
    lines: string[] = [],
    inCode = false;
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) for (let at = 0; at < body.length; at += WINDOW) out.push({ heading, body: body.slice(at, at + WINDOW) });
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inCode = !inCode;
    if (!inCode && /^#{1,3}\s/.test(line)) {
      flush();
      heading = line.replace(/^#+\s*/, '').trim();
    }
    lines.push(line);
  }
  flush();
  return out;
}

/** The declarations of an API report: blocks that start with `export` or `declare` at column 0. */
function declarations(report: string): { name: string; text: string }[] {
  const body = /```ts\n([\s\S]*?)\n```/.exec(report)?.[1] ?? report;
  const out: { name: string; text: string }[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join('\n').trim();
    // Import lines at the top of a report name nothing.
    if (text && !/^import\b/.test(text)) {
      const name =
        /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|function\*?|class|interface|type|enum|namespace|\{)\s*(\w+)?/.exec(
          text,
        );
      out.push({ name: name?.[1] ?? text.slice(0, 40), text });
    }
    current = [];
  };
  for (const line of body.split('\n')) {
    if (/^(export|declare)\b/.test(line)) flush();
    current.push(line);
  }
  flush();
  return out;
}

/** Builds the search index: README and docs sections, one chunk per API declaration, one per example. */
export function createIndex(corpus: Corpus): CorpusIndex {
  const chunks: Chunk[] = [];
  const add = (chunk: Omit<Chunk, 'length'>) => chunks.push({ ...chunk, length: 0 });
  for (const pkg of corpus.packages) {
    // The package's one-line description, so a search for what it does finds the package itself.
    add({
      kind: 'readme',
      package: pkg.id,
      title: `${pkg.name} (${pkg.category})`,
      text: `${pkg.description}\n${pkg.name}`,
    });
    for (const { heading, body } of sections(pkg.readme))
      add({ kind: 'readme', package: pkg.id, title: `${pkg.name}${heading ? ` / ${heading}` : ''}`, text: body });
    for (const entry of pkg.entries)
      for (const declaration of declarations(entry.report))
        add({
          kind: 'api',
          package: pkg.id,
          entry: entry.specifier,
          title: `${entry.specifier} ${declaration.name}`,
          text: declaration.text,
        });
  }
  for (const doc of corpus.docs)
    for (const { heading, body } of sections(doc.text))
      add({
        kind: 'doc',
        path: doc.path,
        title: `${doc.title}${heading && heading !== doc.title ? ` / ${heading}` : ''}`,
        text: body,
      });
  for (const example of corpus.examples)
    add({
      kind: 'example',
      path: example.path,
      title: example.title,
      text: `${example.title} ${example.description} ${example.section}`,
    });
  const postings = new Map<string, [number, number][]>();
  let total = 0;
  chunks.forEach((chunk, index) => {
    // A title counts three times: a name in the heading is the best sign the chunk is about it.
    const words = [...terms(chunk.title), ...terms(chunk.title), ...terms(chunk.title), ...terms(chunk.text)];
    chunk.length = words.length;
    total += words.length;
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const [word, count] of counts) {
      const list = postings.get(word);
      if (list) list.push([index, count]);
      else postings.set(word, [[index, count]]);
    }
  });
  return { corpus, chunks, postings, average: total / Math.max(1, chunks.length) };
}

function snippetOf(text: string, queryTerms: readonly string[]): string {
  const lines = text.split('\n');
  let best = 0,
    bestHits = -1;
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const hits = queryTerms.reduce((n, term) => n + (lower.includes(term) ? 1 : 0), 0);
    if (hits > bestHits) {
      bestHits = hits;
      best = index;
    }
  });
  const from = Math.max(0, best - 1);
  const snippet = lines.slice(from, from + 6).join('\n');
  return snippet.length > 420 ? `${snippet.slice(0, 419)}…` : snippet;
}

/** Ranks README sections, docs sections, API declarations and examples for `query` (BM25 over names and words). */
export function searchCorpus(index: CorpusIndex, query: string, options: SearchOptions = {}): SearchHit[] {
  if (typeof query !== 'string' || !query.trim()) throw typeError('search needs a non-empty query string', 'mcp');
  const limit = Math.min(25, Math.max(1, Math.floor(options.limit ?? 8)));
  const wanted = options.package === undefined ? undefined : packageId(options.package);
  const kinds = options.kinds ? new Set(options.kinds) : undefined;
  const queryTerms = [...new Set(terms(query))];
  const scores = new Map<number, number>();
  const n = index.chunks.length;
  for (const term of queryTerms) {
    // An exact term, else (for 3+ letters) every indexed term it starts, at a discount.
    const matches: [string, number][] = index.postings.has(term) ? [[term, 1]] : [];
    if (!matches.length && term.length >= 3) {
      for (const known of index.postings.keys())
        if (known.startsWith(term) && matches.length < 40) matches.push([known, 0.5]);
    }
    for (const [match, weight] of matches) {
      const list = index.postings.get(match) as readonly (readonly [number, number])[];
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const [chunk, count] of list) {
        const length = index.chunks[chunk].length;
        const tf = (count * 2.2) / (count + 1.2 * (0.25 + (0.75 * length) / index.average));
        scores.set(chunk, (scores.get(chunk) ?? 0) + weight * idf * tf);
      }
    }
  }
  const phrase = query.trim().toLowerCase();
  const ranked: SearchHit[] = [];
  for (const [chunkIndex, base] of scores) {
    const chunk = index.chunks[chunkIndex];
    if (kinds && !kinds.has(chunk.kind)) continue;
    if (wanted !== undefined && chunk.package !== wanted) continue;
    // A heading or declaration that is exactly what was asked for beats a long section that merely mentions it.
    const title = chunk.title.toLowerCase();
    let score = base;
    if (title.endsWith(` ${phrase}`) || title.endsWith(`/ ${phrase}`) || title === phrase) score *= 2;
    else if (title.includes(phrase)) score *= 1.4;
    ranked.push({
      kind: chunk.kind,
      ...(chunk.package === undefined ? {} : { package: chunk.package }),
      ...(chunk.entry === undefined ? {} : { entry: chunk.entry }),
      ...(chunk.path === undefined ? {} : { path: chunk.path }),
      title: chunk.title,
      snippet: snippetOf(chunk.text, queryTerms),
      score: Math.round(score * 1000) / 1000,
    });
  }
  ranked.sort((a, b) => b.score - a.score || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  // One hit per page title keeps ten sections of one README from crowding out everything else.
  const seen = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const hit of ranked) {
    const key = `${hit.kind}:${hit.package ?? hit.path}`;
    const count = seen.get(key) ?? 0;
    if (count >= 3) continue;
    seen.set(key, count + 1);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Reads the corpus the package ships (`dist/corpus.json`, written by the build from the repository's READMEs, API
 * reports, docs and example list), or `file` when given. Rejects with a MargoError (`failed`) when it is missing.
 */
export async function loadCorpus(file?: string | URL, signal?: AbortSignal): Promise<Corpus> {
  // import.meta.dirname, not new URL(..., import.meta.url): a bundler would otherwise inline the whole corpus as an asset.
  const target = file ?? join(import.meta.dirname, 'corpus.json');
  let text: string;
  try {
    text = await readFile(target, { encoding: 'utf8', signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fault(
      'failed',
      `The documentation corpus ${String(target)} cannot be read; reinstall @margoengine/mcp or pass a corpus file`,
      'mcp',
    );
  }
  return JSON.parse(text) as Corpus;
}
