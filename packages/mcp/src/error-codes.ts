// @margoengine/mcp/error-codes: the error help page (margoengine.com/errors) as data and as an MCP tool. Every Margo
// error message ends with "; see https://margoengine.com/errors#<id>"; the tool takes that link, the id, a MargoError
// code or the message itself and answers with the entry's cause and fix. The entries are copied from the page's one
// source (scripts/errors/entries.js) at package build time.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Json, ToolDefinition, ToolResult } from './server.js';

/** One entry of the error help page. */
export interface ErrorEntry {
  /** The anchor on the page, `disposed`. For a `code` entry it is also the MargoError `code`. */
  id: string;
  title: string;
  /** `code` for a MargoError code, `family` for a group of messages of one package or feature. */
  kind: 'code' | 'family';
  /** The short messages that link to the entry. */
  messages: string[];
  cause: string;
  fix: string;
}

/** One answer of {@link lookupError}. */
export interface ErrorMatch {
  entry: ErrorEntry;
  /** How it matched: the help link, the id or code, a listed message, or shared words. */
  by: 'link' | 'id' | 'message' | 'words';
  /** The listed message that matched, for `message` and `words`. */
  message?: string;
  score: number;
}

/** The address of an entry on the error help page. */
export const errorPageUrl = (id: string): string => `https://margoengine.com/errors#${id}`;

const LINK = /margoengine\.com\/errors#([a-z0-9-]+)/i;
const WORD = /[a-z0-9]+/g;
// Words every message has, which say nothing about which one it is.
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'be', 'to', 'of', 'or', 'and', 'in', 'on', 'it', 'its', 'for', 'see']);

const words = (text: string): string[] => (text.toLowerCase().match(WORD) ?? []).filter((word) => !STOP.has(word));

/** A thrown message without its "; see <link>" tail and an `Error:` style prefix. */
function bare(text: string): string {
  return text
    .replace(/;\s*see\s+https?:\/\/\S+\s*$/i, '')
    .replace(/^\s*(?:Uncaught\s+)?(?:[A-Za-z]*Error|MargoError)(?:\s*\[[^\]]*\])?:\s*/, '')
    .trim();
}

/**
 * Finds the error help entries for `query`, best first: an `errors#<id>` link or a bare id or MargoError code names
 * its entry; otherwise a message the page lists (the thrown text, with or without its link) matches its entry, and
 * failing that the entries whose listed messages share the most words with it (half of the asked words at least).
 */
export function lookupError(entries: readonly ErrorEntry[], query: string, limit = 3): ErrorMatch[] {
  if (typeof query !== 'string' || !query.trim()) throw typeError('lookupError needs an error code, message or link', 'mcp');
  const max = Math.max(1, Math.min(10, Math.floor(limit)));
  const link = LINK.exec(query)?.[1]?.toLowerCase();
  if (link) {
    const entry = entries.find((candidate) => candidate.id === link);
    if (entry) return [{ entry, by: 'link', score: 100 }];
  }
  const trimmed = query.trim();
  const byId = entries.find((candidate) => candidate.id === trimmed.toLowerCase());
  if (byId) return [{ entry: byId, by: 'id', score: 100 }];
  const text = bare(trimmed).toLowerCase();
  const exact: ErrorMatch[] = [];
  for (const entry of entries)
    for (const message of entry.messages)
      if (message.toLowerCase() === text) exact.push({ entry, by: 'message', message, score: 50 });
  if (exact.length) return exact.slice(0, max);
  const asked = [...new Set(words(text))];
  if (!asked.length) return [];
  const best = new Map<ErrorEntry, ErrorMatch>();
  for (const entry of entries)
    for (const message of entry.messages) {
      const listed = new Set(words(message));
      let shared = 0;
      for (const word of asked) if (listed.has(word)) shared++;
      // A thrown message can carry values the listed one does not (a name, a number), so its own words may be more.
      const score = shared / Math.max(asked.length, listed.size);
      if (shared && shared * 2 >= asked.length && score > (best.get(entry)?.score ?? 0))
        best.set(entry, { entry, by: 'words', message, score });
    }
  return [...best.values()].sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, max);
}

/** Formats matches as the text a model reads: title, link, cause and fix of each entry. */
export function formatError(query: string, matches: readonly ErrorMatch[]): string {
  if (!matches.length)
    return `No error help entry matches ${JSON.stringify(query)}. Pass the whole message (it ends with a margoengine.com/errors#<id> link), the id after the #, or the MargoError code (error.code).`;
  return matches
    .map(({ entry, by, message }) =>
      [
        `${entry.title}  (${errorPageUrl(entry.id)})`,
        ...(by === 'words' && message ? [`Closest listed message: ${message}`] : []),
        `Cause: ${entry.cause}`,
        `Fix: ${entry.fix}`,
      ].join('\n'),
    )
    .join('\n\n');
}

/** Reads the error help entries the package ships (`dist/error-codes.json`), or `file` when given. */
export async function loadErrorEntries(file?: string | URL, signal?: AbortSignal): Promise<ErrorEntry[]> {
  const target = file ?? join(import.meta.dirname, 'error-codes.json');
  let text: string;
  try {
    text = await readFile(target, { encoding: 'utf8', signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw fault('failed', `The error help entries ${String(target)} cannot be read; reinstall @margoengine/mcp`, 'mcp');
  }
  return JSON.parse(text) as ErrorEntry[];
}

/** The `explain_error` tool over `entries`. */
export function createErrorTool(entries: readonly ErrorEntry[]): ToolDefinition {
  if (!Array.isArray(entries) || !entries.length) throw typeError('createErrorTool needs at least one entry', 'mcp');
  return {
    name: 'explain_error',
    title: 'Explain a Margo error',
    description:
      'Explains a Margo Engine error and how to fix it, from the error help page (margoengine.com/errors). Pass the whole error message (each ends with "; see https://margoengine.com/errors#<id>"), that link, the id after the #, or the MargoError code from error.code (disposed, unsupported, ...). Call it when a user pastes a Margo error or a stack trace.',
    inputSchema: {
      type: 'object',
      properties: {
        error: { type: 'string', description: 'The message, the errors#<id> link, the id or the error code.' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Entries to return when the text matches several. Default 3.' },
      },
      required: ['error'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args): ToolResult {
      const error = args.error;
      if (typeof error !== 'string' || !error.trim())
        throw typeError('error is required and must be a non-empty string', 'mcp');
      const limit = args.limit;
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit)))
        throw typeError('limit must be an integer', 'mcp');
      if (typeof limit === 'number' && (limit < 1 || limit > 10)) throw rangeError('limit must be from 1 to 10', 'mcp');
      const matches = lookupError(entries, error, limit ?? 3);
      return {
        content: [{ type: 'text', text: formatError(error, matches) }],
        structuredContent: {
          matches: matches.map(({ entry, by, message, score }) => ({
            id: entry.id,
            title: entry.title,
            kind: entry.kind,
            url: errorPageUrl(entry.id),
            cause: entry.cause,
            fix: entry.fix,
            by,
            ...(message ? { message } : {}),
            score,
          })) as unknown as Json,
        },
      };
    },
  };
}
