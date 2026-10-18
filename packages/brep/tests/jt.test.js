import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseJT, tessellateJT } from '../dist/index.js';
import { jtFile, lodElement, lsgStream, note, packed, SEG, xtElement } from './jt-writer.js';

/** A planar disc of radius 10 mm as a Parasolid text transmit file (the XT reader's test body). */
function disc() {
  const nodes = [
    [12, '1 10 0 0 0 0 0 0 1e3 1e-8 0 0 0 1 0 3 1 2 3 4 0 5 6 0 '],
    [13, '2 1 0 1 0 9 0 0 5 9 '],
    [50, '3 2 0 9 0 0 0 +0 0 0 0 0 1 1 0 0 '],
    [31, '4 3 0 6 0 0 0 +0 0 0 0 0 1 1 0 0 .01 '],
    [19, '5 4 0 1 0 0 2 V'],
    [16, '6 5 0 ?7 0 0 4 0 0 1 '],
    [17, '7 0 8 7 7 0 10 6 0 0 +'],
    [15, '8 6 0 7 9 0 '],
    [14, '9 7 0 ?0 0 8 2 3 +0 0 0 0 2 '],
    [17, '10 0 0 0 0 0 7 6 0 0 -'],
  ];
  const data = `T51 : TRANSMIT FILE created by modeller version 130000017 SCH_1300000_130060 ${nodes.map(([t, r]) => `${t} ${r}`).join('')}1 0 `;
  const records = [];
  for (let rest = data; rest.length; ) {
    let n = Math.min(80, rest.length);
    while (n > 1 && n < rest.length && rest[n - 1] === ' ') n--;
    records.push(rest.slice(0, n));
    rest = rest.slice(n);
  }
  const text = `**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************
**PARASOLID !"#$%&'()*+,-./:;<=>?@[\\]^_\`{|}~0123456789**************************
**PART1;MC=test;FORMAT=text;GUISE=transmit;
**PART2;SCH=SCH_1300000_13006;USFLD_SIZE=0;
**PART3;
**END_OF_HEADER*****************************************************************
${records.join('\n')}
`;
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

/** A JT file of the test assembly; the LSG segment zlib-compressed (JT 9.5) or as `lzma` gives it (JT 10). */
function file(version, little, lzma, split = false) {
  const options = { version, little, jt10: version >= 10 };
  return jtFile(options, [
    {
      id: SEG.lsg,
      type: 1,
      data: packed(little, lsgStream(options), lzma ? { lzma } : { zlib: true }),
    },
    { id: SEG.xt, type: 17, data: packed(little, xtElement(options, disc()), { zlib: version < 10 }) },
    { id: SEG.lod, type: 7, data: lodElement(options, { split }) },
  ]);
}

const area = (mesh) => {
  let sum = 0;
  const p = mesh.positions,
    t = mesh.indices;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]),
      u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return sum;
};

/**
 * The tetrahedron shape mesh: 4 triangles, one per face group, closed and consistently wound (every directed edge once,
 * its reverse once, by position), enclosing 1/6 mm^3, with `vertices` vertex records.
 */
function checkMesh(mesh, vertices) {
  assert.equal(mesh.positions.length, vertices * 3);
  assert.equal(mesh.indices.length, 12);
  assert.deepEqual([...mesh.groups].sort(), [0, 1, 2, 3]);
  const key = (i) => [...mesh.positions.subarray(i * 3, i * 3 + 3)].map((v) => Math.round(v * 1e7)).join(',');
  const edges = new Set();
  let volume = 0;
  for (let t = 0; t < 12; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => mesh.indices[t + k]);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const e = `${key(p)}>${key(q)}`;
      assert.ok(!edges.has(e), `edge ${e} twice`);
      edges.add(e);
    }
    const P = (i) => [...mesh.positions.subarray(i * 3, i * 3 + 3)],
      [pa, pb, pc] = [P(a), P(b), P(c)];
    volume +=
      (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) -
        pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) +
        pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) /
      6;
  }
  for (const e of edges) assert.ok(edges.has(e.split('>').reverse().join('>')), `edge ${e} has no twin`);
  assert.equal(new Set([...edges].map((e) => e.split('>')[0])).size, 4);
  assert.ok(Math.abs(Math.abs(volume) - 1e-9 / 6) < 1e-15, `volume ${volume}`);
}

