// render_snippet without a GPU: a stand-in project whose @margoengine/headless/stage and webgpu are small fakes, so the
// child process, the time limit, the files and the answers are tested on any machine. The real GPU run is
// tests/render-gpu-check.mjs (npm run test:gpu).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createMargoServer } from '../dist/index.js';
import { createRenderTool, renderSnippet } from '../dist/render.js';
import { corpus } from './support.js';

let project;

const FAKE_STAGE = `export async function createHeadlessStage({ gpu, width, height }) {
  const pixels = new Uint8Array(width * height * 4);
  let lit = false;
  return {
    engine: { gpu: { addEventListener(type, listener) { if (gpu.fail) queueMicrotask(() => listener({ error: { message: 'bad bind group' } })); } } },
    box() { lit = true; },
    fit() {},
    async readPixels() {
      if (lit) for (let i = 4; i < 44; i += 4) pixels[i] = 255; // ten pixels after the corner
      return { width, height, data: pixels };
    },
    async toPNG() { return new TextEncoder().encode('PNG ' + width + 'x' + height + ' gpu ' + gpu.flags.join(',')); },
    dispose() {},
  };
}
`;

before(async () => {
  project = await mkdtemp(join(tmpdir(), 'mcp-render-'));
  const pkg = async (name, exports, files) => {
    const dir = join(project, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports }));
    for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  };
  await pkg('@margoengine/headless', { './stage': './stage.js' }, { 'stage.js': FAKE_STAGE });
  await pkg('@margoengine/stage', { '.': './index.js' }, { 'index.js': 'export const stage = 1;\n' });
  await pkg('webgpu', { '.': './index.js' }, {
    'index.js': "export const create = (flags) => ({ flags, fail: flags.includes('fail') });\n",
  });
});

after(async () => {
  await rm(project, { recursive: true, force: true });
});

const cacheEmpty = () => {
  const cache = join(project, 'node_modules', '.cache', 'margoengine-mcp');
  return !existsSync(cache) || readdirSync(cache).length === 0;
};

test('renderSnippet runs the default export on a headless stage and gives back the frame, its size and the console', async () => {
  const result = await renderSnippet(
    'export default async (stage: { box(): void; fit(): void }) => { stage.box(); stage.fit(); console.log("drew"); };',
    { projectRoot: project, width: 64, height: 32, gpuFlags: ['adapter=x'] },
  );
  assert.equal(new TextDecoder().decode(result.png), 'PNG 64x32 gpu adapter=x', 'size and binding flags reach the stage');
  assert.deepEqual([result.width, result.height, result.drawnPixels], [64, 32, 10]);
  assert.equal(result.output, 'drew');
  assert.ok(result.ms >= 0);
  assert.ok(cacheEmpty(), 'the run folder is removed');
  const empty = await renderSnippet('export default () => {}', { projectRoot: project, language: 'js', width: 16, height: 16 });
  assert.equal(empty.drawnPixels, 0, 'nothing drawn: every pixel is the corner colour');
  const below = join(project, 'src', 'scenes');
  await mkdir(below, { recursive: true });
  const found = await renderSnippet('export default (s) => s.box()', { projectRoot: below, language: 'js', width: 16, height: 16 });
  assert.equal(found.drawnPixels, 10, 'a folder below the project finds its node_modules, as Node resolution does');
});

