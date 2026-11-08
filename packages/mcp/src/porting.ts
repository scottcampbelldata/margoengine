// @margoengine/mcp/porting: porting guides as data and as an MCP tool. A parity matrix in the docs compares another
// library with Margo, one row per feature; each of that library's names maps to the Margo package and calls of its row,
// with the worked code of the matching section of the "Coming from <library>" guide. The guides are found in the docs
// corpus at package build time; the library names come from the docs, not from this code.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Corpus } from './corpus.js';
import type { Json, ToolDefinition, ToolResult } from './server.js';

/** One row of a parity matrix: a feature of the other library and where it lives in Margo. */
export interface PortingRow {
  /** Matrix area, `Cameras`. */
  area: string;
  /** The other library's names for the feature, as the matrix writes them. */
  from: string;
  /** COVERED, PARTIAL, MISSING or NOT PLANNED. */
  status: string;
  /** The Margo packages and calls (markdown). */
  margo: string;
  /** Limits and differences (markdown). */
  notes: string;
  /** A page that runs it, when one is published. */
  page?: string;
}

/** One section of a "Coming from" guide, with its code. */
export interface PortingSection {
  title: string;
  /** Anchor of the section on the guide page, `#controls`. */
  anchor: string;
  /** The other library's code of the section (its first `js` block), if any. */
  from?: string;
  /** The Margo code of the section (its first `ts` block), if any. */
  margo?: string;
  /** The section text without code, for matching. */
  text: string;
}

/** One porting guide: the matrix rows for one library and the sections of its guide. */
export interface PortingGuide {
  /** The library the matrix compares, as its title names it (with a version when the title has one). */
  library: string;
  /** Path of the matrix page in the repository, when known. */
  matrix?: string;
  /** Path of the "Coming from" guide page, when there is one. */
  guide?: string;
  rows: PortingRow[];
  sections: PortingSection[];
}

/** One answer of {@link lookupPorting}. */
export interface PortingMatch {
  row: PortingRow;
  /** The guide section with worked code for the row, if one matches. */
  section?: PortingSection;
  score: number;
}

/** Paths recorded on a parsed guide. */
export interface PortingSources {
  matrix?: string;
  guide?: string;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const MATRIX_COLUMNS = ['Status', 'Margo', 'Shows it', 'Notes'];

/** The other library's name in a matrix: the first column of a table whose other columns are the matrix columns. */
function matrixLibrary(markdown: string): string | undefined {
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const [first, ...rest] = cells(line);
    if (rest.length === 4 && rest.every((cell, index) => cell === MATRIX_COLUMNS[index])) return first;
  }
  return undefined;
}

/** The GitHub-style anchor of a heading: lower case, punctuation dropped, spaces to hyphens. */
export function headingAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/**
 * Reads a porting guide from a parity matrix page and, optionally, its "Coming from" guide page. Matrix rows are the
 * table rows under `### N. Area` headings of the `## Matrix` section whose header is `| <library> | Status | Margo |
 * Shows it | Notes |`. Guide sections are the `##` and `###` headings; a section's first `js` block is the other
 * library's code and its first `ts` block the Margo code.
 */
export function parsePortingGuide(matrix: string, guide = '', sources: PortingSources = {}): PortingGuide {
  if (typeof matrix !== 'string' || typeof guide !== 'string')
    throw typeError('parsePortingGuide takes the matrix and guide markdown as strings', 'mcp');
  const name = matrixLibrary(matrix);
  if (name === undefined)
    throw rangeError('The matrix has no table with the columns Status, Margo, Shows it and Notes', 'mcp');
  // "<name> r186 parity matrix" names the version; keep it.
  const title = /^#\s+(.+)$/m.exec(matrix)?.[1].trim() ?? '';
  const library = title.startsWith(name) ? title.replace(/\s+parity matrix\s*$/i, '').trim() : name;
  const rows: PortingRow[] = [];
  let area = '',
    inMatrix = false;
  for (const line of matrix.split(/\r?\n/)) {
    if (/^##\s/.test(line)) inMatrix = /^##\s+Matrix\s*$/.test(line);
    const heading = /^###\s+(?:\d+\.\s*)?(.+)$/.exec(line);
    if (heading) area = heading[1].trim();
    if (!inMatrix || !area || !line.startsWith('|')) continue;
    const [from, status, margo, shows, notes] = cells(line);
    if (notes === undefined || from === name || /^-+$/.test(from)) continue;
    const page = /\]\((https?:[^)\s]+)\)/.exec(shows ?? '')?.[1];
    rows.push({
      area,
      from,
      status: status.replace(/\s*†\s*/g, '').trim(),
      margo,
      notes,
      ...(page ? { page } : {}),
    });
  }
  const sections: PortingSection[] = [];
  let current: { title: string; lines: string[] } | undefined,
    fence = false;
  const flush = () => {
    if (!current) return;
    const body = current.lines.join('\n');
    const block = (language: string) =>
      new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```').exec(body)?.[1]?.trim() || undefined;
    const from = block('js'),
      margo = block('ts');
    sections.push({
      title: current.title,
      anchor: `#${headingAnchor(current.title)}`,
      ...(from ? { from } : {}),
      ...(margo ? { margo } : {}),
      text: body.replace(/```[\s\S]*?```/g, ' ').trim(),
    });
  };
  for (const line of guide.split(/\r?\n/)) {
    if (line.startsWith('```')) fence = !fence;
    const heading = fence ? null : /^#{2,3}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      current = heading[1].trim() === 'Contents' ? undefined : { title: heading[1].trim(), lines: [] };
    } else current?.lines.push(line);
  }
  flush();
  return {
    library,
    ...(sources.matrix ? { matrix: sources.matrix } : {}),
    ...(sources.guide ? { guide: sources.guide } : {}),
    rows,
    sections,
  };
}