/** The assembly as the tests expect it, whatever the version, byte order or compression. */
function check(model, version) {
  assert.equal(model.version, version);
  assert.equal(model.unit, 0.001);
  assert.deepEqual(model.warnings, []);
  assert.equal(model.parts.length, 1);
  const [part] = model.parts;
  assert.equal(part.name, 'Disc');
  assert.equal(part.node, 5);
  // The LOD node offers shapes 7 and 8: the finest (first) is taken, with its LOD segment.
  assert.deepEqual(
    part.shapes.map((s) => [s.node, s.kind, s.lods.map((l) => [l.segment, l.segmentType])]),
    [[7, 'tri-strip', [[SEG.lod, 7]]]],
  );
  assert.deepEqual(
    part.brep.bodies.map((b) => [b.kind, b.faces.length]),
    [['shell', 1]],
  );
  assert.equal(model.instances.length, 2);
  const [a, b] = model.instances;
  assert.deepEqual(a.path, ['Assembly', 'Disc']);
  assert.deepEqual(a.color, [1, 0, 0, 1]);
  // Instance 1 moved 10 mm along x; instance 2 turned a quarter about z (x to +y) and moved 20 mm along y.
  assert.deepEqual(
    [...a.matrix].map((v) => +v.toFixed(9)),
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.01, 0, 0, 1],
  );
  assert.deepEqual(
    [...b.matrix].map((v) => +v.toFixed(9)),
    [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0.02, 0, 1],
  );
  const props = model.sceneGraph.properties.get(5);
  assert.equal(props.get('CAD_COUNT'), 42);
  assert.deepEqual(props.get('CREATED'), { date: '2026-10-18T07:05:03' });
  assert.equal(model.sceneGraph.properties.get(2).get('NOTE'), note());
  if (version < 10) checkMesh(part.shapes[0].mesh, 4);
  // The draw style attribute is not read but kept by its base type.
  assert.equal(model.sceneGraph.attributes.get(13).kind, 'other');
  const [meshes] = tessellateJT(model, { deflection: 1e-7 });
  assert.equal(meshes.length, 1);
  assert.deepEqual(meshes[0].failures, []);
  assert.ok(Math.abs(area(meshes[0]) - Math.PI * 1e-4) < 1e-3 * Math.PI * 1e-4);
}

test('JT 9.5: a zlib-compressed assembly reads into placed, named, coloured parts with their XT B-rep', () => {
  for (const little of [true, false]) check(parseJT(file(9.5, little)), 9.5);
});

