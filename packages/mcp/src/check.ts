import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fault, rangeError, typeError } from '../../shared/errors.js';

/** One problem the compiler found in a snippet. */
export interface SnippetDiagnostic {
  /** 1-based line in the snippet. */
  line: number;
  /** 1-based column. */
  column: number;
  /** The compiler's code, `TS2305`. */
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

/** The result of {@link checkSnippet}. */
export interface SnippetReport {
  /** True when the compiler found no errors. */
  ok: boolean;
  diagnostics: SnippetDiagnostic[];
  /** The TypeScript version that checked it. */
  typescript: string;
  /** The folder whose `node_modules` supplied the `@margoengine/*` types. */
  projectRoot: string;
}

/** Options of {@link checkSnippet}. */
export interface CheckOptions {
  /** A folder with `typescript` and the Margo packages in its `node_modules` (default: the current directory). */
  projectRoot?: string;
  /** `ts` (default), `tsx` or `js`. A `js` snippet is checked as JavaScript with `checkJs`. */
  language?: 'ts' | 'tsx' | 'js';
  /** Strict mode (default true). */
  strict?: boolean;
  /** Stops the compiler and rejects when aborted. */
  signal?: AbortSignal;
  /** Longest compile in milliseconds (default 60000). */
  timeoutMs?: number;
}

const MAX_SNIPPET = 200_000;

/** `tsc` and its version, found from the project, or undefined when TypeScript is not installed there. */
function findCompiler(projectRoot: string): { script: string; version: string } | undefined {
  try {
    const require = createRequire(join(projectRoot, 'package.json'));
    const manifest = require.resolve('typescript/package.json');
    const script = join(dirname(manifest), 'bin', 'tsc');
    if (!existsSync(script)) return undefined;
    return { script, version: (require(manifest) as { version: string }).version };
  } catch {
    return undefined;
  }
}

function parseDiagnostics(output: string): SnippetDiagnostic[] {
  const out: SnippetDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^snippet\.\w+\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
    if (match)
      out.push({
        line: Number(match[1]),
        column: Number(match[2]),
        severity: match[3] as 'error' | 'warning',
        code: match[4],
        message: match[5],
      });
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1].message += `\n${line.trim()}`;
  }
  return out;
}

/**
 * Type-checks `code` with the project's own TypeScript against the real types of the Margo packages installed in
 * its `node_modules` (imports of `margoengine`, `@margoengine/core` and the rest resolve exactly as in an app).
 * The snippet is only compiled, never run. Rejects with a MargoError: `unsupported` when TypeScript is not installed
 * in the project, `failed` when the compiler does not run.
 */
export async function checkSnippet(code: string, options: CheckOptions = {}): Promise<SnippetReport> {
  if (typeof code !== 'string' || !code.trim()) throw typeError('check_snippet needs a non-empty code string', 'mcp');
  if (code.length > MAX_SNIPPET)
    throw rangeError('The snippet is over 200000 characters; check one file at a time', 'mcp');
  const language = options.language ?? 'ts';
  if (language !== 'ts' && language !== 'tsx' && language !== 'js') throw typeError('language is ts, tsx or js', 'mcp');
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const compiler = findCompiler(projectRoot);
  if (!compiler)
    throw fault(
      'unsupported',
      `TypeScript is not installed in ${projectRoot}; run npm install typescript there or start the server with --root <folder>`,
      'mcp',
    );
  // Inside node_modules so that module resolution walks up to the project's installed packages.
  const cache = join(projectRoot, 'node_modules', '.cache', 'margoengine-mcp');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, 'check-'));
  try {
    const file = `snippet.${language}`;
    // `export {}` makes a snippet without imports a module, so top-level await and `using` are allowed.
    await writeFile(join(dir, file), `${code}\nexport {};\n`);
    const webgpu = existsSync(join(projectRoot, 'node_modules', '@webgpu', 'types')) ? ['@webgpu/types'] : [];
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ESNext', 'DOM', 'DOM.Iterable'],
          strict: options.strict ?? true,
          noEmit: true,
          skipLibCheck: true,
          jsx: 'react-jsx',
          allowJs: language === 'js',
          checkJs: language === 'js',
          resolveJsonModule: true,
          types: webgpu,
        },
        files: [file],
      }),
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 60_000)])
      : AbortSignal.timeout(options.timeoutMs ?? 60_000);
    const output = await new Promise<string>((done, fail) => {
      execFile(
        process.execPath,
        [compiler.script, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'],
        { cwd: dir, signal, maxBuffer: 16 << 20, windowsHide: true },
        (error, stdout, stderr) => {
          const text = `${stdout}${stderr}`;
          // The compiler exits 2 when it reports errors; that is the answer, not a failure.
          if (error && (error as { name?: string }).name === 'AbortError') {
            if (options.signal?.aborted) fail(error);
            else
              fail(
                fault(
                  'failed',
                  'The type check took longer than the time limit; check a shorter snippet or raise timeoutMs',
                  'mcp',
                ),
              );
          } else if (error && !/\(\d+,\d+\): (error|warning) TS\d+/.test(text))
            fail(
              fault(
                'failed',
                `The TypeScript compiler did not run: ${text.trim().slice(0, 300) || String(error)}`,
                'mcp',
              ),
            );
          else done(text);
        },
      );
    });
    const diagnostics = parseDiagnostics(output);
    return {
      ok: !diagnostics.some((d) => d.severity === 'error'),
      diagnostics,
      typescript: compiler.version,
      projectRoot,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A report as text for a model: the verdict, then each problem with its line and the source it points at. */
export function formatReport(report: SnippetReport, code: string): string {
  if (!report.diagnostics.length) return `OK: no type errors (TypeScript ${report.typescript}).`;
  const lines = [
    `${report.ok ? 'OK with warnings' : 'FAILED'}: ${report.diagnostics.length} problem(s) (TypeScript ${report.typescript}).`,
  ];
  for (const d of report.diagnostics) {
    lines.push(`line ${d.line}:${d.column} ${d.severity} ${d.code}: ${d.message}`);
    const source = (code.split('\n')[d.line - 1] ?? '').trim();
    if (source) lines.push(`    ${source}`);
  }
  return lines.join('\n');
}
