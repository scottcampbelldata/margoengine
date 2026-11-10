import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

await mkdir('test-results/sciviz-publication', { recursive: true });
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-publication.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(120000);
  try {
    const result = await browser.page.evaluate(async () => {
      const { figure, font, pdf, title } = await import('/examples/sciviz-publication.ts');
      const { svgToPDF } = await import('/packages/sciviz/dist/pdf.js');
      const { renderMath, addMathLabel } = await import('/packages/sciviz/dist/math.js');
      const check = (v, message) => {
        if (!v) throw new Error(message);
      };
      check(document.querySelector('#status').textContent.includes('observed samples'), 'LIGO loaded');
      const svg = await figure.toSVG(),
        p = await pdf();
      check(svg.includes('sciviz-plot') && !svg.includes('<image'), 'LIGO trace stays vector');
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
      check(doc.querySelector('polyline') && [...doc.querySelectorAll('path')].some(p=>p.getAttribute('d')===JSON.parse(title.element.dataset.scivizMath).path), 'trace and exact formula outline');
      check(title.element.querySelector('mfrac'), 'native MathML fraction');
      const png = await figure.toPNG();
      check(png.size > 1000, 'PNG math overlay');
      const temporary = addMathLabel(figure, 'x_i^2', { font, x: 150, y: 50 });
      temporary[Symbol.dispose]();
      check(!temporary.element.isConnected, 'early removal');
      const canvas = new OffscreenCanvas(2, 2),
        g = canvas.getContext('2d');
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 1, 1);
      g.fillStyle = '#00ff00';
      g.fillRect(1, 0, 1, 1);
      g.fillStyle = '#0000ff';
      g.fillRect(0, 1, 1, 1);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(1, 1, 1, 1);
      const image = await canvas.convertToBlob({ type: 'image/png' }),
        b64 = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.readAsDataURL(image);
        });
      const fixture = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#ffffff"/><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="0.5" stop-color="#00ff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient><rect width="200" height="50" fill="url(#g)"/><clipPath id="c"><rect x="10" y="60" width="40" height="40"/></clipPath><g clip-path="url(#c)"><circle cx="50" cy="80" r="50" fill="rgba(255,0,0,0.5)"/></g><image x="100" y="60" width="80" height="80" href="${b64}"/><svg x="10" y="140" width="100" height="50" viewBox="0 0 100 50"><path d="M0 0 Q50 100 100 0Z" fill="#000"/></svg></svg>`;
      const mixed = await svgToPDF(fixture, { font });
      const matrix = renderMath(String.raw`\frac{\sqrt[3]{x_i^2}}{\alpha+\beta}+\begin{pmatrix}1&2\\3&4\end{pmatrix}`, {
        font,
        size: 32,
        color: '#000',
      });
      const matrixPDF = await svgToPDF(matrix.svg, { font });
      const array = async (blob) => Array.from(new Uint8Array(await blob.arrayBuffer()));
      const output = {
        svg,
        pdf: await array(p),
        png: await array(png),
        fixture,
        mixed: await array(mixed),
        matrix: matrix.svg,
        matrixPDF: await array(matrixPDF),
        samples: figure.layers[0].positions.length / 3,
      };
      figure.dispose();
      check(!title.element.isConnected, 'figure disposes publication labels');
      return output;
    });
    assert.deepEqual(errors, []);
    assert.equal(result.samples, 3441);
    for (const [name, data] of Object.entries({ ligo: result.pdf, mixed: result.mixed, matrix: result.matrixPDF }))
      await writeFile(`test-results/sciviz-publication/${name}-${compat ? 'webgl2' : 'webgpu'}.pdf`, Buffer.from(data));
    await writeFile(`test-results/sciviz-publication/ligo-${compat ? 'webgl2' : 'webgpu'}.svg`, result.svg);
    await writeFile(
      `test-results/sciviz-publication/ligo-${compat ? 'webgl2' : 'webgpu'}.png`,
      Buffer.from(result.png),
    );
    await writeFile('test-results/sciviz-publication/mixed.svg', result.fixture);
    await writeFile('test-results/sciviz-publication/matrix.svg', result.matrix);
    console.log(
      JSON.stringify({ compat, samples: result.samples, pdfBytes: result.pdf.length, mixedBytes: result.mixed.length }),
    );
  } finally {
    await browser.close();
  }
}