// The JT 10 LSG stream of `lsgStream({ jt10: true, little: true })`, compressed by Python's lzma module (FORMAT_ALONE):
// default properties (lc 3, lp 0, pb 2), and lc 0, lp 2, pb 0 with a 64 KiB dictionary.
const LZMA_DEFAULT =
  'XQAAgAD//////////wAyADAHwQbw/4wsjnBe361OJbm29vrhUtWvT+192yPC+h9qfzBwQgPxW6OAuR2bp1nJ9OzCWfB5x7opncNlBrdPZnotL/dyAFMDmouMIRuGTlDYgMDHrtXzMugrMOG7lbB29URsAkjjYdlSasBDWR0zS9ARcqlxohRIFYx91TPv8OnBlpyQQQXjVqViDlBkKGwAJjrIOwjRC8ENFTggkqaLcLSX8zTJKMdGnqrTIuXsaUXe/RLZucj4ViIu5E1ZAAl0L+JKqo6nRWNzDAP47MkFRX3aRBCqFFIJg9bmv2KcequCNBoXAU3FCgE19Tl61kKSPxIVR4L4q/d0HMxWn8V8Ez0JzQQUUAEa3s+3vOLFUJJvzYRyqKcj2nsS46sowXAEu73+HDvY+RdNgXsZBnYhr3k2pSIONfaRe543AoFq1751IKpttpmfF0Ls9OBFgd7E9WWa0HZDAdu27e5nOTtle3Zlb52Ksiux5mdqvscl6wUHeRBJA1phZzN4CAgW2cQqexwwsVjw2fe2IqRMCgP/LxjrWCE7UO6RdHAMv7RQc1GxAFQaiHnnpHXoCexBWUS24CRH5yQixckDe1F/nRy2y3FztLk9iV2cE6TQ6QA9Ihz2Hxb5zM9R6pJmwqrk2j7YZ0Ty/SGwGoWgVgtjLU0aiAg2okGr1TzAWcDVJlGz62q3T9punWbLPaLNAEUcs+olqyrxn1IuK6DP3iNxUgwyIn3wjoesP1rBJY6BHKeuqJm4p0wBrMcoprRkBJHgLYOeRBXPtIT+CrZgi3En739DJbMvo4WNHvr92IFlqSVnex1RYC5HjMHhxafE95dGUH3h8L4KIlA7bRhRZaOmy+8I7UGrBFm3rqtCHjqCf404tRpCNvCDnGJLh7UYGG8MReGsiynz7CMAh3dBiEXICTGE/a5XRl9+lsyiGAOqdB3quiFunGQg5DTdzED9873YCeEDL9dpVlCEYli2JxHfXqDyeAA8/q+rwSxugU5713QmlS4nIxrS9a+bzZuV1Z1T8p7qsHtW9C0Jy3/uBII35XKsA1hKZLl6dD1xHyyPSuykx+CbG9THXZsS5vSV0aiwfWTPIJ103A7f/C+vk6ojyO/vaCc40kkvMef5mJervFjlPl42kCUeNnIv8KltxgdqInNI5gOtsVo28vKAxJeaqv/EJlIYc6QZds8sYHm6HJ+G7Jss8JZ19WS+xWrOylFy9GT/YE8QUs2oXNN61NnvSc0iZfxDxgxlyVzroCtCi0OGOsAsnEo8mvagaKPedYntqDinFN2PwlpT8nJnQaa4Dq05WUdEenPZZNG61/h3SK7uZ7YWEaq8lyQBjdiK6Eg3CYZhMfI98DwzGq7p55f7CGuG4F6Z4nLLodC/Jb4fX1EBoFmoqvjGMDTuh/hFXNAUM8QYcVOMYET1whUOXsufDpjO3r8GZdglol0w3SwHuv7otkGFcRi9jqs8VjEAIS0e2CQNA7YPq1DCDYWGzYRdHdc8sK+KQ1KPKf3NXTt8RazyQ7d3c/JcOq8kxt7LnbHb3BY3WgvCYUPy8oDP//NLb10=';
const LZMA_LC0_LP2_PB0 =
  'EgAAAQD//////////wAyADJqaS9HoD6kZP+XJTQ7ROSn+uk16Ro9gjLpi3089LePRKRtygL6gw9EKnweFzSqN/CM4xECjvOBf13PnozoyKQmifb/zV8l3dATXG4YVWs1Yb9Y+s6uXhlWGZFdCih0t3R2WsE64Q/yndllr56IPcUQ2KEu8la+Jw95i5ovZZh8LXbpJJHyfWXEqEEP4dtyE9CDHOMEDYcDZETYOc3SLpU2WSowX4eQPbXdH1W24GcZYqA+uLdNslUuf0rNwbQ6y8Bf84ykomQP9MSNvHtBXErYCnPEsgnvNcAufDp7F3GtqO5RPbD73mpyhMsP7+BxV6gdW++B8DILcGZh+EgD+MPexeWiZVh2+63+MnxCgAtFhrQUj2gdoFxpJatQH+e+kbfonMsOx2okRzd/nBsbj+iX6oD1NelV+JOiLEVnlFAkCkwNFFXnmahyA23amddzJNzLzsBeSN69P4ha3XjDMs7D8zseiN+ir6AqWO687Nb2NxqxdnymeYSMZxXj3X22PLfl3/yYXK+WoYfZNYapbEE9W6w4NNquBev9N7cyjow4IRJgprJl3j+1sFtozxKsJJHSqx1nRHhEgWnELZQWD60+0uAlKVK6lSbi1LAd+2rflyCPgw5CEwARBS1IjOLgkd7YgMQmLMNjiN+HTc/Ki5+QpQH8bajocLIJztSHxc7Z0Mk2CO9GjkvYRSBKPljOWdiqRCUZsJrnm1vCyMQHoiIAqSK9upYCfNK7Zv9n5iGQLIXZZZxq7lGEUVQJiCllqvEISc4Mq/i9k1X3TXm5RHdQjX4zL/6dWNGpkRwqMR9dPNa4scgmMbXCpnAWBoEg4cu/yRwaYW939jisSlNOsw3UoJacjEb8CFSusWhqQQW+7eIhzDx/fhVMxEZ3rDoZVuIjvBthE+zEqmXesDuFggyn50tS9XQtOb9AgDtSYGg+bhL/C9FSyqMuG5yGhbRhQKfJenNjUY1RwEk7Dw4T+ef/0DKaWbDo2BsInJwIDKYTwemDnTn88SgV9trF9hNCDEywE387CXDvWGJDzYku9NfH6F7g2RHj5YuCP96AVfmaNMBUgGaavRqplZ5ERqqAhDxZhgljBHpK0M3tg/XwOM7O+hgwOrFVes/F478LjdOP/wL839mQUFAxIqiR38GWeEIlVCGJxdCCLGi6ZaKldgmnYbP9kCx2f3Rs/TTy++OYf4i3ytwEAj9fggLOG3m6GurlS5j4L2dJD7+jcnlV8jtAAmodozq9tox3IlCGpt8vtrDR0sXt9GESJkf5efaZpuQCtzh2+Yj+NfzhM9eJ5WVzNqsyCijiSpgYljWaGwiYLgSg8rDQ+O0gpvw7HZwZ+JipsRX45wPdkMBndEE9dKhoL7bZ9wq3eu+6bzNuvHqoS+i3qR4Ex+5wg7gJH9jgTMDmyLHFwVOeU1GuTfAvHFWjdi62NPAtcit7M5/zgOAIJtcZG+QiPXC1A6Gd8MiidKR8zaR0UbpLfBT6fwBzmcCOJYAOTH+tG+7p+hlX/w==';

