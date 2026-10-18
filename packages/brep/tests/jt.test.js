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
function file(version, little, lzma) {
  const options = { version, little, jt10: version >= 10 };
  return jtFile(options, [
    {
      id: SEG.lsg,
      type: 1,
      data: packed(little, lsgStream(options), lzma ? { lzma } : { zlib: true }),
    },
    { id: SEG.xt, type: 17, data: packed(little, xtElement(options, disc()), { zlib: version < 10 }) },
    { id: SEG.lod, type: 7, data: lodElement(options) },
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

test('JT 10: LZMA-compressed scene graphs (both header forms, other literal and position settings) read the same', () => {
  const plain = lsgStream({ jt10: true, little: true }),
    alone = Buffer.from(LZMA_DEFAULT, 'base64');
  // Unknown size with an end marker; the size written into the header; no size field at all.
  const sized = Uint8Array.from(alone);
  new DataView(sized.buffer).setUint32(5, plain.length, true);
  new DataView(sized.buffer).setUint32(9, 0, true);
  const bare = Uint8Array.from([...alone.subarray(0, 5), ...alone.subarray(13)]);
  for (const lzma of [alone, sized, bare, Buffer.from(LZMA_LC0_LP2_PB0, 'base64')])
    check(parseJT(file(10, true, lzma)), 10);
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
