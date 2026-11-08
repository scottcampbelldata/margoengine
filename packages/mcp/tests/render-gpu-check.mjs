// Real-GPU proof of render_snippet in Node, with no browser (from the repository root after building packages):
//   node scripts/gpu-lock.mjs run --owner=<you> -- node packages/mcp/tests/render-gpu-check.mjs
// Renders one scene through the tool on the repository's own webgpu binding and @margoengine/headless, and checks the
// PNG it answers with: the size asked for, and the green box drawn in the middle of the frame. A snippet that adds nothing
// draws one colour, and the tool says nothing is in view. MARGO_NODE_GPU=<adapter name> picks an adapter.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decodePNG } from '../../../tests/support/png.js';
import { createRenderTool } from '../dist/render.js';

const root = resolve(import.meta.dirname, '../../..');
const tool = createRenderTool({
  projectRoot: root,
  gpuFlags: process.env.MARGO_NODE_GPU ? [`adapter=${process.env.MARGO_NODE_GPU}`] : [],
});
const context = { signal: AbortSignal.timeout(180_000) };
const code = `import type { Stage } from '@margoengine/stage';
import { addSky } from '@margoengine/stage/sky';

export default async (stage: Stage) => {
  stage.box({ color: '#84d6bd' });
  await addSky(stage);
  stage.fit();
};
`;
const result = await tool.run({ code, width: 320, height: 200 }, context);
assert.equal(result.isError, undefined, result.content.at(-1)?.text);
const [image, text] = result.content;
assert.equal(image.type, 'image');
const png = await decodePNG(new Uint8Array(Buffer.from(image.data, 'base64')));
assert.deepEqual([png.width, png.height], [320, 200]);
const drawn = result.structuredContent.drawnPixels;
assert.ok(drawn > 1000, `the box covers more than 1,000 pixels (${drawn})`);
const centre = ((100 * 320 + 160) * 4),
  [r, g, b] = png.data.slice(centre, centre + 3);
assert.ok(g > r + 40 && g > b, `the centre pixel is the green box (${r}, ${g}, ${b})`);
console.log(text.text);
const empty = await tool.run({ code: 'export default () => {};', width: 64, height: 64 }, context);
assert.equal(empty.structuredContent.drawnPixels, 0);
assert.match(empty.content[1].text, /nothing is in view/);
console.log(`render_snippet GPU check: OK (${drawn} of ${320 * 200} pixels drawn, empty scene one colour)`);