/**
 * Finds every porting guide in a docs corpus: each page with a `## Matrix` section in the matrix format, joined with
 * the page titled `Coming from <library>` when there is one.
 */
export function portingGuidesFromCorpus(corpus: Pick<Corpus, 'docs'>): PortingGuide[] {
  const guides: PortingGuide[] = [];
  for (const doc of corpus.docs) {
    if (!/^##\s+Matrix\s*$/m.test(doc.text)) continue;
    const name = matrixLibrary(doc.text);
    if (name === undefined) continue;
    const guide = corpus.docs.find((candidate) => candidate.title === `Coming from ${name}`);
    guides.push(parsePortingGuide(doc.text, guide?.text ?? '', { matrix: doc.path, guide: guide?.path }));
  }
  return guides;
}

const WORD = /[A-Za-z][A-Za-z0-9]*|[0-9]+/g;

/** A word without a plural or verb ending, so shadows, instanced and instancing meet their stem. */
const stem = (word: string): string =>
  word.length > 5 ? word.replace(/(?:ing|ed|es|s)$/, '') : word.length > 3 ? word.replace(/s$/, '') : word;

/** Lower-case word stems of a text, with the parts of camelCase and PascalCase names (`OrbitControls`: orbit, control). */
function words(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(WORD) ?? []) {
    out.push(stem(word.toLowerCase()));
    const parts = word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g);
    if (parts && parts.length > 1) for (const part of parts) if (part.length > 1) out.push(stem(part.toLowerCase()));
  }
  return out;
}

/** True when `set` holds `word`, or (five letters or more) a word of five or more that starts with it or that it starts with. */
function has(set: ReadonlySet<string>, word: string): boolean {
  if (set.has(word)) return true;
  if (word.length < 5) return false;
  for (const other of set) if (other.length >= 5 && (other.startsWith(word) || word.startsWith(other))) return true;
  return false;
}

/** Score of one asked word against a row's names: whole word 3, the start of a longer name 2. */
function nameScore(word: string, names: ReadonlySet<string>): number {
  if (names.has(word)) return 3;
  if (word.length >= 4) for (const name of names) if (name.startsWith(word)) return 2;
  return 0;
}

// Words that say nothing about which feature is meant.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'new', 'js']);

/**
 * Finds the matrix rows for a name or task of the other library (`OrbitControls`, `NS.InstancedMesh`, `shadow map`),
 * best first, each with the guide section whose code shows it. A name in the row's names cell counts far more than a
 * mention in its notes, and the exact name written out beats a row that only shares a word. A leading all-capitals
 * namespace (`NS.`) is ignored.
 */
