import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

// All generated files stay in this worktree. Synthetic geometry is a correctness fixture, not measured botanical data.
const dir = fileURLToPath(new URL('../../../test-results/batch230-tree-browser/', import.meta.url));
await mkdir(dir, { recursive: true });
await writeFile(dir + '/index.html', '<script type="module" src="/main.js"></script>');
await writeFile(
  dir + '/main.js',
  `import {generateParametricTree,meshTreeLODs} from '${fileURLToPath(new URL('../dist/tree-mesh.js', import.meta.url)).replaceAll('\\', '/')}'; window.make=generateParametricTree;window.lods=meshTreeLODs;`,
);
let browser, server;
try {
  await build({ root: dir, configFile: false, logLevel: 'error', build: { outDir: dir + '/dist' } });
  server = await preview({
    root: dir,
    configFile: false,
    logLevel: 'error',
    build: { outDir: dir + '/dist' },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.make);
  const result = await page.evaluate(async () => {
    const tree = window.make({ seed: 7 }),
      lods = window.lods(tree.skeleton),
      bark = tree.bark;
    let max = 0;
    for (const x of bark.positions) max = Math.max(max, Math.abs(x));
    const positions = Float32Array.from(bark.positions, (x, i) =>
      i % 3 === 0 ? x / max : i % 3 === 1 ? (x / max) * 1.8 - 0.9 : 0,
    );
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    device.pushErrorScope('validation');
    const vb = device.createBuffer({ size: positions.byteLength, usage: 32 | 8 }),
      ib = device.createBuffer({ size: bark.indices.byteLength, usage: 16 | 8 });
    device.queue.writeBuffer(vb, 0, positions);
    device.queue.writeBuffer(ib, 0, bark.indices);
    const module = device.createShaderModule({
      code: '@vertex fn vs(@location(0) p: vec3f)->@builtin(position) vec4f{return vec4f(p,1);}@fragment fn fs()->@location(0) vec4f{return vec4f(0.5,0.25,0.1,1);}',
    });
    const pipeline = await device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });
    const texture = device.createTexture({ size: [64, 64], format: 'rgba8unorm', usage: 16 | 1 }),
      read = device.createBuffer({ size: 64 * 256, usage: 1 | 8 }),
      encoder = device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [{ view: texture.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, vb);
    pass.setIndexBuffer(ib, 'uint32');
    pass.drawIndexed(bark.indices.length);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: read, bytesPerRow: 256 }, [64, 64]);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(1);
    const gpu = [...new Uint8Array(read.getMappedRange())];
    read.unmap();
    const error = await device.popErrorScope();
    if (error) throw new Error(error.message);
    for (const r of [vb, ib, texture, read]) r.destroy();
    device.destroy();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const gl = canvas.getContext('webgl2');
    const shader = (kind, source) => {
      const s = gl.createShader(kind);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const vs = shader(
        gl.VERTEX_SHADER,
        '#version 300 es\nlayout(location=0) in vec3 p;void main(){gl_Position=vec4(p,1.0);}',
      ),
      fs = shader(
        gl.FRAGMENT_SHADER,
        '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(0.5,0.25,0.1,1.0);}',
      ),
      program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const vertex = gl.createBuffer(),
      index = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertex);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, bark.indices, gl.STATIC_DRAW);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, bark.indices.length, gl.UNSIGNED_INT, 0);
    const pixels = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError()) throw new Error('GL render failed');
    for (const b of [vertex, index]) gl.deleteBuffer(b);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.getExtension('WEBGL_lose_context').loseContext();
    return {
      gpu: gpu.filter((x, i) => i % 4 === 0 && x > 0).length,
      gl: pixels.filter((x, i) => i % 4 === 0 && x > 0).length,
      triangles: lods.map((l) => (l.mesh.bark.indices.length + l.mesh.leaves.indices.length) / 3),
    };
  });
  assert.ok(result.gpu > 20);
  assert.ok(result.gl > 20);
  assert.ok(result.triangles[0] > result.triangles[1] && result.triangles[1] > result.triangles[2]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(result));
} finally {
  await closeAll({ browser, servers: [server] });
}
