// @margoengine/mcp/render: renders a snippet to a PNG in Node, with no page, through @margoengine/headless and the
// project's own WebGPU binding (`webgpu`), so a model can see what its Margo code draws. The snippet runs in a child
// Node process with a time limit, from a folder inside the project's node_modules, so its imports resolve exactly as in
// the app. It runs with the user's rights: the server offers the tool only when it is started with --render.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as nodeModule from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import type { Json, ToolDefinition, ToolResult } from './server.js';

/** Options of {@link renderSnippet}; every one has a default. */
export interface RenderOptions {
  /** Folder whose node_modules (or a folder above it whose node_modules) holds `@margoengine/headless`, `@margoengine/stage` and `webgpu` (default: the current directory). */
  projectRoot?: string;
  /** Image width in pixels, 16 to 2048 (default 512). */
  width?: number;
  /** Image height in pixels, 16 to 2048 (default 512). */
  height?: number;
  /** `ts` (types are stripped, never checked: use check_snippet) or `js` (default `ts`). */
  language?: 'ts' | 'js';
  /** Time limit of the whole run in milliseconds, 1000 to 300000 (default 60000). The process is killed after it. */
  timeoutMs?: number;
  /** Flags for the binding's `create(flags)`, for example `['adapter=Microsoft Basic Render Driver']` (default none). */
  gpuFlags?: readonly string[];
  /** Abort to kill the run. */
  signal?: AbortSignal;
}

/** What {@link renderSnippet} gives back. */
export interface RenderResult {
  /** The frame as PNG file bytes. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Pixels whose colour differs from the top-left one: 0 means nothing was drawn in view. */
  drawnPixels: number;
  /** What the snippet wrote to the console (stdout and stderr), cut to its last 4,000 characters. */
  output: string;
  /** Wall time of the run in milliseconds, process start included. */
  ms: number;
}

const MAX_SNIPPET = 200_000;
const OUTPUT = 4_000;

// The child: makes a headless stage on the project's binding, hands it to the snippet's default export, then writes
// the frame and a count of drawn pixels. GPU validation errors fail the run.
const RUNNER = `import { writeFile } from 'node:fs/promises';
import { createHeadlessStage } from '@margoengine/headless/stage';
import { create } from 'webgpu';

const [snippet, out, width, height, flags] = process.argv.slice(2);
const errors = [];
const stage = await createHeadlessStage({ gpu: create(JSON.parse(flags)), width: Number(width), height: Number(height) });
try {
  stage.engine.gpu?.addEventListener?.('uncapturederror', (event) => errors.push(event.error.message));
  const module = await import(snippet);
  if (typeof module.default !== 'function') {
    process.exitCode = 3;
    console.error('The snippet has no default export function: write export default (stage) => { ... }');
  } else {
    await module.default(stage);
    const pixels = await stage.readPixels();
    let drawn = 0;
    const d = pixels.data;
    for (let i = 0; i < d.length; i += 4)
      if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 16) drawn++;
    await writeFile(out + '.png', await stage.toPNG());
    if (errors.length) {
      process.exitCode = 4;
      console.error('WebGPU validation errors:\\n' + errors.join('\\n'));
    } else await writeFile(out + '.json', JSON.stringify({ drawn }));
  }
} finally {
  stage.dispose();
}
`;

const isSize = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** The packages a render needs in the project, by folder under node_modules. */
const NEEDS = ['@margoengine/headless', '@margoengine/stage', 'webgpu'];

