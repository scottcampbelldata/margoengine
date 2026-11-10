// Diagnostic only: execute the unchanged SSGI bounce fixture and dump raw render targets.
// Run from the repository root after build:packages with --compat and PROBE_ANGLE=d3d11|vulkan.
// D3D11 retains the original assertion failure; no test or tolerance is replaced.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { postBrowser as harness } from '../packages/post/test/post-browser.mjs';
const backend = process.env.PROBE_ANGLE || 'd3d11';
function install() {
  const glp = WebGL2RenderingContext.prototype,
    original = {},
    ids = new WeakMap(),
    meta = new WeakMap();
  let serial = 0,
    busy = false;
  const id = (o) => {
    if (!o) return null;
    if (!ids.has(o)) ids.set(o, serial++);
    return ids.get(o);
  };
  const r = (globalThis.targetProbe = { frame: 0, draw: 0, records: [], shaders: {}, errors: [], debug: [] });
  const caches = new WeakMap();
  const debug = (gl) => {
    const originalProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    const shaders = gl.getAttachedShaders(originalProgram) || [];
    const fragment = shaders.find((s) => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER);
    const code = fragment && gl.getShaderSource(fragment);
    if (!code?.includes('vec4 lsum_14') || code.includes('binding(9)') || ![2, 47, 48].includes(r.frame)) return;
    const oldDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      oldRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      oldTex = gl.getParameter(gl.TEXTURE_BINDING_2D),
      scissor = gl.isEnabled(gl.SCISSOR_TEST),
      box = gl.getParameter(gl.SCISSOR_BOX);
    let cached = caches.get(originalProgram);
    if (!cached) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      original.texStorage2D.call(gl, gl.TEXTURE_2D, 1, gl.RGBA32F, 320, 240);
      gl.bindTexture(gl.TEXTURE_2D, oldTex);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      cached = { fbo, programs: [] };
      caches.set(originalProgram, cached);
      const modes = [
        ['normal-depth', 'return vec4(ln_5,ld_2);', '  uint lcount_12'],
        ['position', 'return vec4(lp_4,1.0);', '  uint lcount_12'],
        ['start', 'return vec4(lstart_11,1.0);', '  uint lcount_12'],
      ];
      for (let j = 0; j < 4; j++)
        for (const [name, expr] of [
          ['ray-source', 'vec4(((lt1_9 * lk_16.x) + (lt2_10 * lk_16.y)) + (ln_5 * lk_16.z),1.0)'],
          ['sample', 'vec4(lk_16,1.0)'],
          ['ray', 'vec4(lr_17,1.0)'],
          ['hit', 'lh_18'],
          ['weighted-light', 'vec4(llight_24 * lw_22,lw_22)'],
        ])
          modes.push([
            name + j,
            `if(lj_15==${j}u)return ${expr};`,
            name === 'weighted-light' ? '    lsum_14 +=' : '    if ((lh_18.w',
          ]);
      for (const [name, insert, needle] of modes) {
        const src = code.replace(needle, insert + '\n' + needle);
        if (src === code) throw Error('debug replacement ' + name);
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, src);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(fs));
        const program = gl.createProgram();
        gl.attachShader(
          program,
          shaders.find((s) => s !== fragment),
        );
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
        for (let i = 0; i < gl.getProgramParameter(originalProgram, gl.ACTIVE_UNIFORM_BLOCKS); i++) {
          const blockName = gl.getActiveUniformBlockName(originalProgram, i),
            index = gl.getUniformBlockIndex(program, blockName);
          if (index !== gl.INVALID_INDEX)
            gl.uniformBlockBinding(
              program,
              index,
              gl.getActiveUniformBlockParameter(originalProgram, i, gl.UNIFORM_BLOCK_BINDING),
            );
        }
        cached.programs.push({ name, program });
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, cached.fbo);
    gl.enable(gl.SCISSOR_TEST);
    const sites = [
      [110, 74],
      [300, 76],
      [265, 147],
      [295, 155],
      [122, 150],
    ];
    for (const { name, program } of cached.programs) {
      gl.useProgram(program);
      for (let i = 0; i < gl.getProgramParameter(originalProgram, gl.ACTIVE_UNIFORMS); i++) {
        const u = gl.getActiveUniform(originalProgram, i),
          loc = gl.getUniformLocation(program, u.name),
          old = gl.getUniformLocation(originalProgram, u.name);
        if (!loc || !old) continue;
        const v = gl.getUniform(originalProgram, old);
        if ([gl.INT, gl.SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D].includes(u.type)) gl.uniform1i(loc, v);
        else if (u.type === gl.UNSIGNED_INT) gl.uniform1ui(loc, v);
        else if (u.type === gl.INT_VEC4) gl.uniform4iv(loc, v);
        else if (u.type === gl.FLOAT_VEC3) gl.uniform3fv(loc, v);
        else throw Error('unknown uniform ' + u.name + ' ' + u.type);
      }
      const values = [];
      for (const [x, y] of sites) {
        gl.scissor(x, y, 1, 1);
        original.drawArrays.call(gl, gl.TRIANGLES, 0, 3);
        const v = new Float32Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, v);
        values.push(Array.from(v));
      }
      r.debug.push({ frame: r.frame, draw: r.draw, name, sites, values, error: gl.getError() });
    }
    gl.useProgram(originalProgram);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, oldDraw);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, oldRead);
    gl.scissor(...box);
    if (!scissor) gl.disable(gl.SCISSOR_TEST);
  };
  const capture = (gl) => {
    if (busy || ![2, 46, 47, 48].includes(r.frame)) return;
    busy = true;
    try {
      const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
      if (!draw) return;
      const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
        pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
        readBuffer = gl.getParameter(gl.READ_BUFFER);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, draw);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const program = gl.getParameter(gl.CURRENT_PROGRAM),
        pid = id(program);
      if (program && !r.shaders[pid]) r.shaders[pid] = gl.getAttachedShaders(program).map((s) => gl.getShaderSource(s));
      for (let a = 0; a < 3; a++) {
        const att = gl.COLOR_ATTACHMENT0 + a;
        const tex = gl.getFramebufferAttachmentParameter(
          gl.DRAW_FRAMEBUFFER,
          att,
          gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
        );
        const m = tex && meta.get(tex);
        if (!m || m.samples) continue;
        const level = gl.getFramebufferAttachmentParameter(
          gl.DRAW_FRAMEBUFFER,
          att,
          gl.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL,
        );
        const width = Math.max(1, m.width >> level),
          height = Math.max(1, m.height >> level);
        gl.readBuffer(att);
        const type = [34842, 33326].includes(m.format) ? gl.FLOAT : gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE),
          fmt = gl.RGBA;
        const data =
          type === gl.FLOAT
            ? new Float32Array(width * height * 4)
            : type === gl.UNSIGNED_BYTE
              ? new Uint8Array(width * height * 4)
              : new Uint32Array(width * height * (type === gl.UNSIGNED_INT_2_10_10_10_REV ? 1 : 4));
        gl.readPixels(0, 0, width, height, fmt, type, data);
        const error = gl.getError();
        if (error) {
          r.errors.push({ frame: r.frame, draw: r.draw, att, error, format: m.format });
          continue;
        }
        const bytes = new Uint8Array(data.buffer);
        let raw = '';
        for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
        r.records.push({
          frame: r.frame,
          draw: r.draw,
          pid,
          texture: id(tex),
          level,
          width,
          height,
          format: m.format,
          type,
          fmt,
          att: a,
          raw: btoa(raw),
        });
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.readBuffer(readBuffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      debug(gl);
    } finally {
      busy = false;
    }
  };
  for (const name of [
    'texStorage2D',
    'texStorage2DMultisample',
    'drawArrays',
    'drawElementsInstanced',
    'drawArraysInstanced',
    'blitFramebuffer',
  ]) {
    original[name] = glp[name];
    if (!original[name]) continue;
    glp[name] = function (...args) {
      const out = original[name].apply(this, args);
      if (name === 'texStorage2D')
        meta.set(this.getParameter(this.TEXTURE_BINDING_2D), { format: args[2], width: args[3], height: args[4] });
      else if (name === 'texStorage2DMultisample')
        meta.set(this.getParameter(this.TEXTURE_BINDING_2D_MULTISAMPLE), {
          samples: args[1],
          format: args[2],
          width: args[3],
          height: args[4],
        });
      else if (!busy) {
        r.draw++;
        capture(this);
      }
      return out;
    };
  }
}
globalThis.probeHarness = async (owner, port, open, run) =>
  harness(owner, port, open, async (page, shot) => {
    await page.evaluate(install);
    try {
      await run(page, shot);
    } finally {
      const result = await page.evaluate(() => targetProbe);
      writeFileSync(`test-results/review5-targets-${backend}.json`, JSON.stringify(result));
      console.log('TARGETS', backend, result.records.length, result.errors);
    }
  });
let source = readFileSync('packages/post/test/ssgi-bounce-browser.mjs', 'utf8')
  .replace("'../../../scripts/lib/browser.mjs'", JSON.stringify(pathToFileURL(resolve('scripts/lib/browser.mjs')).href))
  .replace("import { postBrowser } from './post-browser.mjs';", 'const postBrowser=globalThis.probeHarness;')
  .replace('launchBrowser({ headless: true })', `launchBrowser({headless:true,args:['--use-angle=${backend}']})`)
  .replace(
    'for (let i = 0; i < n; i++) engine.render({ delta: 1 / 60 });',
    'for (let i = 0; i < n; i++) { targetProbe.frame++; targetProbe.draw=0; engine.render({ delta: 1 / 60 }); }',
  )
  .replace(
    'await page.evaluate(() => window.t.engine.dispose());',
    'await frames(1); await frames(1); await page.evaluate(() => window.t.engine.dispose());',
  );
try {
  await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