test('renderSnippet fails with the snippet error, a missing default export, GPU errors and the time limit', async () => {
  const options = { projectRoot: project, width: 16, height: 16 };
  await assert.rejects(renderSnippet('export default () => { throw new Error("boom here"); }', options), {
    code: 'failed',
    message: /The snippet did not render: [\s\S]*boom here/,
  });
  await assert.rejects(renderSnippet('export const x = 1;', options), {
    code: 'failed',
    message: /no default export function/,
  });
  await assert.rejects(renderSnippet('export default async (s) => { s.box(); await new Promise((r) => setTimeout(r, 10)); }', { ...options, language: 'js', gpuFlags: ['fail'] }), {
    code: 'failed',
    message: /WebGPU validation errors:\s+bad bind group/,
  });
  // The snippet never ends by itself, so the promise settling at all proves the child was killed at the limit.
  await assert.rejects(renderSnippet('export default () => new Promise(() => setInterval(() => {}, 1000));', { ...options, timeoutMs: 1000 }), {
    code: 'failed',
    message: /longer than 1000 ms/,
  });
  const controller = new AbortController();
  const pending = renderSnippet('export default () => new Promise(() => setInterval(() => {}, 1000));', { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(cacheEmpty(), 'failed runs remove their folder too');
});

test('renderSnippet checks its arguments and the project before running anything', async () => {
  await assert.rejects(renderSnippet(' '), { name: 'TypeError', message: /errors#mcp/ });
  await assert.rejects(renderSnippet('x', { width: 8 }), { name: 'RangeError', message: /16 to 2048/ });
  await assert.rejects(renderSnippet('x', { height: 1.5 }), { name: 'RangeError' });
  await assert.rejects(renderSnippet('x', { timeoutMs: 10 }), { name: 'RangeError', message: /1000 to 300000/ });
  await assert.rejects(renderSnippet('x', { language: 'py' }), { name: 'TypeError', message: /ts or js/ });
  await assert.rejects(renderSnippet('x', { gpuFlags: [1] }), { name: 'TypeError' });
  const bare = await mkdtemp(join(tmpdir(), 'mcp-render-bare-'));
  await assert.rejects(renderSnippet('x', { projectRoot: bare }), {
    code: 'unsupported',
    message: /needs @margoengine\/headless, @margoengine\/stage, webgpu in /,
  });
  await assert.rejects(renderSnippet('export default (: = ) => {}', { projectRoot: project }), {
    name: 'TypeError',
    message: /not valid TypeScript/,
  });
});

test('render_snippet answers with the PNG as image content, says when nothing is in view, and rejects bad arguments', async () => {
  const tool = createRenderTool({ projectRoot: project });
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, true, 'it runs code with the user rights');
  const context = { signal: new AbortController().signal };
  const result = await tool.run({ code: 'export default (s) => { s.box(); }', language: 'js', width: 32, height: 16 }, context);
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].mimeType, 'image/png');
  assert.equal(Buffer.from(result.content[0].data, 'base64').toString(), 'PNG 32x16 gpu ');
  assert.match(result.content[1].text, /^Rendered 32 x 16 in \d+ ms; 10 pixels differ from the corner\.$/);
  assert.equal(result.structuredContent.drawnPixels, 10);
  const empty = await tool.run({ code: 'export default () => {}', width: 16, height: 16 }, context);
  assert.match(empty.content[1].text, /nothing is in view\. Call stage\.fit\(\)/);
  await assert.rejects(tool.run({}, context), { name: 'TypeError', message: /non-empty code/ });
  await assert.rejects(tool.run({ code: 'x', width: '9' }, context), { name: 'TypeError', message: /width must be an integer/ });
  await assert.rejects(tool.run({ code: 'x', language: 'tsx' }, context), { name: 'TypeError', message: /ts or js/ });
});

test('the Margo server offers render_snippet only when asked to', async () => {
  const names = async (server) =>
    (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((tool) => tool.name);
  {
    using server = await createMargoServer({ corpus, projectRoot: project });
    assert.ok(!(await names(server)).includes('render_snippet'));
  }
  using server = await createMargoServer({ corpus, projectRoot: project, render: true });
  assert.ok((await names(server)).includes('render_snippet'));
  const answer = await server.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'render_snippet', arguments: { code: 'export default (s) => s.box()', width: 16, height: 16 } },
  });
  assert.equal(answer.result.isError, undefined);
  assert.equal(answer.result.content[0].type, 'image');
});
