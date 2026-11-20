// node stress-fixture.mjs truth.json out.json.gz: keeps what the stress stage guard compares from a `truth.py ... prims`
// reading of the `generate-stages.py` stages (each prim's type and properties, keyed by the stage's number) and writes it
// gzipped. A stage OpenUSD could not open is kept as its error text, with no prims.
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const [input, output] = process.argv.slice(2);
const truth = JSON.parse(readFileSync(input, 'utf8'));
const out = {};
for (const [file, record] of Object.entries(truth)) {
  const index = file.replace(/\\/g, '/').split('/').at(-2);
  if (record.error) out[index] = { error: /' -- ([^']*)'/.exec(record.error)?.[1] ?? 'OpenUSD could not open it' };
  else
    out[index] = {
      prims: Object.fromEntries(Object.entries(record.prims).map(([p, v]) => [p, { type: v.type, props: v.props }])),
    };
}
writeFileSync(output, gzipSync(JSON.stringify(out), { level: 9 }));
