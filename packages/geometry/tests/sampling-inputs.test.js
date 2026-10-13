import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('non-finite tessellation and sampling inputs reject before entering their loops', () => {
  const module = new URL('../dist/index.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import * as G from ${JSON.stringify(module)};
    const curve = new G.LineCurve3([0, 0, 0], [0, 0, 1]);
    const path = new G.Path([[0, 0], [1, 0], [0, 1]]);
    const shape = new G.Shape([[0, 0], [1, 0], [0, 1]]);
    for (const bad of [Infinity, -Infinity, NaN]) {
      const calls = [
        () => G.boxGeometry(1, 1, 1, bad), () => G.planeGeometry(1, 1, bad),
        () => G.circleGeometry(1, bad), () => G.ringGeometry(0.5, 1, bad),
        () => G.cylinderGeometry(1, 1, 1, bad), () => G.coneGeometry(1, 1, bad),
        () => G.sphereGeometry(1, bad), () => G.capsuleGeometry(1, 1, bad),
        () => G.torusGeometry(1, 0.4, bad), () => G.torusKnotGeometry(1, 0.4, bad),
        () => G.latheGeometry([[0, -1], [1, 0], [0, 1]], bad), () => G.tubeGeometry(curve, bad),
        () => G.tetrahedronGeometry(1, bad), () => G.loopSubdivide(G.planeGeometry(), bad),
        () => curve.getPoints(bad), () => curve.getSpacedPoints(bad), () => curve.getLengths(bad),
        () => curve.computeFrenetFrames(bad), () => path.getPoints(bad), () => path.getSpacedPoints(bad),
        () => G.shapeGeometry(shape, bad), () => G.extrudeGeometry(shape, {steps: bad}),
        () => G.extrudeGeometry(shape, {bevelSegments: bad}),
        () => new G.EllipseCurve(0, 0, 1, 1, 0, bad).getPoint(0.5),
      ];
      for (const call of calls) assert.throws(call, RangeError);
    }
  `], {timeout: 3000, encoding: 'utf8', maxBuffer: 64 * 1024});
  assert.equal(child.error, undefined, 'Sampling did not return within the subprocess timeout');
  assert.equal(child.status, 0, child.stderr);
});

test('large finite ellipse sweeps normalize in bounded time and retain arc direction', () => {
  const module = new URL('../dist/index.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import {EllipseCurve} from ${JSON.stringify(module)};
    const tau = 2 * Math.PI;
    for (const end of [1e20, -1e20, 1e100, -1e100]) for (const clockwise of [false, true]) {
      let sweep = end % tau;
      if (sweep < 0) sweep += tau;
      if (sweep < Number.EPSILON) sweep = tau;
      if (clockwise) sweep = sweep === tau ? -tau : sweep - tau;
      const ellipse = new EllipseCurve(0, 0, 2, 3, 0, end, clockwise);
      const actual = ellipse.getPoint(0.5);
      assert.deepEqual(actual, [2 * Math.cos(0.5 * sweep), 3 * Math.sin(0.5 * sweep)]);
    }
    for (const end of [-4 * tau, -3 * tau - 0.25, -0.25, 0, tau, 3 * tau + 0.25]) {
      let sweep = end;
      const samePoints = Math.abs(sweep) < Number.EPSILON;
      while (sweep < 0) sweep += tau;
      while (sweep > tau) sweep -= tau;
      if (sweep < Number.EPSILON) sweep = samePoints ? 0 : tau;
      for (const clockwise of [false, true]) for (const t of [0, 0.25, 0.5, 1]) {
        const directed = clockwise && !samePoints ? (sweep === tau ? -tau : sweep - tau) : sweep;
        const actual = new EllipseCurve(0, 0, 2, 3, 0, end, clockwise).getPoint(t);
        assert.ok(Math.abs(actual[0] - 2 * Math.cos(t * directed)) < 1e-12);
        assert.ok(Math.abs(actual[1] - 3 * Math.sin(t * directed)) < 1e-12);
      }
    }
  `], {timeout: 3000, encoding: 'utf8', maxBuffer: 64 * 1024});
  assert.equal(child.error, undefined, 'Ellipse normalization did not return within the subprocess timeout');
  assert.equal(child.status, 0, child.stderr);
});
