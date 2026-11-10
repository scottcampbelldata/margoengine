import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { compare } from '../../../scripts/support/visual-image.js';
import { openBrowser } from '../../../scripts/browser.js';
const reports = [];
await mkdir('test-results/sciviz-media', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-wind.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    await browser.page.waitForFunction(() => document.querySelector('#viewport').dataset.ready === 'true');
    const report = await browser.page.evaluate(async () => {
      const { figure, timeline } = await import('/examples/sciviz-wind.ts');
      const { exportImage, exportImageSequence, exportVideo, renderMediaTiles } = await import(
        '/packages/sciviz/dist/export-media.js'
      );
      const { readZipDirectory, readZipEntry } = await import('/packages/loaders/dist/index.js');
      const check = (value, message) => {
        if (!value) throw Error(message);
      };
      const image = async (blob) => {
        const bitmap = await createImageBitmap(blob),
          surface = new OffscreenCanvas(bitmap.width, bitmap.height),
          g = surface.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          width: surface.width,
          height: surface.height,
          pixels: g.getImageData(0, 0, surface.width, surface.height).data,
        };
      };
      figure.engine.stop();
      const options = {
        size: { width: 320, height: 240, unit: 'px' },
        overlays: false,
        provenance: { source: 'NOAA PSL', hash: 'retained-wind.bin' },
      };
      const tiledBlob = await exportImage(figure, { ...options, tileSize: 64 }),
        fullBlob = await exportImage(figure, { ...options, tileSize: 512 });
      const tiled = await image(tiledBlob),
        full = await image(fullBlob);
      let largest = 0,
        changed = 0,
        lit = 0;
      for (let i = 0; i < tiled.pixels.length; i++) {
        const delta = Math.abs(tiled.pixels[i] - full.pixels[i]);
        largest = Math.max(largest, delta);
        changed += +(delta > 2);
      }
      for (let i = 0; i < tiled.pixels.length; i += 4)
        lit += +(tiled.pixels[i] > 40 || tiled.pixels[i + 1] > 40 || tiled.pixels[i + 2] > 40);
      check(largest === 0, `Tile seams differ: max ${largest}, changed ${changed}`);
      check(lit > 100, 'Real NOAA wind geometry rendered');
      const alpha = await image(await exportImage(figure, { ...options, transparent: true, tileSize: 64 }));
      check(alpha.pixels[3] === 0, 'Transparent margin');
      check(full.pixels[3] === 255, 'Opaque margin');
      const print = await image(
        await exportImage(figure, { size: { width: 25.4, height: 50.8, unit: 'mm' }, dpi: 100, tileSize: 64 }),
      );
      check(print.width === 100 && print.height === 200, 'Physical size at DPI');
      const webpBlob = await exportImage(figure, { ...options, format: 'webp', transparent: true, tileSize: 64 });
      const webp = await image(webpBlob);
      check(webp.width === 320 && webp.height === 240 && webp.pixels[3] === 0, 'WebP alpha and dimensions');
      const webpBytes = new TextDecoder().decode(await webpBlob.arrayBuffer());
      check(webpBytes.includes('NOAA PSL') && webpBytes.includes('EXIF'), 'WebP XMP and physical resolution');
      const highWidth = figure.engine.gpu.limits.maxTextureDimension2D + 17;
      let tileCount = 0,
        maxEdge = 0;
      for await (const tile of renderMediaTiles(figure, {
        size: { width: highWidth, height: 8, unit: 'px' },
        tileSize: 512,
        overlays: false,
      })) {
        tileCount++;
        maxEdge = Math.max(maxEdge, tile.width, tile.height);
      }
      check(tileCount === Math.ceil(highWidth / 512) && maxEdge <= 512, 'Actual target tiling past device limit');
      await timeline.seek(3);
      const zip = new Uint8Array(
        await (
          await exportImageSequence(figure, timeline, { ...options, start: 0, end: 1, fps: 2, tileSize: 128 })
        ).arrayBuffer(),
      );
      const directory = readZipDirectory(zip),
        manifest = JSON.parse(new TextDecoder().decode(await readZipEntry(zip, directory.at(-1))));
      check(
        directory.length === 3 && manifest.frames[1].time === timeline.times[1] && timeline.index === 3,
        'ZIP timestamps and timeline restoration',
      );
      const videos = [];
      for (const format of ['webm', 'mp4']) {
        const blob = await exportVideo(figure, timeline, {
          ...options,
          start: 0,
          end: 2,
          fps: 2,
          tileSize: 128,
          format,
        });
        check(timeline.index === 3, 'Video restored timeline');
        const video = document.createElement('video'),
          url = URL.createObjectURL(blob);
        video.muted = true;
        try {
          await new Promise((resolve, reject) => {
            video.onloadeddata = resolve;
            video.onerror = () => reject(Error(`Cannot play ${format}: ${video.error?.message}`));
            video.src = url;
          });
          check(
            video.videoWidth === 320 && video.videoHeight === 240 && Math.abs(video.duration - 1.5) < 0.001,
            `${format} dimensions and deterministic duration`,
          );
          video.currentTime = 1;
          await new Promise((resolve, reject) => {
            video.onseeked = resolve;
            video.onerror = reject;
          });
          const output = new OffscreenCanvas(320, 240),
            g = output.getContext('2d');
          g.drawImage(video, 0, 0);
          check(g.getImageData(160, 120, 1, 1).data[3] === 255, `${format} decodes a seeked frame`);
          check(new TextDecoder().decode(await blob.arrayBuffer()).includes('NOAA PSL'), `${format} provenance`);
          videos.push({ format, bytes: blob.size, duration: video.duration });
        } finally {
          video.removeAttribute('src');
          video.load();
          URL.revokeObjectURL(url);
        }
      }
      const abort = new AbortController();
      abort.abort(new Error('cancel-test'));
      try {
        await exportImage(figure, { signal: abort.signal });
        throw Error('Missing abort');
      } catch (error) {
        check(error.message === 'cancel-test', 'Abort preserved');
      }
      figure.render();
      return {
        images: { width: 320, height: 240, tiled: Array.from(tiled.pixels), full: Array.from(full.pixels) },
        largest,
        changed,
        lit,
        highWidth,
        tileCount,
        maxEdge,
        videos,
        pngBytes: tiledBlob.size,
        webpBytes: webpBlob.size,
        zipBytes: zip.length,
      };
    });
    await browser.page.screenshot({path: `test-results/sciviz-media/wind-${compat ? 'webgl2' : 'webgpu'}.png`});
    await browser.page.evaluate(async () => (await import('/examples/sciviz-wind.ts')).figure.dispose());
    const { images, ...result } = report;
    const comparison = compare(
      { width: images.width, height: images.height, data: images.full },
      { width: images.width, height: images.height, data: images.tiled },
    );
    assert.ok(
      comparison.changed <= 0.0005 && comparison.hot <= 0.0002,
      JSON.stringify({ changed: comparison.changed, hot: comparison.hot, mean: comparison.mean, max: comparison.max }),
    );
    assert.deepEqual(errors, []);
    reports.push({
      compat,
      ...result,
      comparison: { changed: comparison.changed, hot: comparison.hot, mean: comparison.mean, max: comparison.max },
    });
  } finally {
    await browser.close();
  }
}
await writeFile('test-results/sciviz-media/report.json', JSON.stringify(reports, null, 2));
console.log(JSON.stringify(reports, null, 2));