/** `folder` or the nearest folder above it whose node_modules holds every package a render needs, as Node resolves them. */
function findProject(folder: string): string | undefined {
  for (let current = folder; ; ) {
    if (NEEDS.every((name) => existsSync(join(current, 'node_modules', name, 'package.json')))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Runs `code` (a module whose default export takes a headless `Stage`) in a child Node process and resolves with the
 * frame it leaves as PNG bytes. Rejects with a MargoError: `unsupported` when the project lacks a package the render
 * needs, or TypeScript stripping needs a newer Node; `failed` when the snippet throws, has no default export, the GPU
 * reports a validation error or the time limit passes.
 */
export async function renderSnippet(code: string, options: RenderOptions = {}): Promise<RenderResult> {
  if (typeof code !== 'string' || !code.trim()) throw typeError('render_snippet needs a non-empty code string', 'mcp');
  if (code.length > MAX_SNIPPET) throw rangeError('The snippet is over 200000 characters; check one file at a time', 'mcp');
  const width = options.width ?? 512,
    height = options.height ?? 512,
    timeoutMs = options.timeoutMs ?? 60_000,
    language = options.language ?? 'ts';
  if (!isSize(width) || !isSize(height) || width < 16 || height < 16 || width > 2048 || height > 2048)
    throw rangeError('width and height are integers from 16 to 2048', 'mcp');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300_000)
    throw rangeError('timeoutMs is from 1000 to 300000', 'mcp');
  if (language !== 'ts' && language !== 'js') throw typeError('language is ts or js', 'mcp');
  const flags = options.gpuFlags ?? [];
  if (!Array.isArray(flags) || flags.some((flag) => typeof flag !== 'string'))
    throw typeError('gpuFlags is an array of strings', 'mcp');
  const start = resolve(options.projectRoot ?? process.cwd());
  const projectRoot = findProject(start);
  if (projectRoot === undefined) {
    const missing = NEEDS.filter((name) => !existsSync(join(start, 'node_modules', name, 'package.json')));
    throw fault(
      'unsupported',
      `render_snippet needs ${missing.join(', ')} in ${start}/node_modules or a folder above it; run npm install ${missing.join(' ')} there or start the server with --root <folder>`,
      'mcp',
    );
  }
  let source = code;
  if (language === 'ts') {
    const strip = (nodeModule as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;
    if (typeof strip !== 'function')
      throw fault('unsupported', 'TypeScript snippets need Node 22.13 or newer; pass language js or update Node', 'mcp');
    try {
      source = strip(code);
    } catch (error) {
      throw typeError(`The snippet is not valid TypeScript: ${(error as Error).message}`, 'mcp');
    }
  }
  // Inside node_modules so that module resolution walks up to the project's installed packages.
  const cache = join(projectRoot, 'node_modules', '.cache', 'margoengine-mcp');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, 'render-'));
  const started = performance.now();
  try {
    await writeFile(join(dir, 'snippet.mjs'), source);
    await writeFile(join(dir, 'runner.mjs'), RUNNER);
    const out = join(dir, 'frame');
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    const output = await new Promise<string>((done, fail) => {
      execFile(
        process.execPath,
        [
          join(dir, 'runner.mjs'),
          pathToFileURL(join(dir, 'snippet.mjs')).href,
          out,
          String(width),
          String(height),
          JSON.stringify(flags),
        ],
        { cwd: projectRoot, signal, killSignal: 'SIGKILL', maxBuffer: 16 << 20, windowsHide: true },
        (error, stdout, stderr) => {
          const text = `${stdout}${stderr}`.trim();
          if (error && (error as { name?: string }).name === 'AbortError') {
            if (options.signal?.aborted) fail(error);
            else
              fail(fault('failed', `The render took longer than ${timeoutMs} ms and was stopped; draw less or raise timeoutMs`, 'mcp'));
          } else if (error)
            fail(fault('failed', `The snippet did not render: ${text.slice(-1500) || String(error)}`, 'mcp'));
          else done(text);
        },
      );
    });
    let drawn: number, png: Buffer;
    try {
      drawn = (JSON.parse(await readFile(`${out}.json`, 'utf8')) as { drawn: number }).drawn;
      png = await readFile(`${out}.png`);
    } catch {
      throw fault('failed', `The snippet did not render: the run wrote no frame. ${output.slice(-1500)}`, 'mcp');
    }
    return {
      png: new Uint8Array(png),
      width,
      height,
      drawnPixels: drawn,
      output: output.slice(-OUTPUT),
      ms: Math.round(performance.now() - started),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Options of {@link createRenderTool}. */
export interface RenderToolOptions {
  /** As {@link RenderOptions.projectRoot}. */
  projectRoot?: string;
  /** As {@link RenderOptions.gpuFlags}. */
  gpuFlags?: readonly string[];
}

/** The `render_snippet` tool. It runs code with the user's rights; offer it only when the user asked for it. */
export function createRenderTool(options: RenderToolOptions = {}): ToolDefinition {
  return {
    name: 'render_snippet',
    title: 'Render a Margo snippet to a picture',
    description:
      'Runs a Margo snippet in Node on the real GPU (through @margoengine/headless and the webgpu binding) and returns the picture it draws as a PNG. The snippet is a module whose default export takes a headless Stage: export default async (stage) => { stage.box({ color: "#84d6bd" }); stage.fit(); }. Imports resolve from the project (stage feature entries such as @margoengine/stage/sky work). Nothing is drawn in view unless the snippet places the camera (stage.fit()). Type-check with check_snippet first: types are stripped, not checked. The code runs on the user\'s machine with their rights.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The module: export default (stage) => { ... }, sync or async.' },
        language: { type: 'string', enum: ['ts', 'js'], description: 'Default ts (types stripped, not checked).' },
        width: { type: 'integer', minimum: 16, maximum: 2048, description: 'Default 512.' },
        height: { type: 'integer', minimum: 16, maximum: 2048, description: 'Default 512.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Default 60000.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run(args, context): Promise<ToolResult> {
      const code = args.code;
      if (typeof code !== 'string' || !code.trim())
        throw typeError('render_snippet needs a non-empty code string', 'mcp');
      for (const key of ['width', 'height', 'timeoutMs'] as const)
        if (args[key] !== undefined && !isSize(args[key])) throw typeError(`${key} must be an integer`, 'mcp');
      if (args.language !== undefined && args.language !== 'ts' && args.language !== 'js')
        throw typeError('language is ts or js', 'mcp');
      const result = await renderSnippet(code, {
        projectRoot: options.projectRoot,
        gpuFlags: options.gpuFlags,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
        timeoutMs: args.timeoutMs as number | undefined,
        language: args.language as 'ts' | 'js' | undefined,
        signal: context.signal,
      });
      const empty = result.drawnPixels === 0;
      const text = [
        `Rendered ${result.width} x ${result.height} in ${result.ms} ms; ${result.drawnPixels} pixels differ from the corner.`,
        ...(empty ? ['Every pixel is one colour: nothing is in view. Call stage.fit() after adding objects, or place the camera.'] : []),
        ...(result.output ? ['Console:', result.output] : []),
      ].join('\n');
      return {
        content: [
          { type: 'image', data: Buffer.from(result.png).toString('base64'), mimeType: 'image/png' },
          { type: 'text', text },
        ],
        structuredContent: {
          width: result.width,
          height: result.height,
          bytes: result.png.length,
          drawnPixels: result.drawnPixels,
          ms: result.ms,
          output: result.output,
        } as { [key: string]: Json },
      };
    },
  };
}