// The same stream in the XZ container (LZMA2 chunks), as JT 10.5 files hold it: CRC64 check and default settings; CRC32
// check, a 64 KiB dictionary and lc 1, lp 1, pb 1.
const XZ_CRC64 =
  '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4CntBIpdADIAMAfBBvD/jCyOcF7frU4lubb2+uFS1a9P7X3bI8L6H2p/MHBCA/Fbo4C5HZunWcn07MJZ8HnHuimdw2UGt09mei0v93IAUwOai4whG4ZOUNiAwMeu1fMy6Csw4buVsHb1RGwCSONh2VJqwENZHTNL0BFyqXGiFEgVjH3VM+/w6cGWnJBBBeNWpWIOUGQobAAmOsg7CNELwQ0VOCCSpotwtJfzNMkox0aeqtMi5expRd79Etm5yPhWIi7kTVkACXQv4kqqjqdFY3MMA/jsyQVFfdpEEKoUUgmD1ua/Ypx6q4I0GhcBTcUKATX1OXrWQpI/EhVHgvir93QczFafxXwTPQnNBBRQARrez7e84sVQkm/NhHKopyPaexLjqyjBcAS7vf4cO9j5F02BexkGdiGveTalIg419pF7njcCgWrXvnUgqm22mZ8XQuz04EWB3sT1ZZrQdkMB27bt7mc5O2V7dmVvnYqyK7HmZ2q+xyXrBQd5EEkDWmFnM3gICBbZxCp7HDCxWPDZ97YipEwKA/8vGOtYITtQ7pF0cAy/tFBzUbEAVBqIeeekdegJ7EFZRLbgJEfnJCLFyQN7UX+dHLbLcXO0uT2JXZwTpNDpAD0iHPYfFvnMz1HqkmbCquTaPthnRPL9IbAahaBWC2MtTRqICDaiQavVPMBZwNUmUbPrardP2m6dZss9os0ARRyz6iWrKvGfUi4roM/eI3FSDDIiffCOh6w/WsEljoEcp66ombinTAGsxyimtGQEkeAtg55EFc+0hP4KtmCLcSfvf0Mlsy+jhY0e+v3YgWWpJWd7HVFgLkeMweHFp8T3l0ZQfeHwvgoiUDttGFFlo6bL7wjtQasEWbeuq0IeOoJ/jTi1GkI28IOcYkuHtRgYbwxF4ayLKfPsIwCHd0GIRcgJMYT9rldGX36WzKIYA6p0Heq6IW6cZCDkNN3MQP3zvdgJ4QMv12lWUIRiWLYnEd9eoPJ4ADz+r6vBLG6BTnvXdCaVLicjGtL1r5vNm5XVnVPynuqwe1b0LQnLf+4EgjflcqwDWEpkuXp0PXEfLI9K7KTH4Jsb1MddmxLm9JXRqLB9ZM8gnXTcDt/8L6+TqiPI7+9oJzjSSS8x5/mYl6u8WOU+XjaQJR42ci/wqW3GB2oic0jmA62xWjby8oDEl5qq/8QmUhhzpBl2zyxgebocn4bsmyzwlnX1ZL7Fas7KUXL0ZP9gTxBSzahc03rU2e9JzSJl/EPGDGXJXOugK0KLQ4Y6wCycSjya9qBoo951ie2oOKcU3Y/CWlPycmdBprgOrTlZR0R6c9lk0brX+HdIru5nthYRqryXJAGN2IroSDcJhmEx8j3wPDMarunnl/sIa4bgXpnicsuh0L8lvh9fUQGgWaiq+MYwNO6H+EVc0BQzxBhxU4xgRPXCFQ5ey58OmM7evwZl2CWiXTDdLAe6/ui2QYVxGL2OqzxWMQAhLR7YJA0Dtg+rUMINhYbNhF0d1zywr4pDUo8p/c1dO3xFrPJDt3dz8lw6ryTG3sudsdvcFjdaC8JhQzwFLgAAAADjPSS0Xh/35gABpgnuUwAAveJaWbHEZ/sCAAAAAARZWg==';
