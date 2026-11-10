import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
await mkdir('test-results/series', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-series.html', port: 'free', compat }), errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#status').dataset.ready === 'true' || document.querySelector('#status').dataset.error === 'true');
    assert.equal(await browser.page.locator('#status').getAttribute('data-error'), null, await browser.page.locator('#status').textContent());
    const proof = await browser.page.evaluate(async () => {
      const d = await import('/examples/sciviz-series.ts'), api = await import('/packages/sciviz/dist/series.js');
      const check = (value, why) => { if (!value) throw Error(why); };
      const before = { rows: d.binding.data.length, displayed: d.binding.indices.length, batches: d.progress.length };
      check(before.rows === 16384 && before.displayed < before.rows && before.batches > 1, 'progressively draw a reduced real-data line');
      check(d.progress[0].rows < before.rows, 'first draw precedes the final data batch');
      const area = d.figure.plotArea;
      d.figure.select({ rect: [area.x, area.y, area.x+area.width, area.y+area.height] });
      check(d.binding.selected.length === 16384, 'Figure box selection queries all original samples');
      d.figure.setLimits([-0.05, 0.05, -8e-19, 8e-19]); await d.binding.refresh();
      const zoom = d.binding.indices.length;
      const expected = d.binding.data.select((x, y) => x>=-0.05 && x<=0.05 && y>=-8e-19 && y<=8e-19);
      d.figure.select({ rect: [area.x, area.y, area.x+area.width, area.y+area.height] });
      check([...d.binding.selected].join(',') === [...expected].join(','), 'zoom selection stays exact');
      check(zoom < before.displayed, 'zoom redraws the original interval');
      let formatRows = {};
      for (const format of ['arrow','parquet']) {
        const source = await api.openSeriesSource(`/packages/sciviz/tests/fixtures/series/gw150914.${format}`);
        const chunks = []; for await (const part of api.readSeries(source, { format, chunkBytes: 1024 })) chunks.push(part);
        formatRows[format] = chunks.reduce((n,p)=>n+p.table.length,0);
        check(formatRows[format] === before.rows && chunks.length > 1, `${format} progressive groups`);
      }
      const amplitude = 1e-21, tone = Float64Array.from({ length: 64 }, (_, i) => amplitude*Math.cos(2*Math.PI*7*i/64));
      const spectrum = await api.seriesSpectrum(d.gpu, tone, 64, { window: 'rectangular', detrend: false });
      check(Math.abs(spectrum.real[7]/(32*amplitude)-1) < 2e-5, 'GPU FFT keeps tiny physical units');
      check(Math.abs(spectrum.power[7]/(amplitude*amplitude/2)-1) < 3e-5, 'GPU PSD normalization');
      const stft = await api.seriesSpectrogram(d.gpu, tone, 64, { windowSize: 32, hopSize: 16 });
      check(stft.times.length === 3 && stft.power.length === 51, 'GPU STFT dimensions');
      const ink = [];
      for (const figure of [d.figure, d.spectrumFigure, d.spectrogramFigure]) {
        figure.render(); const canvas = figure.engine.canvas, out = new OffscreenCanvas(canvas.width,canvas.height), ctx = out.getContext('2d');
        ctx.drawImage(canvas,0,0); const pixels = ctx.getImageData(0,0,out.width,out.height).data;
        let count=0; for(let i=0;i<pixels.length;i+=4) if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>30) count++;
        ink.push(count); check(count>100,'line, FFT and spectrogram render coloured pixels');
      }
      const controller = new AbortController(), temp = await api.bindSeries(d.figure,new api.TimeSeries(),{signal:controller.signal});
      const source = await api.openSeriesSource('/packages/sciviz/tests/fixtures/series/gw150914.csv');
      let chunks=0; temp.addEventListener('progress',()=>{chunks++;controller.abort();});
      let aborted=false; try { await temp.load(source,{x:'time',y:'strain',chunkBytes:4096}); } catch(cause) {aborted=cause.name==='AbortError';}
      check(aborted && chunks===1 && temp.layers.length===0,'abort cancels progressive drawing and removes its traces');
      return { ...before, zoom, selected:expected.length, formatRows, ink, fftPeak:spectrum.power[7], routes:d.gpu.device.dispatches ? {...d.gpu.device.dispatches} : undefined };
    });
    await browser.page.screenshot({ path: `test-results/series/${compat?'webgl2':'webgpu'}.png`, fullPage: true });
    await browser.page.setViewportSize({ width:390,height:800 });
    await browser.page.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth, undefined, { timeout: 5000 });
    await browser.page.evaluate(async()=>{const d=await import('/examples/sciviz-series.ts');d.binding.dispose();d.gpu.dispose();d.figure.dispose();d.spectrumFigure.dispose();d.spectrogramFigure.dispose();});
    assert.deepEqual(errors,[]);
    await writeFile(`test-results/series/${compat?'webgl2':'webgpu'}.json`,JSON.stringify(proof,null,2)+'\n');
    console.log(`series ${compat?'WebGL2':'WebGPU'} ${JSON.stringify(proof)}`);
  } finally { await browser.close(); }
}
