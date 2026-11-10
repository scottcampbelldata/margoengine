import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { parseTTF } from '@margoengine/loaders/font';
import { svgToPDF, exportPDF } from '@margoengine/sciviz/pdf';
import { renderMath } from '@margoengine/sciviz/math';
const env = new JSDOM();
globalThis.DOMParser = env.window.DOMParser;
globalThis.XMLSerializer = env.window.XMLSerializer;
const font = parseTTF(
  readFileSync(new URL('../../../examples/assets/sciviz/publication/DejaVuSerif.ttf', import.meta.url)),
);
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${body}</svg>`;
const decode = async (blob) => {
  const buffer = Buffer.from(await blob.arrayBuffer()),
    text = buffer.toString('latin1');
  const start = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const lines = text.slice(start).split('\n'),
    count = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < count; i++) {
    const offset = Number(lines[i + 2].slice(0, 10));
    assert.equal(text.slice(offset, offset + `${i} 0 obj`.length), `${i} 0 obj`);
  }
  const streams = [];
  for (const m of text.matchAll(/<<[^]*?\/Length (\d+)[^]*?>>\nstream\n/g)) {
    const pos = m.index + m[0].length;
    streams.push(inflateSync(buffer.subarray(pos, pos + Number(m[1]))).toString());
  }
  return { text, streams };
};
test('PDF 1.7 byte xref, page tree, flate content and Unicode metadata are valid', async () => {
  const { text, streams } = await decode(
    await svgToPDF(svg('<rect x="10" y="20" width="30" height="40" fill="#ff0000"/>'), {
      font,
      widthMM: 50.8,
      title: 'Δ LIGO',
      author: 'LIGO',
      provenance: { source: 'real' },
    }),
  );
  assert.ok(text.startsWith('%PDF-1.7'));
  assert.match(text, /\/MediaBox \[0 0 144 72\]/);
  assert.match(text, /\/Type \/Pages \/Kids/);
  assert.match(text, /\/Title <FEFF0394/);
  assert.match(text, /MargoProvenance/);
  assert.ok(streams.some((s) => s.includes('1 0 0 rg') && s.includes('10 20 m') && s.includes('40 60 l')));
});
test('clipping, axial multi-stop shading, fill alpha, transforms and text outlines are retained', async () => {
  const { text, streams } = await decode(
    await svgToPDF(
      svg(
        '<clipPath id="c"><rect width="50" height="50"/></clipPath><linearGradient id="g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#0000ff"/><stop offset=".5" stop-color="#00ff00"/><stop offset="1" stop-color="#ff0000"/></linearGradient><g clip-path="url(#c)" transform="translate(10 20)"><rect width="100" height="50" fill="url(#g)" stroke="#fff"/><circle cx="20" cy="20" r="5" fill="rgba(255,0,0,0.5)"/><text x="25" y="30" font-size="12" text-anchor="middle">Δx</text></g>',
      ),
      { font },
    ),
  );
  const content = streams.join('\n');
  assert.match(content, /W n/);
  assert.match(content, /1 0 0 1 10 20 cm/);
  assert.match(content, /\/S0 sh/);
  assert.match(text, /\/ShadingType 2/);
  assert.match(text, /\/FunctionType 3/);
  assert.match(text, /\/ca 0.5/);
  assert.doesNotMatch(content, /BT|Tj/);
});
test('font quadratic outlines become equivalent cubic curves and math remains vector paths', async () => {
  const { text, streams } = await decode(
    await svgToPDF(renderMath(String.raw`\frac{\Delta L}{L}`, { font, color: '#000' }).svg, { font }),
  );
  assert.ok(streams.some((s) => s.includes(' c') && s.includes('f')));
  assert.doesNotMatch(text, /\/Subtype \/Image/);
});
test('figure adapter, abort identity and explicit rejection of unsupported SVG', async () => {
  const output = await exportPDF({ toSVG: async () => svg('<path d="M0 0Q30 60 60 0Z" fill="#000"/>') }, { font });
  assert.equal(output.type, 'application/pdf');
  const { streams } = await decode(output);
  assert.match(streams.join(''), /20 40 40 40 60 0 c/);
  const ac = new AbortController(),
    reason = new Error('abort');
  ac.abort(reason);
  await assert.rejects(svgToPDF(svg(''), { font, signal: ac.signal }), (e) => e === reason);
  await assert.rejects(svgToPDF(svg('<foreignObject/>'), { font }), /Unsupported SVG/);
  await assert.rejects(svgToPDF('<not-svg/>', { font }), /well-formed/);
  await assert.rejects(svgToPDF(svg(''), { font, widthMM: 0 }), RangeError);
});
