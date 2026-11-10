import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
await mkdir('test-results/sciviz-colors', { recursive: true });
const reports = [];
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-colors.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#ocean').dataset.ready === 'true');
    const report = await browser.page.evaluate(async () => {
      const { ocean, stars } = await import('/examples/sciviz-colors.ts');
      const { colormap, colormapNames, colorScale, tolColormap } = await import('/packages/sciviz/dist/colormaps.js');
      const { colormapTexture } = await import('/packages/sciviz/src/layer.ts');
      const { colorLookupWGSL } = await import('/packages/sciviz/src/color-lookup.ts');
      const { svgToPDF } = await import('/packages/sciviz/dist/pdf.js');
      const { parseTTF } = await import('/packages/loaders/dist/font.js');
      const check = (v, m) => {
        if (!v) throw new Error(m);
      };
      ocean.engine.stop();
      stars.engine.stop();
      const device = ocean.engine.gpu;
      const values = new Float32Array([
        -Infinity,
        -0.1,
        0,
        0.0001,
        0.01,
        0.1,
        0.2,
        0.33333,
        0.5,
        0.6,
        0.9,
        0.9999,
        1,
        1.1,
        Infinity,
        NaN,
      ]);
      const input = device.createBuffer({
        size: values.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(input, 0, values);
      const shader = device.createShaderModule({
        code: `${colorLookupWGSL}
        @group(0) @binding(0) var colours:texture_2d<f32>;
        @group(0) @binding(1) var<storage,read> values:array<f32>;
        @vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
          let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));return vec4f(p[i],0.5,1.0);}
        @fragment fn fs(@builtin(position)p:vec4f)->@location(0)vec4f{
          let c=clamp(colourLookup(colours,values[u32(p.x)]).rgb,vec3f(0.0),vec3f(1.0));
          return vec4f(select(1.055*pow(c,vec3f(1.0/2.4))-0.055,12.92*c,c<=vec3f(0.0031308)),1.0);}
      `,
      });
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        ],
      });
      const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module: shader, entryPoint: 'vs' },
        fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      });
      const cases = [
        ...colormapNames.map((n) => colorScale(n, { domain: [0, 1], nan: '#f0f', under: '#f00', over: '#0f0' })),
        colorScale('gray', { domain: [1, 1000], scale: 'log', nan: '#f0f', under: '#f00', over: '#0f0' }),
        colorScale('gray', { domain: [-100, 100], scale: 'symlog', constant: 2 }),
        colorScale('aurora', {
          domain: [0, 1],
          boundaries: [0, 0.1, 0.2, 0.5, 1],
          colors: ['#f00', '#0f0', '#00f', '#fff'],
        }),
        tolColormap('bright'),
      ];
      let maxError = 0;
      try {
        for (const map of cases) {
          const texture = colormapTexture(device, map),
            target = device.createTexture({
              size: [16, 1],
              format: 'rgba8unorm',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            });
          const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          try {
            const group = device.createBindGroup({
              layout,
              entries: [
                { binding: 0, resource: texture.createView() },
                { binding: 1, resource: { buffer: input } },
              ],
            });
            const encoder = device.createCommandEncoder(),
              pass = encoder.beginRenderPass({
                colorAttachments: [
                  {
                    view: target.createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 0 },
                  },
                ],
              });
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, group);
            pass.draw(3);
            pass.end();
            encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [16, 1]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(GPUMapMode.READ);
            const pixels = new Uint8Array(buffer.getMappedRange());
            for (let i = 0; i < values.length; i++)
              for (let c = 0; c < 3; c++) {
                const expected = map.sample(values[i])[c],
                  error = Math.abs(pixels[i * 4 + c] / 255 - expected);
                maxError = Math.max(maxError, error);
                check(error < 0.012, `${map.name} ${i}/${c}: GPU ${pixels[i * 4 + c] / 255}, CPU ${expected}`);
              }
            buffer.unmap();
          } finally {
            texture.destroy();
            target.destroy();
            buffer.destroy();
          }
        }
      } finally {
        input.destroy();
      }
      const { Figure } = await import('/packages/sciviz/dist/index.js');
      const sliceColors = [];
      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      canvas.style.cssText = 'width:96px;height:96px';
      document.body.append(canvas);
      const fig = await Figure.create(canvas, { axes: false, controls: false, aspect: [1, 1, 1] });
      fig.engine.stop();
      fig.engine.camera.position = [0, 0, 4];
      fig.engine.camera.target = [0, 0, 0];
      for (const [value, mapped] of [
        [0.5, false],
        [-1, true],
        [NaN, true],
        [0.5, true],
        [2, true],
      ]) {
        const map = mapped
          ? colorScale('gray', { domain: [0, 1], under: '#f00', nan: '#f0f', over: '#0f0' })
          : colormap('gray');
        const volume = fig.volume(new Float32Array(64).fill(value), {
          dims: [4, 4, 4],
          range: [0, 1],
          colormap: map,
          shading: false,
        });
        volume.visible = false;
        const slice = volume.slice('y', 0.5);
        await fig.ready();
        const bitmap = await createImageBitmap(await fig.toPNG({ overlays: false })),
          surface = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = surface.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        const p = Array.from(g.getImageData(Math.floor(surface.width / 2), Math.floor(surface.height / 2), 1, 1).data),
          expected = map.sample(value);
        check(
          expected.every((v, i) => Math.abs(p[i] / 255 - v) < 0.012),
          `Volume slice ${value}: ${p} versus ${expected}`,
        );
        if (mapped) sliceColors.push(p);
        if (mapped && value < 0) {
          volume.visible = true;
          volume.mode = 'mip';
          slice.visible = false;
          const mip = await createImageBitmap(await fig.toPNG({ overlays: false }));
          g.clearRect(0, 0, surface.width, surface.height);
          g.drawImage(mip, 0, 0);
          mip.close();
          const pixel = g.getImageData(Math.floor(surface.width / 2), Math.floor(surface.height / 2), 1, 1).data;
          check(
            pixel[0] === 255 && pixel[1] === 0 && pixel[2] === 0,
            'MIP retains an all-negative scalar maximum before under-colour lookup',
          );
        }
        fig.remove(volume);
      }
      fig.dispose();
      canvas.remove();
      const fonts = await fetch('/examples/assets/sciviz/publication/DejaVuSerif.ttf').then((r) => r.arrayBuffer()),
        font = parseTTF(fonts);
      const select = document.querySelector('#scale');
      select.value = 'bins';
      select.dispatchEvent(new Event('change'));
      await (await import('/examples/sciviz-colors.ts')).settled;
      const svg = await ocean.toSVG();
      check(svg.includes('offset="0.05405405405405406"') || svg.includes('sciviz-bar'), 'Binned scale exported');
      const starsSVG = await stars.toSVG();
      check(starsSVG.includes('Source size and shape'), 'Encoding legend text exported');
      const pdf = await svgToPDF(svg, { font });
      check(pdf.size > 1000, 'Binned PDF rendered');
      const png = await ocean.toPNG(),
        starPNG = await stars.toPNG();
      check(png.size > 1000 && starPNG.size > 1000, 'Both real datasets render');
      const blob = async (b) => Array.from(new Uint8Array(await b.arrayBuffer()));
      const result = {
        cases: cases.length,
        scalars: values.length,
        maxError,
        sliceColors,
        cells: ocean.layers[0].values.length,
        stars: stars.layers[0].cloud.count,
        png: await blob(png),
        starPNG: await blob(starPNG),
        pdf: await blob(pdf),
        svg,
        starsSVG,
      };
      const roots = stars.exportLayout().roots.filter((e) => e.textContent.includes('Source size and shape'));
      check(roots.length === 1, 'Encoding legend registered in publication layout');
      stars.dispose();
      check(!roots[0].isConnected, 'Figure owns legend cleanup');
      ocean.dispose();
      return result;
    });
    assert.deepEqual(errors, []);
    assert.equal(report.cells, 228);
    assert.equal(report.stars, 20000);
    const backend = compat ? 'webgl2' : 'webgpu';
    for (const [name, data] of [
      ['oisst.png', report.png],
      ['stars.png', report.starPNG],
      ['oisst.pdf', report.pdf],
    ])
      await writeFile(`test-results/sciviz-colors/${backend}-${name}`, Buffer.from(data));
    await writeFile(`test-results/sciviz-colors/${backend}-oisst.svg`, report.svg);
    await writeFile(`test-results/sciviz-colors/${backend}-stars.svg`, report.starsSVG);
    const { png, starPNG, pdf, svg, starsSVG, ...summary } = report;
    reports.push({ backend, ...summary });
    console.log(JSON.stringify(reports.at(-1)));
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-colors/results.json', JSON.stringify(reports, null, 2));
