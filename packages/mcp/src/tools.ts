import { checkSnippet, formatReport } from './check.js';
import { createIndex, packageId, searchCorpus, type Corpus, type CorpusIndex, type HitKind } from './corpus.js';
import { rangeError, typeError } from '../../shared/errors.js';
import type { Json, ToolDefinition, ToolResult } from './server.js';

/** Options of {@link createTools}. */
export interface ToolsOptions {
  /** The documentation to search and return. */
  corpus: Corpus;
  /** The folder whose `node_modules` holds TypeScript and the Margo packages, for `check_snippet` (default: the current directory). */
  projectRoot?: string;
}

const text = (value: string, data?: { [key: string]: Json }): ToolResult => ({
  content: [{ type: 'text', text: value }],
  ...(data ? { structuredContent: data } : {}),
});

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw typeError(`${key} must be a string`, 'mcp');
  return value;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || !value.trim()) throw typeError(`${key} is required and must be a non-empty string`, 'mcp');
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw typeError(`${key} must be an integer`, 'mcp');
  if (value < min || value > max) throw rangeError(`${key} must be from ${min} to ${max}`, 'mcp');
  return value;
}

/** Cuts `value` to `max` characters at a line boundary and says how to get the rest. */
function truncate(value: string, max: number, hint: string): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false };
  const cut = value.slice(0, max),
    line = cut.lastIndexOf('\n');
  return {
    text: `${cut.slice(0, line > max / 2 ? line : max)}\n\n[truncated at ${max} of ${value.length} characters: ${hint}]`,
    truncated: true,
  };
}

const HIT_KINDS = ['readme', 'api', 'doc', 'example'] as const;

/**
 * The server's tools over `options.corpus`:
 * `search_docs`, `list_packages`, `get_package`, `list_examples` and `check_snippet`.
 */
