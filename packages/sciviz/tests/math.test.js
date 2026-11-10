import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseTTF } from '@margoengine/loaders/font';
import { parseMath, mathML, renderMath, mathLabel } from '@margoengine/sciviz/math';
import { JSDOM } from 'jsdom';
const font = parseTTF(
  readFileSync(new URL('../../../examples/assets/sciviz/publication/DejaVuSerif.ttf', import.meta.url)),
);
const dom = (s) => new JSDOM(s, { contentType: 'application/xml' }).window.document;

test('publication fixtures retain the recorded unmodified standard font and LIGO bytes', () => {
  const base = new URL('../../../examples/assets/sciviz/publication/', import.meta.url);
  const source = JSON.parse(readFileSync(new URL('source.json', base), 'utf8'));
  for (const [key, name] of [['font', 'DejaVuSerif.ttf'], ['strain', 'GW150914-H1.txt']])
    assert.equal(createHash('sha256').update(readFileSync(new URL(name, base))).digest('hex'), source[key].sha256);
});

test('TeX grammar retains fraction/root/script precedence, both script orders and matrices', () => {
  const ast = parseMath(String.raw`\frac{\sqrt[3]{x_i^2}}{\alpha+\beta}+\begin{pmatrix}1&2\\3&4\end{pmatrix}`);
  assert.equal(ast.children[0].kind, 'frac');
  assert.equal(ast.children[0].children[0].children[0].kind, 'root');
  const doc = dom(mathML(String.raw`x^2_i+\begin{bmatrix}a&b\\c&d\end{bmatrix}`));
  assert.equal(doc.querySelectorAll('msubsup').length, 1);
  assert.equal(doc.querySelector('msubsup').children[1].textContent, 'i');
  assert.equal(doc.querySelectorAll('mtr').length, 2);
  assert.equal(doc.querySelectorAll('mtd').length, 4);
});
test('every required syntax family generates finite outlines with accessible MathML', () => {
  for (const tex of [
    String.raw`h(t)=\frac{\Delta L(t)}{L}`,
    String.raw`\sqrt{x^2+y_1}+\sqrt[3]{z}`,
    String.raw`\alpha\beta\Gamma\Omega+\sum_{i=0}^{n}i+\int_0^1 x`,
    String.raw`\hat{x}\bar{y}\vec{v}\dot{a}\ddot{b}\tilde{z}\underline{u}`,
    String.raw`\begin{matrix}1&2&3\\4&5&6\end{matrix}`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
    String.raw`\left(\frac{x}{y}\right)`,
    String.raw`\sin(x)\,\mathrm{Hz}`,
  ]) {
    const r = renderMath(tex, { font, size: 24 });
    assert.ok(r.width > 0 && r.height > 0);
    assert.ok(r.path.length > 20);
    assert.ok(!/NaN|Infinity/.test(r.svg));
    assert.equal(dom(r.mathML).documentElement.localName, 'math');
    assert.equal(dom(r.svg).querySelectorAll('text').length, 0);
  }
});
test('unsupported syntax, malformed groups, duplicate scripts, huge input and missing glyphs fail explicitly', () => {
  for (const tex of [
    String.raw`\unknown{x}`,
    '{x',
    'x}',
    'x_1_2',
    String.raw`\frac{x}`,
    String.raw`\begin{matrix}a\end{bmatrix}`,
    '{'.repeat(65) + 'x' + '}'.repeat(65),
    'x'.repeat(16385),
  ])
    assert.throws(
      () => parseMath(tex),
      (e) => e.code === 'unsupported',
    );
  assert.throws(() => renderMath('🦄', { font }), /lacks/);
  assert.throws(() => renderMath('x', { font, size: 0 }), RangeError);
});
test('MathML text is escaped and labels retain one export outline without HTML injection', () => {
  const doc = new JSDOM('<div id="label"></div>').window.document,
    el = doc.getElementById('label');
  const result = mathLabel(el, String.raw`\text{<script> & data}`, { font });
  assert.equal(el.querySelectorAll('script').length, 0);
  assert.equal(el.querySelector('mtext').textContent, '<script> & data');
  assert.equal(JSON.parse(el.dataset.scivizMath).path, result.path);
});
test('security: math labels build MathML elements without parsing HTML, and hostile TeX text stays literal', () => {
  const doc = new JSDOM('<div id="label"></div>').window.document,
    el = doc.getElementById('label');
  Object.defineProperty(el, 'innerHTML', {
    set() {
      throw new Error('math label parsed an HTML string');
    },
  });
  const hostile = '"><img src=x onerror=alert(1)></math><script>alert(1)</script>';
  mathLabel(el, String.raw`\text{${hostile}}+x`, { font });
  const math = el.firstElementChild;
  assert.equal(math.namespaceURI, 'http://www.w3.org/1998/Math/MathML');
  assert.equal(math.localName, 'math');
  assert.equal(math.getAttribute('aria-label'), String.raw`\text{${hostile}}+x`);
  assert.equal(el.querySelectorAll('img,script').length, 0);
  assert.equal(el.querySelector('mtext').textContent, hostile);
  assert.equal(el.querySelector('mtext').namespaceURI, 'http://www.w3.org/1998/Math/MathML');
  assert.ok(mathML(String.raw`\text{${hostile}}`).includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
});
