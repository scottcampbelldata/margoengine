// AV1 standard data into Chromium as a black box. Software decoding only; no GPU slot is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../../../scripts/support/shutdown.mjs';

const root = fileURLToPath(new URL('../../../../..', import.meta.url));
const directory = resolve(root, 'test-results/batch203-avif/oracle');
await mkdir(directory, { recursive: true });
const fixtures = resolve(root, 'packages/decoders/native/avif/tests/fixtures');
const manifest = JSON.parse(await readFile(resolve(fixtures, 'manifest.json'), 'utf8'));
const probe = resolve(root, `test-results/batch203-avif/pixels-probe${process.platform === 'win32' ? '.exe' : ''}`);
for (let i = 0; i < manifest.length; i++) {
  execFileSync(probe, [resolve(fixtures, manifest[i].file), resolve(directory, `fixture${i}`)], {
    timeout: 45_000,
    windowsHide: true,
    stdio: 'inherit',
  });
}
const server = createServer(async (request, response) => {
  const name = new URL(request.url, 'http://localhost').pathname.slice(1);
  if (!name) {
    response.end('<!doctype html><title>AV1 conformance oracle</title>');
    return;
  }
  if (name !== basename(name) || !/^fixture\d+\.(obu|avif)$/.test(name)) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', 'application/octet-stream');
  if (name.endsWith('.avif')) {
    const index = Number(name.match(/\d+/)[0]);
    response.end(await readFile(resolve(fixtures, manifest[index].file)));
  } else response.end(await readFile(resolve(directory, name)));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
const records = [];
try {
  browser = await launchBrowser({
    headless: true,
    needs: 'none',
    args: ['--disable-gpu', '--disable-accelerated-video-decode'],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const order = manifest
    .map((entry, index) => ({ index, mono: entry.file.includes('monochrome') }))
    .sort((a, b) => Number(a.mono) - Number(b.mono));
  for (const { index: i } of order) {
    const metadata = JSON.parse(await readFile(resolve(directory, `fixture${i}.json`), 'utf8'));
    const result = await page.evaluate(
      async ({ index, metadata }) => {
        let frame;
        let failure;
        let decoder;
        try {
          if (metadata.depth === 12) {
            // Chromium's VideoDecoder chunk classifier rejects these valid 12-bit key
            // frames. Its AVIF ImageDecoder exposes the same raw 12-bit pixel formats.
            const data = await (await fetch(`/fixture${index}.avif`)).arrayBuffer();
            decoder = new ImageDecoder({
              data,
              type: 'image/avif',
              colorSpaceConversion: 'none',
              preferAnimation: false,
            });
            frame = (await decoder.decode({ frameIndex: 0 })).image;
          } else {
            decoder = new VideoDecoder({
              output: (value) => {
                frame?.close();
                frame = value;
              },
              error: (error) => {
                failure = error;
              },
            });
            decoder.configure({ codec: metadata.codec, hardwareAcceleration: 'prefer-software' });
            const data = await (await fetch(`/fixture${index}.obu`)).arrayBuffer();
            decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data }));
            await decoder.flush();
          }
          if (failure) throw failure;
          if (!frame) throw new Error('Chromium produced no decoded frame');
          const expectedFormat =
            metadata.depth === 8 ? /^I(?:420|422|444)$/ : new RegExp(`^I(?:420|422|444)P${metadata.depth}$`);
          if (!expectedFormat.test(frame.format))
            throw new Error(
              `Raw ${metadata.depth}-bit AV1 reference unavailable: Chromium returned ${frame.format}; a full precision reference is required`,
            );
          const rect = { x: 0, y: 0, width: metadata.width, height: metadata.height };
          const bytes = new Uint8Array(frame.allocationSize({ rect }));
          const layout = await frame.copyTo(bytes, { rect });
          const unit = metadata.depth === 8 ? 1 : 2;
          const planes = [];
          for (let p = 0; p < (metadata.monochrome ? 1 : 3); p++) {
            const width = Math.ceil(metadata.width / (p && metadata.subX ? 2 : 1));
            const height = Math.ceil(metadata.height / (p && metadata.subY ? 2 : 1));
            const tight = new Uint8Array(width * height * unit);
            for (let y = 0; y < height; y++)
              tight.set(
                bytes.subarray(
                  layout[p].offset + y * layout[p].stride,
                  layout[p].offset + y * layout[p].stride + width * unit,
                ),
                y * width * unit,
              );
            let text = '';
            for (let at = 0; at < tight.length; at += 32768)
              text += String.fromCharCode(...tight.subarray(at, at + 32768));
            planes.push(btoa(text));
          }
          return { format: frame.format, planes, color: frame.colorSpace.toJSON() };
        } finally {
          frame?.close();
          if (decoder && decoder.state !== 'closed') decoder.close();
        }
      },
      { index: i, metadata },
    );
    const expected = Buffer.concat(result.planes.map((data) => Buffer.from(data, 'base64')));
    await writeFile(resolve(directory, `fixture${i}.chromium.yuv`), expected);
    const actual = await readFile(resolve(directory, `fixture${i}.margo.yuv`));
    assert.equal(actual.length, expected.length, manifest[i].file);
    const unit = metadata.depth === 8 ? 1 : 2;
    let different = 0;
    let maxDifference = 0;
    let first = -1;
    for (let at = 0; at < actual.length; at += unit) {
      const a = unit === 1 ? actual[at] : actual.readUInt16LE(at);
      const b = unit === 1 ? expected[at] : expected.readUInt16LE(at);
      const difference = Math.abs(a - b);
      if (difference) {
        different++;
        if (first < 0) first = at / unit;
        maxDifference = Math.max(maxDifference, difference);
      }
    }
    const record = {
      file: manifest[i].file,
      ...metadata,
      format: result.format,
      color: result.color,
      browser: browser.version(),
      oracle: metadata.depth === 12 ? 'ImageDecoder' : 'VideoDecoder',
      samples: actual.length / unit,
      different,
      maxDifference,
      first,
    };
    records.push(record);
    console.log(JSON.stringify(record));
  }
} finally {
  await closeAll({ browser });
  await new Promise((done) => server.close(done));
  await writeFile(resolve(directory, 'comparison.json'), JSON.stringify(records, null, 2) + '\n');
}
assert.equal(
  records.reduce((n, record) => n + record.different, 0),
  0,
  'AV1 YUV samples must match Chromium exactly',
);