export function createTools(options: ToolsOptions): ToolDefinition[] {
  const { corpus } = options;
  let index: CorpusIndex | undefined;
  const findPackage = (input: string) => {
    const id = packageId(input);
    const found = corpus.packages.find((pkg) => pkg.id === id);
    if (found) return found;
    const near = corpus.packages
      .filter((pkg) => pkg.id.includes(id) || id.includes(pkg.id))
      .slice(0, 5)
      .map((pkg) => pkg.name);
    throw rangeError(
      `No package named ${JSON.stringify(input)}${near.length ? `; did you mean ${near.join(', ')}?` : '; call list_packages for the names'}`,
      'mcp',
    );
  };

  const searchDocs: ToolDefinition = {
    name: 'search_docs',
    title: 'Search the Margo docs and API',
    description:
      'Full-text search over the Margo Engine package READMEs, API reports (every exported name with its TypeScript declaration), docs pages and examples. Use it before writing Margo code: search for a task ("orbit camera", "load glTF") or an exact name ("createStage", "Figure.scatter"). Returns ranked hits with a snippet; read a whole package with get_package.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or an API name. camelCase names also match their parts.' },
        kind: {
          type: 'string',
          enum: ['all', ...HIT_KINDS],
          description: 'Limit to one source: readme, api, doc or example. Default all.',
        },
        package: { type: 'string', description: 'Limit to one package, for example sciviz or @margoengine/sciviz.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Results to return. Default 8.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args) {
      const query = requiredString(args, 'query');
      const kind = optionalString(args, 'kind') ?? 'all';
      if (kind !== 'all' && !(HIT_KINDS as readonly string[]).includes(kind))
        throw rangeError('kind is all, readme, api, doc or example', 'mcp');
      const pkg = optionalString(args, 'package');
      if (pkg !== undefined) findPackage(pkg);
      index ??= createIndex(corpus);
      const hits = searchCorpus(index, query, {
        kinds: kind === 'all' ? undefined : [kind as HitKind],
        package: pkg,
        limit: optionalInteger(args, 'limit', 1, 25),
      });
      if (!hits.length)
        return text(`No results for ${JSON.stringify(query)}. Try fewer or different words, or call list_packages.`, {
          hits: [],
        });
      const lines = hits.map((hit, number) => {
        const where =
          hit.kind === 'api'
            ? `API ${hit.entry}`
            : hit.kind === 'readme'
              ? `README ${hit.package}`
              : `${hit.kind} ${hit.path}`;
        return `${number + 1}. ${hit.title}  [${where}]\n${hit.snippet.replace(/^/gm, '   ')}`;
      });
      return text(lines.join('\n\n'), { hits: hits.map((hit) => ({ ...hit })) as unknown as Json });
    },
  };

  const listPackages: ToolDefinition = {
    name: 'list_packages',
    title: 'List the Margo packages',
    description:
      'Lists every Margo Engine package with its layer and one-line description. Margo core is small and frozen; every feature (glTF PBR, animation, post-processing, physics, CAD, voxels, compute, charts) is a separate optional package, so find the package for a task here, then read it with get_package.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description: 'Only this layer, for example "Rendering and lighting" (case-insensitive substring).',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args) {
      const category = optionalString(args, 'category')?.toLowerCase();
      const packages = corpus.packages.filter((pkg) => !category || pkg.category.toLowerCase().includes(category));
      if (!packages.length)
        throw rangeError(
          `No layer matches ${JSON.stringify(category)}; call list_packages without category to see them`,
          'mcp',
        );
      const lines: string[] = [];
      for (const layer of [...new Set(packages.map((pkg) => pkg.category))]) {
        lines.push(`${layer}:`);
        for (const pkg of packages.filter((candidate) => candidate.category === layer))
          lines.push(`  ${pkg.name}: ${pkg.description}`);
      }
      return text(lines.join('\n'), {
        packages: packages.map((pkg) => ({ name: pkg.name, category: pkg.category, description: pkg.description })),
      });
    },
  };

  const getPackage: ToolDefinition = {
    name: 'get_package',
    title: 'Get a package README or API',
    description:
      'Returns one Margo package: its README (install, imports, examples that run as written) or its API report (every exported name with its declaration, per entry point), or both. Names are accepted as sciviz, @margoengine/sciviz or margoengine/sciviz.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string', description: 'Package name, for example @margoengine/sciviz or stage.' },
        part: { type: 'string', enum: ['readme', 'api', 'both'], description: 'What to return. Default readme.' },
        entry: {
          type: 'string',
          description:
            'API only: one entry point, for example ./colormaps or @margoengine/sciviz/colormaps. Default all entries.',
        },
        maxChars: {
          type: 'integer',
          minimum: 1000,
          maximum: 400000,
          description: 'Longest text to return. Default 60000.',
        },
      },
      required: ['package'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args) {
      const pkg = findPackage(requiredString(args, 'package'));
      const part = optionalString(args, 'part') ?? 'readme';
      if (part !== 'readme' && part !== 'api' && part !== 'both')
        throw rangeError('part is readme, api or both', 'mcp');
      const entry = optionalString(args, 'entry');
      const max = optionalInteger(args, 'maxChars', 1000, 400000) ?? 60000;
      let entries = pkg.entries;
      if (entry !== undefined) {
        const wanted = entry.startsWith('@')
          ? entry
          : entry === '.'
            ? pkg.name
            : `${pkg.name}/${entry.replace(/^\.\//, '')}`;
        entries = pkg.entries.filter((candidate) => candidate.specifier === wanted);
        if (!entries.length)
          throw rangeError(
            `${pkg.name} has no entry ${JSON.stringify(entry)}; its entries are ${pkg.entries.map((e) => e.specifier).join(', ') || 'none'}`,
            'mcp',
          );
      }
      const sections: string[] = [];
      if (part !== 'api') sections.push(pkg.readme.trim() ? pkg.readme.trim() : `${pkg.name} has no README.`);
      if (part !== 'readme')
        sections.push(
          entries.length
            ? entries.map((e) => `<!-- ${e.specifier} -->\n${e.report.trim()}`).join('\n\n')
            : `${pkg.name} has no API report.`,
        );
      const cut = truncate(
        sections.join('\n\n---\n\n'),
        max,
        part === 'readme' ? 'raise maxChars' : 'pass entry for one entry point, or raise maxChars',
      );
      return text(cut.text, {
        package: pkg.name,
        part,
        entries: pkg.entries.map((e) => e.specifier),
        truncated: cut.truncated,
      });
    },
  };

  const listExamples: ToolDefinition = {
    name: 'list_examples',
    title: 'List the Margo examples',
    description:
      'Lists the runnable Margo examples (pages and starter projects in the repository) with what each shows. Use it to find a working example before writing one from scratch; the path is relative to the repository root.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Only examples whose name or description contains this text (case-insensitive).',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run(args) {
      const filter = optionalString(args, 'filter')?.toLowerCase();
      const examples = corpus.examples.filter(
        (example) =>
          !filter || `${example.title} ${example.description} ${example.section}`.toLowerCase().includes(filter),
      );
      if (!examples.length) return text(`No example matches ${JSON.stringify(filter)}.`, { examples: [] });
      const lines = examples.map((example) => `${example.path}: ${example.description}`);
      lines.push(
        '',
        'Run one from a repository checkout: npm run build:packages, then npm run dev:examples (pages) or the command its project table gives.',
      );
      return text(lines.join('\n'), { examples: examples.map((example) => ({ ...example })) });
    },
  };

  const checkSnippetTool: ToolDefinition = {
    name: 'check_snippet',
    title: 'Type-check a code snippet',
    description:
      "Type-checks a TypeScript (or TSX, or JavaScript) snippet against the real Margo package types installed in the project, with the project's own compiler in strict mode. Run it on code you wrote for Margo before presenting it: it catches wrong names, wrong arguments and missing awaits. The snippet is compiled, never run. Needs typescript and the @margoengine packages in the project's node_modules.",
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The snippet, with its imports.' },
        language: { type: 'string', enum: ['ts', 'tsx', 'js'], description: 'Default ts.' },
        strict: { type: 'boolean', description: 'Strict mode. Default true.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async run(args, context) {
      const code = requiredString(args, 'code');
      const language = optionalString(args, 'language');
      if (language !== undefined && language !== 'ts' && language !== 'tsx' && language !== 'js')
        throw rangeError('language is ts, tsx or js', 'mcp');
      if (args.strict !== undefined && typeof args.strict !== 'boolean')
        throw typeError('strict must be true or false', 'mcp');
      const report = await checkSnippet(code, {
        projectRoot: options.projectRoot,
        language,
        strict: args.strict as boolean | undefined,
        signal: context.signal,
      });
      return text(formatReport(report, code), {
        ok: report.ok,
        typescript: report.typescript,
        diagnostics: report.diagnostics.map((d) => ({ ...d })),
      });
    },
  };

  return [searchDocs, listPackages, getPackage, listExamples, checkSnippetTool];
}