export function lookupPorting(guide: PortingGuide, query: string, limit = 5): PortingMatch[] {
  if (typeof query !== 'string' || !query.trim()) throw typeError('lookupPorting needs a name or a task', 'mcp');
  const cleaned = query.trim().replace(/^[A-Z][A-Z0-9_]*\./, '');
  const library = new Set(words(guide.library));
  const wanted = [...new Set(words(cleaned).filter((word) => !STOP.has(word) && !library.has(word)))];
  if (!wanted.length) return [];
  const exact = cleaned.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(^|[^a-z0-9])${exact}($|[^a-z0-9])`);
  const scored: PortingMatch[] = [];
  for (const row of guide.rows) {
    const names = new Set(words(row.from)),
      rest = new Set(words(`${row.margo} ${row.notes}`));
    let score = 0;
    for (const word of wanted) score += nameScore(word, names) || (rest.has(word) ? 0.5 : 0);
    if (!score) continue;
    if (whole.test(row.from.toLowerCase())) score += 10;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.from.localeCompare(b.row.from));
  const top = scored.slice(0, Math.max(1, Math.min(25, Math.floor(limit))));
  for (const match of top) {
    const rowWords = [...new Set([...words(match.row.from), ...wanted].filter((word) => !STOP.has(word)))];
    const margoWords = [...new Set(words(match.row.margo).filter((word) => word.length > 3 && !STOP.has(word)))];
    let best: PortingSection | undefined,
      bestScore = 0;
    for (const section of guide.sections) {
      if (!section.margo) continue;
      const title = new Set(words(section.title)),
        text = new Set(words(`${section.text} ${section.from ?? ''} ${section.margo}`));
      let score = 0;
      for (const word of rowWords) score += (has(title, word) ? 4 : 0) + (has(text, word) ? 1 : 0);
      for (const word of margoWords) score += has(text, word) ? 0.25 : 0;
      if (score > bestScore) (bestScore = score), (best = section);
    }
    // A section that shares one word with the row is a guess, not a match.
    if (best && bestScore >= 4) match.section = best;
  }
  return top;
}

/** Formats matches as the text a model reads: status, the Margo calls, the notes, then the worked code. */
export function formatPorting(guide: PortingGuide, query: string, matches: readonly PortingMatch[]): string {
  if (!matches.length)
    return `No ${guide.library} row matches ${JSON.stringify(query)}. Try the class name (OrbitControls, InstancedMesh) or a task (shadows, raycast), or call search_docs.`;
  const out: string[] = [];
  matches.forEach(({ row, section }, number) => {
    out.push(
      `${number + 1}. ${row.from}  [${row.status}, ${row.area}]`,
      `   Margo: ${row.margo || 'nothing yet'}`,
      ...(row.notes ? [`   Notes: ${row.notes}`] : []),
      ...(row.page ? [`   Runs at: ${row.page}`] : []),
    );
    if (section) {
      out.push(`   Guide: ${guide.guide ?? 'the guide'}${section.anchor} (${section.title})`);
      if (section.from) out.push(`   ${guide.library}:`, '```js', section.from, '```');
      if (section.margo) out.push('   Margo:', '```ts', section.margo, '```');
    }
    out.push('');
  });
  if (guide.matrix) out.push(`Source: ${guide.matrix}`);
  return out.join('\n').trim();
}

/**
 * Reads the porting guides the package ships (`dist/porting.json`, written at build time from the docs), or `file`
 * when given.
 */
export async function loadPortingGuides(file?: string | URL, signal?: AbortSignal): Promise<PortingGuide[]> {
  const target = file ?? join(import.meta.dirname, 'porting.json');
  let text: string;
  try {
    text = await readFile(target, { encoding: 'utf8', signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fault(
      'failed',
      `The porting guides ${String(target)} cannot be read; reinstall @margoengine/mcp or pass a guide file`,
      'mcp',
    );
  }
  return JSON.parse(text) as PortingGuide[];
}

/** The `port_to_margo` tool over `guides`. */
export function createPortingTool(guides: readonly PortingGuide[]): ToolDefinition {
  if (!Array.isArray(guides) || !guides.length) throw typeError('createPortingTool needs at least one guide', 'mcp');
  const libraries = guides.map((guide) => guide.library);
  const pick = (from: string | undefined): PortingGuide => {
    if (from === undefined) return guides[0];
    const wanted = from.toLowerCase();
    const found = guides.find((guide) => guide.library.toLowerCase().includes(wanted));
    if (!found) throw rangeError(`No porting guide for ${JSON.stringify(from)}; there are guides for ${libraries.join(', ')}`, 'mcp');
    return found;
  };
  return {
    name: 'port_to_margo',
    title: 'Port code from another library to Margo',
    description: `Maps a class, function or task of ${libraries.join(' or ')} (for example OrbitControls, InstancedMesh, MeshStandardMaterial, EffectComposer, "shadow map", "raycast") to the Margo package and calls that do the same job, with the status (COVERED, PARTIAL, MISSING, NOT PLANNED), the limits and, where the porting guide has one, that library's code next to the Margo code. Call it when converting code from ${libraries[0]} or when a user names one of its APIs.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A class or function name (NS.OrbitControls or OrbitControls) or a task.' },
        from: {
          type: 'string',
          enum: libraries,
          description: `The library to port from. Default ${libraries[0]}.`,
        },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Rows to return. Default 3.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args): ToolResult {
      const name = args.name;
      if (typeof name !== 'string' || !name.trim()) throw typeError('name is required and must be a non-empty string', 'mcp');
      if (args.from !== undefined && typeof args.from !== 'string') throw typeError('from must be a string', 'mcp');
      const limit = args.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit)))
        throw typeError('limit must be an integer', 'mcp');
      if (typeof limit === 'number' && (limit < 1 || limit > 25)) throw rangeError('limit must be from 1 to 25', 'mcp');
      const guide = pick(args.from as string | undefined);
      const matches = lookupPorting(guide, name, limit ?? 3);
      return {
        content: [{ type: 'text', text: formatPorting(guide, name, matches) }],
        structuredContent: {
          library: guide.library,
          matches: matches.map(({ row, section, score }) => ({
            ...row,
            score,
            ...(section
              ? {
                  guide: {
                    title: section.title,
                    page: `${guide.guide ?? ''}${section.anchor}`,
                    from: section.from ?? null,
                    margo: section.margo ?? null,
                  },
                }
              : {}),
          })) as unknown as Json,
        },
      };
    },
  };
}
