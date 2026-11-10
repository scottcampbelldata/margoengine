// Full-payload GL stream diagnostic for the unchanged SSGI bounce fixture.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { postBrowser as harness } from '../packages/post/test/post-browser.mjs';

const backend = process.env.PROBE_ANGLE || 'd3d11';
const records = [];
function installRecorder() {
  const proto = WebGL2RenderingContext.prototype,
    ids = new WeakMap();
  let next = 0;
  const bytes = (v) =>
    Array.from(new Uint8Array(v.buffer ?? v, v.byteOffset ?? 0, v.byteLength), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
  const snap = (v) => {
    if (v == null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return { type: v.constructor.name, hex: bytes(v) };
    if (Array.isArray(v)) return v.map(snap);
    if (!ids.has(v)) ids.set(v, v.constructor.name + '#' + next++);
    return ids.get(v);
  };
  const r = (globalThis.glRec = { on: false, calls: [], ids, gl: null, early: [] });
  for (const name of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof d.value !== 'function' || name === 'constructor') continue;
    const original = d.value;
    proto[name] = function (...args) {
      const input = r.on ? args.map(snap) : null;
      const result = original.apply(this, args);
      r.gl ??= this;
      if (name.startsWith('create') || name === 'fenceSync' || name === 'getUniformLocation') snap(result);
      if (r.on) r.calls.push([name, input, /^(create|get|is|clientWait|check|fence)/.test(name) ? snap(result) : null]);
      if (name === 'blitFramebuffer' && r.target) {
        const read = this.getParameter(this.READ_FRAMEBUFFER_BINDING),
          draw = this.getParameter(this.DRAW_FRAMEBUFFER_BINDING);
        if (
          draw &&
          this.getFramebufferAttachmentParameter(
            this.DRAW_FRAMEBUFFER,
            this.COLOR_ATTACHMENT0,
            this.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
          ) === r.target
        ) {
          const pack = this.getParameter(this.PIXEL_PACK_BUFFER_BINDING),
            buffer = this.createBuffer();
          this.bindFramebuffer(this.READ_FRAMEBUFFER, draw);
          this.bindBuffer(this.PIXEL_PACK_BUFFER, buffer);
          this.bufferData(this.PIXEL_PACK_BUFFER, 320 * 240 * 4, this.STREAM_READ);
          this.readPixels(0, 0, 320, 240, this.RGBA, this.UNSIGNED_BYTE, 0);
          this.bindBuffer(this.PIXEL_PACK_BUFFER, pack);
          this.bindFramebuffer(this.READ_FRAMEBUFFER, read);
          r.early.push(buffer);
        }
      }
      return result;
    };
  }
}
async function postBrowser(owner, port, open, run) {
  return harness(owner, port, open, async (page, shot) => {
    await page.evaluate(installRecorder);
    const snapshot = async () => {
      const rereads = process.env.PROBE_READS
        ? await page.evaluate(async (hdr) => {
            const device = window.t.engine.gpu,
              gl = device.gl;
            const texture = hdr
              ? window.probeStack.sceneTexture
              : document.querySelector('canvas').getContext('webgpu').getCurrentTexture();
            const fbo = device.replayer.framebufferOf(texture);
            if (!hdr) glRec.target = texture.texture;
            const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
              pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
            const ArrayType = hdr ? Float32Array : Uint8Array,
              type = hdr ? gl.FLOAT : gl.UNSIGNED_BYTE;
            const first = new ArrayType(320 * 240 * 4),
              second = new ArrayType(first.length);
            const buffer = gl.createBuffer();
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.bufferData(gl.PIXEL_PACK_BUFFER, first.byteLength, gl.STREAM_READ);
            gl.readPixels(0, 0, 320, 240, gl.RGBA, type, 0);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            gl.readPixels(0, 0, 320, 240, gl.RGBA, type, second);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, first);
            gl.deleteBuffer(buffer);
            let changed = 0,
              max = 0;
            const differences = [];
            for (let i = 0; i < first.length; i++)
              if (first[i] !== second[i]) {
                changed++;
                max = Math.max(max, Math.abs(first[i] - second[i]));
                differences.push([i, first[i], second[i]]);
              }
            const error = gl.getError();
            const early = [];
            for (const b of glRec.early) {
              gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
              const data = new Uint8Array(320 * 240 * 4);
              gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
              gl.deleteBuffer(b);
              let changed = 0,
                max = 0;
              const differences = [];
              for (let i = 0; i < data.length; i++)
                if (data[i] !== second[i]) {
                  changed++;
                  max = Math.max(max, Math.abs(data[i] - second[i]));
                  differences.push([i, data[i], second[i]]);
                }
              early.push({ changed, max, differences });
            }
            glRec.early = [];
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
            return {
              texture: glRec.ids.get(texture.texture),
              format: texture.format,
              changed,
              max,
              differences,
              error,
              early,
            };
          }, process.env.PROBE_HDR === '1')
        : undefined;
      const image = await shot();
      const calls = await page.evaluate(() => {
        glRec.on = false;
        return glRec.calls;
      });
      records.push({ calls, rereads, pixels: Buffer.from(image.data).toString('base64') });
      return image;
    };
    try {
      await run(page, snapshot);
    } finally {
      writeFileSync(
        `test-results/review5-ssgi-streams-${backend}${process.env.PROBE_READS ? (process.env.PROBE_HDR ? '-hdr-reads' : '-pbo-reads') : ''}.json`,
        JSON.stringify(records),
      );
      console.log(
        'STREAMS',
        backend,
        records.map((r, i) => ({ i, calls: r.calls.length })),
      );
    }
  });
}
let source = readFileSync('packages/post/test/ssgi-bounce-browser.mjs', 'utf8');
source = source
  .replace("'../../../scripts/lib/browser.mjs'", JSON.stringify(pathToFileURL(resolve('scripts/lib/browser.mjs')).href))
  .replace("import { postBrowser } from './post-browser.mjs';", '')
  .replace('PostStack.attach(engine, [ssgi]);', 'window.probeStack = PostStack.attach(engine, [ssgi]);')
  .replace('launchBrowser({ headless: true })', `launchBrowser({headless:true,args:['--use-angle=${backend}']})`)
  .replace(
    'await page.evaluate(`${code}; window.t.frames(${n})`);',
    'await page.evaluate(() => {glRec.calls=[];glRec.on=true;}); await page.evaluate(`${code}; window.t.frames(${n})`);',
  )
  .replace(
    'await page.evaluate(() => window.t.engine.dispose());',
    'for(let extra=0;extra<12;extra++) await frames(1); await page.evaluate(() => window.t.engine.dispose());',
  );
globalThis.__review5Probe = postBrowser;
source = 'const postBrowser = globalThis.__review5Probe;\n' + source;
try {
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
