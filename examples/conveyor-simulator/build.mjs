// Packs the Margo port into one offline HTML next to the three.js original, reusing the original's
// markup, styles and embedded model/environment/facts and replacing only its script bundle.
//   node examples/conveyor-simulator/build.mjs "<path to conveyor simulator.html>" [output.html]
// Run `npm run build:packages` first. The output embeds the CAD model; keep it out of the repository.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const [source, target] = process.argv.slice(2);
if (!source)
  throw new Error('Usage: node examples/conveyor-simulator/build.mjs <three.js simulator html> [output html]');
const output = resolve(target ?? join(dirname(source), 'conveyor simulator (margo).html'));

const [
  {
    output: [chunk],
  },
] = [
  await build({
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      write: false,
      target: 'es2022',
      lib: {
        entry: fileURLToPath(new URL('./src/main.js', import.meta.url)),
        formats: ['iife'],
        name: 'conveyorSimulator',
      },
    },
  }),
].flat(); // A library build returns one result per format.

const html = await readFile(source, 'latin1'); // Byte-preserving: the data blocks are ASCII, the rest is copied as is.
const start = html.lastIndexOf('<script>'),
  end = html.lastIndexOf('</script>');
if (start < 0 || end < start || !html.includes('id="model-data"'))
  throw new Error('Unexpected simulator HTML: no embedded model or script bundle');
const script = Buffer.from(chunk.code.replaceAll('</script', '<\\/script'), 'utf8').toString('latin1');
await writeFile(output, html.slice(0, start) + '<script>' + script + html.slice(end), 'latin1');
console.log(
  `${output}\n  script ${(chunk.code.length / 1024).toFixed(1)} KiB (three.js bundle was ${((end - start) / 1024).toFixed(1)} KiB)`,
);