const XZ_CRC32 =
  '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';

test('JT 10: LZMA- and XZ-compressed scene graphs (header forms, LZMA2 chunks, other settings) read the same', () => {
  const plain = lsgStream({ jt10: true, little: true }),
    alone = Buffer.from(LZMA_DEFAULT, 'base64');
  // Unknown size with an end marker; the size written into the header; no size field at all.
  const sized = Uint8Array.from(alone);
  new DataView(sized.buffer).setUint32(5, plain.length, true);
  new DataView(sized.buffer).setUint32(9, 0, true);
  const bare = Uint8Array.from([...alone.subarray(0, 5), ...alone.subarray(13)]);
  for (const lzma of [
    alone,
    sized,
    bare,
    Buffer.from(LZMA_LC0_LP2_PB0, 'base64'),
    Buffer.from(XZ_CRC64, 'base64'),
    Buffer.from(XZ_CRC32, 'base64'),
  ])
    check(parseJT(file(10, true, lzma), { meshes: false }), 10);
});

test('JT 9.5: a tri-strip LOD decodes through the topology coder, one vertex record per corner or per triangle', () => {
  for (const little of [true, false]) {
    const model = parseJT(file(9.5, little, undefined, true));
    assert.deepEqual(model.warnings, []);
    checkMesh(model.parts[0].shapes[0].mesh, 12);
  }
  // A damaged topology stream fails its hash: the shape is left out with a warning.
  const bytes = file(9.5, true),
    at = bytes.length - 40;
  bytes[at] ^= 0x10;
  const model = parseJT(bytes);
  assert.equal(model.parts[0].shapes[0].mesh, undefined);
  assert.match(model.warnings.join('\n'), /shape 7 was not decoded \(Invalid JT file: vertex coordinate hash/);
});

test('JT: files older than 9.5 throw a RangeError; malformed ones a TypeError that says what', () => {
  const ok = file(9.5, true);
  const old = Uint8Array.from(ok);
  old.set(Uint8Array.from('Version 8.1', (c) => c.charCodeAt(0)));
  assert.throws(() => parseJT(old), { name: 'RangeError', message: /JT 8\.1 .*9\.5 and later/ });
  assert.throws(() => parseJT(ok.subarray(0, 100)), { name: 'TypeError', message: /too short/ });
  const order = Uint8Array.from(ok);
  order[80] = 7;
  assert.throws(() => parseJT(order), { name: 'TypeError', message: /byte order 7/ });
  // A damaged zlib stream in the LSG segment.
  const broken = Uint8Array.from(ok),
    lsgData = 105 + 4 + 3 * 28 + 24 + 9;
  broken.fill(0xff, lsgData + 10, lsgData + 40);
  assert.throws(() => parseJT(broken), { name: 'TypeError', message: /Invalid JT file/ });
  // A late-loaded XT segment the TOC does not list: the part keeps its shapes, the warning says why.
  const lost = Uint8Array.from(ok),
    toc = new DataView(lost.buffer, 105 + 4 + 28);
  toc.setUint8(15, 0x09);
  const model = parseJT(lost);
  assert.equal(model.parts[0].brep, undefined);
  assert.match(
    model.warnings.join('\n'),
    /Disc: its XT B-rep could not be read \(Invalid JT file: segment .* is not in the TOC\)/,
  );
});
