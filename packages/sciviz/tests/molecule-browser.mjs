import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-molecule.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  browser.page.setDefaultTimeout(180000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('#licorice')?.dataset.ready || document.querySelector('#ball')?.dataset.error,
    );
    assert.equal(await browser.page.locator('#ball').getAttribute('data-error'), null);
    await browser.page.screenshot({
      path: `test-results/batch176/molecule/${compat ? 'compat' : 'native'}-demo.png`,
      fullPage: true,
      timeout: 30000,
    });
    const report = await browser.page.evaluate(async () => {
      const demo = await import('/examples/sciviz-molecule.ts'),
        api = await import('/packages/sciviz/dist/molecule.js'),
        {parsePDB}=await import('/packages/loaders/dist/pdb.js'),
        {parseMMCIF}=await import('/packages/loaders/dist/mmcif.js'),
        check = (v, m) => {
          if (!v) throw new Error(m);
        };
      async function pixels(f) {
        await f.ready();
        f.engine.render();
        const bitmap = await createImageBitmap(await f.toPNG({ overlays: false })),
          c = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = c.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const p = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0,
          hash = 2166136261;
        for (let i = 0; i < p.length; i += 4) {
          if (Math.max(...[0, 1, 2].map((k) => Math.abs(p[i + k] - p[k]))) > 25) lit++;
          hash = Math.imul(hash ^ p[i] ^ (p[i + 1] << 8) ^ (p[i + 2] << 16), 16777619);
        }
        return { lit, hash };
      }
      const result = {
        atoms: demo.atomCount,
        bonds: demo.bondCount,
        counts: Object.fromEntries(Object.entries(demo.layers).map(([k, v]) => [k, v.primitiveCount])),
      };
      for (const [name, f] of Object.entries(demo.figures)) result[name] = await pixels(f);
      const layer = demo.layers.ball,
        draw = layer.draw.bind(layer);
      let draws = 0;
      layer.draw = (pass, context, renderer) => {
        let count = 0;
        draw(
          {
            setPipeline: (p) => pass.setPipeline(p),
            setBindGroup: (...a) => pass.setBindGroup(...a),
            draw: (...a) => {
              count++;
              check(a[0] === 6 && a[1] === 664, 'one six-vertex instanced impostor draw');
              pass.draw(...a);
            },
          },
          context,
          renderer,
        );
        check(count === 1, 'one draw per molecule');
        draws++;
      };
      result.before = await pixels(demo.figures.ball);
      layer.restore();
      result.restored = await pixels(demo.figures.ball);
      result.draws = draws;
      let pick = null;
      const canvas = document.querySelector('#ball');
      for (let y = canvas.clientHeight * 0.2; y < canvas.clientHeight * 0.8 && !pick; y += 8)
        for (let x = canvas.clientWidth * 0.2; x < canvas.clientWidth * 0.8 && !pick; x += 8) pick = layer.pick(x, y);
      check(pick && pick.residue.atoms.includes(pick.atomIndex), 'screen ray picks a full residue');
      result.picked = pick.residue;
      const empty = api.molecule(
        demo.figures.ball,
        parsePDB(await fetch('/packages/sciviz/tests/fixtures/molecule/1crn.pdb').then((r) => r.text())),
        { atomIndices: [] },
      );
      check(empty.primitiveCount === 0, 'empty selection');
      empty.dispose();
      const { moleculeIntersectionWGSL } = await import('/packages/sciviz/src/molecule-render.ts'),
        gpu = await demo.figures.space.renderer.compute(),
        out = gpu.zeros([8, 4]),
        kernel = gpu.kernel(
          moleculeIntersectionWGSL +
            `
@group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn main(){
let sphere=Primitive(vec4f(0.0,0.0,0.0,1.0),vec4f(0.0),vec4f(1.0),vec4f(1.0));
let cylinder=Primitive(vec4f(-2.0,0.0,0.0,0.25),vec4f(2.0,0.0,0.0,1.0),vec4f(1.0),vec4f(1.0));
let a=intersect(sphere,vec3f(0.0,0.0,3.0),vec3f(0.0,0.0,-1.0));result[0]=vec4f(a.n,a.t);
let b=intersect(sphere,vec3f(1.0,0.0,3.0),vec3f(0.0,0.0,-1.0));result[1]=vec4f(b.n,b.t);
let c=intersect(sphere,vec3f(0.0),vec3f(1.0,0.0,0.0));result[2]=vec4f(c.n,c.t);
let d=intersect(cylinder,vec3f(0.0,0.0,3.0),vec3f(0.0,0.0,-1.0));result[3]=vec4f(d.n,d.t);
let e=intersect(cylinder,vec3f(-5.0,0.15,0.0),vec3f(1.0,0.0,0.0));result[4]=vec4f(e.n,e.t);
let f=intersect(cylinder,vec3f(0.0,0.15,0.0),vec3f(1.0,0.0,0.0));result[5]=vec4f(f.n,f.t);
let g=intersect(cylinder,vec3f(0.0,0.25,3.0),vec3f(0.0,0.0,-1.0));result[6]=vec4f(g.n,g.t);
let h=intersect(cylinder,vec3f(-5.0,1.0,0.0),vec3f(1.0,0.0,0.0));result[7]=vec4f(h.n,h.t);
}`,
        );
      try {
        kernel.run({ result: out }, { workgroups: 1 });
        const values = await out.read(),
          expected = [2, 3, 1, 2.75, 3, 2, 3, 1e30];
        for (let i = 0; i < 8; i++)
          check(
            Math.abs(values[i * 4 + 3] - expected[i]) <= Math.abs(expected[i]) * 2 ** -23,
            'analytic sphere/cylinder root including tangent, parallel, cap, inside and miss',
          );
        result.analytic = Array.from(values.filter((_, i) => i % 4 === 3));
      } finally {
        kernel.dispose();
        out.dispose();
      }
      const { Figure } = await import('/packages/sciviz/dist/index.js'),
        c = document.createElement('canvas');
      c.style.width = '320px';
      c.style.height = '240px';
      document.body.append(c);
      const f = await Figure.create(c, {
          axes: false,
          controls: false,
          aspect: [1, 1, 1],
        }),
        raw = parseMMCIF(await fetch('/packages/sciviz/tests/fixtures/molecule/1crn.cif').then((r) => r.text())),
        a = api.molecule(f, raw);
      result.cif = await pixels(f);
      a.dispose();
      const b = api.molecule(
        f,
        parsePDB(await fetch('/packages/sciviz/tests/fixtures/molecule/1crn.pdb').then((r) => r.text())),
      );
      result.pdb = await pixels(f);
      check(result.pdb.lit > 100 && result.pdb.hash === result.cif.hash, 'PDB and mmCIF render exactly the same molecule');
      b.dispose();
      f.setLimits([-3, 3, -3, 3, -3, 3]);
      const eye = f.engine.camera.position,
        axis = [eye[0], -eye[2], eye[1]],
        length = Math.hypot(...axis),
        point = axis.map((v) => (v / length) * 0.7),
        atoms = raw.atoms.slice(0, 2).map((a) => ({ ...a, element: 'C' })),
        pair = {
          ...raw,
          atoms,
          positions: Float32Array.from([...point, ...point.map((v) => -v)]),
          colors: new Float32Array([1, 0, 0, 0, 0, 1]),
          radii: new Float32Array([0.76, 0.76]),
          bonds: new Uint32Array(),
        };
      const nearFirst = api.molecule(f, pair, { style: 'space-filling' });
      result.nearFirst = await pixels(f);
      nearFirst.dispose();
      const farFirst = api.molecule(
        f,
        {
          ...pair,
          positions: Float32Array.from([...point.map((v) => -v), ...point]),
          colors: new Float32Array([0, 0, 1, 1, 0, 0]),
        },
        { style: 'space-filling' },
      );
      result.farFirst = await pixels(f);
      farFirst.dispose();
      check(
        result.nearFirst.lit > 100 && result.nearFirst.hash === result.farFirst.hash,
        'analytic fragment depth makes overlapping sphere occlusion independent of instance order',
      );
      f.dispose();
      c.remove();
      for (const f of Object.values(demo.figures)) f.dispose();
      return result;
    });
    for (const name of ['ball', 'space', 'licorice']) assert.ok(report[name].lit > 100, `${name} renders real data`);
    assert.equal(report.atoms, 327);
    assert.equal(report.bonds, 337);
    assert.deepEqual(report.counts, { ball: 664, space: 327, licorice: 664 });
    assert.notEqual(report.ball.hash, report.space.hash);
    assert.notEqual(report.ball.hash, report.licorice.hash);
    assert.equal(report.before.hash, report.restored.hash);
    assert.deepEqual(errors, []);
    assert.equal(await browser.page.evaluate(() => window.__margoWGSLErrors?.length ?? 0), 0);
    console.log(compat ? 'webgl2-compat' : 'webgpu', JSON.stringify(report));
  } finally {
    await browser.close();
  }
}
