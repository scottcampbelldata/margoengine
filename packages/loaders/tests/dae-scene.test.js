// COLLADA lookat and skew transforms, cameras and lights. Every document is written here from the COLLADA 1.4.1 and
// 1.5 specification text; expected numbers are worked out by hand in the comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LoaderError, daeCameraView, daeEngineLights, daeFrame, flattenDAE, parseDAE, poseDAE } from '../dist/index.js';

const close = (actual, expected, label, epsilon = 1e-9) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) < epsilon, `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
};
const near = (actual, expected, label, epsilon = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}: ${actual} != ${expected}`);
const rejects = (fn, code, pattern) =>
  assert.throws(
    fn,
    (error) => error instanceof LoaderError && error.code === code && (!pattern || pattern.test(error.message)),
  );
const YUP = '<unit meter="1"/><up_axis>Y_UP</up_axis>';
const ZUP_CM = '<unit meter="0.01"/><up_axis>Z_UP</up_axis>';
const ZUP = '<unit meter="1"/><up_axis>Z_UP</up_axis>';
const document = (asset, libraries, nodes) =>
  `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">` +
  `<asset>${asset}</asset>${libraries}<library_visual_scenes><visual_scene id="scene">${nodes}</visual_scene>` +
  '</library_visual_scenes><scene><instance_visual_scene url="#scene"/></scene></COLLADA>';
const triangle =
  '<library_geometries><geometry id="tri"><mesh><source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0' +
  '</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/>' +
  '<param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>' +
  '<vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1">' +
  '<input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles></mesh></geometry></library_geometries>';
const perspective = (id, body) =>
  `<camera id="${id}"><optics><technique_common><perspective>${body}</perspective></technique_common></optics></camera>`;
const orthographic = (id, body) =>
  `<camera id="${id}"><optics><technique_common><orthographic>${body}</orthographic></technique_common></optics></camera>`;
const cameras = (...list) => `<library_cameras>${list.join('')}</library_cameras>`;
const cameraNode = (url, transforms = '', id = `n-${url}`) =>
  `<node id="${id}">${transforms}<instance_camera url="#${url}"/></node>`;
const project = (view, aspect, webgpu = true) => {
  const out = new Float64Array(16).fill(7);
  view.project(out, aspect, webgpu);
  return [...out];
};

test('lookat: the node matrix places a frame at the eye looking down -Z at the interest point (Y_UP and Z_UP)', () => {
  // Spec example: eye (2, 0, 3), interest 0, up Y. forward f = -(2, 0, 3)/sqrt13; side = f x up = (3, 0, -2)/sqrt13;
  // true up = side x f = (0, 1, 0); columns side, up, -f, eye.
  const r = Math.sqrt(13),
    y = parseDAE(document(YUP, '', '<node id="cam"><lookat>2 0 3  0 0 0  0 1 0</lookat></node>'));
  close(y.nodes[0].matrix, [3 / r, 0, -2 / r, 0, 0, 1, 0, 0, 2 / r, 0, 3 / r, 0, 2, 0, 3, 1], 'Y_UP lookat');
  assert.deepEqual(y.nodes[0].transforms, [{ type: 'lookat', values: [2, 0, 3, 0, 0, 0, 0, 1, 0] }]);
  assert.deepEqual(y.warnings, []);
  // Z_UP centimeters: eye 5 m behind the origin on -Y, up Z. In the file the columns are side X, up Z, -f -Y and the
  // eye (0, -500, 0). Converted (x, y, z) -> (x, z, -y) and to meters: X stays, file Z is Y-up +Y, file -Y is +Z, and
  // the eye is (0, 0, 5): the node matrix is the conjugate R L R^T, columns X, +Z, -Y.
  const z = parseDAE(
    document(
      ZUP_CM,
      cameras(perspective('c', '<yfov>45</yfov><znear>10</znear><zfar>1000</zfar>')),
      '<node id="cam"><lookat sid="look">0 -500 0 0 0 0 0 0 1</lookat><instance_camera url="#c"/></node>',
    ),
  );
  close(z.nodes[0].matrix, [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 5, 1], 'Z_UP lookat');
  // The camera frame (world x up-axis rotation) is the identity rotation at (0, 0, 5): it looks down Y-up -Z.
  close(z.cameras[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1], 'Z_UP camera frame');
  const view = daeCameraView(z);
  close(view.position, [0, 0, 5], 'position');
  close(view.target, [0, 0, 4], 'target');
  close(view.up, [0, 1, 0], 'up');
  assert.equal(view.fov, 45);
  near(view.near, 0.1, 'near');
  near(view.far, 10, 'far');
});

test('skew: RenderMan shear about the rotation and translation axes (Y_UP and Z_UP), flattenDAE and poseDAE', () => {
  // Spec example 45, rotation axis Y, translation axis X: points slide along X by tan(45) y, so x' = x + y;
  // column-major the Y column becomes (1, 1, 0).
  const sheared = [1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    y = parseDAE(
      document(YUP, triangle, '<node id="s"><skew sid="k">45 0 1 0 1 0 0</skew><instance_geometry url="#tri"/></node>'),
    );
  close(y.nodes[0].matrix, sheared, 'Y_UP skew');
  assert.deepEqual(y.warnings, []);
  // The same shear written Z-up: rotation axis file Z (up), translation axis X: x' = x + z_file = x + y in Y-up.
  const z = parseDAE(document(ZUP, '', '<node id="s"><skew>45 0 0 1 1 0 0</skew></node>'));
  close(z.nodes[0].matrix, sheared, 'Z_UP skew');
  // Axes 45 degrees apart: rotation axis (1, 1, 0), translation X, angle 30. The rotation axis turns from 45 to 15
  // degrees off X, so k = cot(15) - cot(45) = (2 + sqrt3) - 1 = 1 + sqrt3 along X per unit of Y.
  const k = 1 + Math.sqrt(3),
    oblique = parseDAE(document(YUP, '', '<node id="s"><skew>30 1 1 0 1 0 0</skew></node>'));
  close(oblique.nodes[0].matrix, [1, 0, 0, 0, k, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 'oblique skew', 1e-12);
  // flattenDAE bakes the shear: (0, 1, 0) moves to (1, 1, 0).
  close(flattenDAE(y).positions, [0, 0, 0, 1, 0, 0, 1, 1, 0], 'flattened');
  // poseDAE without channels keeps the node matrix.
  close(poseDAE(y, 0).local.get(y.nodes[0]), sheared, 'posed');
});

test('animated lookat: whole-element and single-value channels move the camera frame', () => {
  const floats = (id, values, stride) =>
    `<source id="${id}"><float_array id="${id}-a" count="${values.length}">${values.join(' ')}</float_array>` +
    `<technique_common><accessor source="#${id}-a" count="${values.length / stride}" stride="${stride}">` +
    `${Array.from({ length: stride }, () => '<param name="V" type="float"/>').join('')}</accessor></technique_common></source>`;
  const animation = (id, target, values, stride) =>
    `<animation id="${id}">${floats(`${id}-in`, [0, 1], 1)}${floats(`${id}-out`, values, stride)}` +
    `<sampler id="${id}-s"><input semantic="INPUT" source="#${id}-in"/><input semantic="OUTPUT" source="#${id}-out"/>` +
    `</sampler><channel source="#${id}-s" target="${target}"/></animation>`;
  const libraries = (a) =>
    `${cameras(perspective('c', '<yfov>50</yfov><znear>0.1</znear><zfar>100</zfar>'))}<library_animations>${a}</library_animations>`;
  // Whole element, stride 9: eye from (0, 0, 5) to (5, 0, 0), looking at the origin with up Y. At t = 1:
  // f = (-1, 0, 0), side = f x up = (0, 0, -1), up = side x f = (0, 1, 0).
  const whole = parseDAE(
    document(
      YUP,
      libraries(animation('a', 'cam/look', [0, 0, 5, 0, 0, 0, 0, 1, 0, 5, 0, 0, 0, 0, 0, 0, 1, 0], 9)),
      '<node id="cam"><lookat sid="look">0 0 5 0 0 0 0 1 0</lookat><instance_camera url="#c"/></node>',
    ),
  );
  assert.equal(whole.animations[0].channels.length, 1);
  const pose = poseDAE(whole, 1);
  close(pose.local.get(whole.nodes[0]), [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 5, 0, 0, 1], 'posed lookat');
  close(daeFrame(whole, whole.cameras[0].node, pose), pose.world.get(whole.nodes[0]), 'Y_UP frame is the world');
  const view = daeCameraView(whole, 0, { pose });
  close(view.position, [5, 0, 0], 'posed position');
  close(view.target, [4, 0, 0], 'posed target');
  // At rest the camera stays at (0, 0, 5).
  close(daeCameraView(whole).position, [0, 0, 5], 'rest position');
  // One value: look(0) is the eye's x, moving from 0 to 4 while the interest stays at the origin. At t = 0.5 the eye
  // is (2, 0, 5).
  const single = parseDAE(
    document(
      YUP,
      libraries(animation('a', 'cam/look(0)', [0, 4], 1)),
      '<node id="cam"><lookat sid="look">0 0 5 0 0 0 0 1 0</lookat><instance_camera url="#c"/></node>',
    ),
  );
  assert.equal(single.animations[0].channels[0].index, 0);
  const half = daeCameraView(single, 0, { pose: poseDAE(single, 0.5) }),
    length = Math.hypot(2, 5);
  close(half.position, [2, 0, 5], 'half position');
  close(half.target, [2 - 2 / length, 0, 5 - 5 / length], 'half target');
});

test('perspective cameras: every combination the spec allows gives the vertical fov, aspect, near and far', () => {
  const dae = parseDAE(
    document(
      ZUP_CM,
      '<library_cameras>' +
        perspective('y', '<yfov>60</yfov><znear>10</znear><zfar>1000</zfar>') +
        perspective('x', '<xfov>90</xfov><znear>10</znear><zfar>1000</zfar>') +
        perspective('xy', '<xfov>90</xfov><yfov>60</yfov><znear>10</znear><zfar>1000</zfar>') +
        perspective('xa', '<xfov>90</xfov><aspect_ratio>2</aspect_ratio><znear>10</znear><zfar>1000</zfar>') +
        perspective('ya', '<yfov>60</yfov><aspect_ratio>1.5</aspect_ratio><znear>10</znear><zfar>1000</zfar>') +
        perspective(
          'xya',
          '<xfov>90</xfov><yfov>60</yfov><aspect_ratio>3</aspect_ratio><znear>1</znear><zfar>2</zfar>',
        ) +
        '</library_cameras>',
      // A Z_UP node at (100, 200, 300) cm rotated 90 degrees about file Z: the camera's -Z stays down file -Z (Y-up
      // -Y), and its +Y turns to file -X (Y-up -X). Position (1, 3, -2) m.
      cameraNode('y', '<translate>100 200 300</translate><rotate>0 0 1 90</rotate>') +
        cameraNode('x') +
        cameraNode('xy') +
        cameraNode('xa') +
        cameraNode('ya') +
        cameraNode('xya'),
    ),
  );
  assert.equal(dae.cameras.length, 6);
  assert.deepEqual(
    dae.cameras.map((c) => [c.id, c.type]),
    ['y', 'x', 'xy', 'xa', 'ya', 'xya'].map((id) => [id, 'perspective']),
  );
  assert.deepEqual(dae.cameras[0].perspective, { yfov: 60, znear: 0.1, zfar: 10 });
  assert.equal(dae.cameras[0].node, dae.nodes[0]);
  assert.ok(dae.warnings.some((w) => /camera "xya".*aspect_ratio is ignored.*give only two/.test(w)));
  const y = daeCameraView(dae, 0);
  close(y.position, [1, 3, -2], 'pose position', 1e-12);
  close(y.target, [1, 2, -2], 'pose target', 1e-12);
  close(y.up, [-1, 0, 0], 'pose up', 1e-12);
  assert.equal(y.fov, 60);
  assert.equal(y.aspect, undefined);
  assert.equal(y.project, undefined);
  near(y.near, 0.1, 'near');
  near(y.far, 10, 'far');
  // xfov only: the viewport aspect decides; aspect 2 gives yfov = 2 atan(tan(45) / 2) = 2 atan(0.5) = 53.1301...
  near(daeCameraView(dae, 1, { aspect: 2 }).fov, 53.13010235415598, 'xfov only');
  assert.throws(
    () => daeCameraView(dae, 1),
    (e) => e instanceof RangeError && /pass \{aspect/.test(e.message),
  );
  // xfov 90 and yfov 60: yfov kept, aspect tan(45) / tan(30) = sqrt3.
  const xy = daeCameraView(dae, 2);
  assert.equal(xy.fov, 60);
  near(xy.aspect, Math.sqrt(3), 'xy aspect', 1e-12);
  // xfov 90 with aspect 2: yfov = 2 atan(0.5).
  const xa = daeCameraView(dae, 3);
  near(xa.fov, 53.13010235415598, 'xfov + aspect');
  assert.equal(xa.aspect, 2);
  const ya = daeCameraView(dae, 4);
  assert.deepEqual([ya.fov, ya.aspect], [60, 1.5]);
  // All three: aspect_ratio dropped, as xfov + yfov.
  near(daeCameraView(dae, 5).aspect, Math.sqrt(3), 'over-specified', 1e-12);
  assert.throws(() => daeCameraView(dae, 6), RangeError);
});

test('orthographic cameras: ymag, xmag, both, and xmag with aspect_ratio, in meters', () => {
  const dae = parseDAE(
    document(
      ZUP_CM,
      '<library_cameras>' +
        orthographic('y', '<ymag>200</ymag><znear>0</znear><zfar>1000</zfar>') +
        orthographic('x', '<xmag>400</xmag><znear>0</znear><zfar>1000</zfar>') +
        orthographic('xy', '<xmag>400</xmag><ymag>100</ymag><znear>0</znear><zfar>1000</zfar>') +
        orthographic('xa', '<xmag>400</xmag><aspect_ratio>2</aspect_ratio><znear>0</znear><zfar>1000</zfar>') +
        '</library_cameras>',
      cameraNode('y') + cameraNode('x') + cameraNode('xy') + cameraNode('xa'),
    ),
  );
  assert.deepEqual(dae.cameras[0].orthographic, { ymag: 2, znear: 0, zfar: 10 });
  assert.deepEqual(dae.cameras[2].orthographic, { xmag: 4, ymag: 1, znear: 0, zfar: 10 });
  // Half-height 2 at aspect 2: out[0] = 1 / (2 * 2), out[5] = 1 / 2; reversed WebGPU depth over 0..10: 1/10 and 10/10.
  const y = daeCameraView(dae, 0);
  assert.equal(y.fov, undefined);
  assert.deepEqual([y.near, y.far], [0, 10]);
  close(project(y, 2), [0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.1, 0, 0, 0, 1, 1], 'ymag webgpu');
  close(project(y, 2, false), [0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, -0.2, 0, 0, 0, -1, 1], 'ymag webgl');
  // xmag 4 alone at aspect 2: half-height 4 / 2 = 2, the same projection.
  close(project(daeCameraView(dae, 1), 2), project(y, 2), 'xmag at aspect 2');
  close(project(daeCameraView(dae, 1), 4).slice(0, 6), [0.25, 0, 0, 0, 0, 1], 'xmag at aspect 4');
  // xmag 4 and ymag 1: aspect 4, half-height 1.
  const xy = daeCameraView(dae, 2);
  assert.equal(xy.aspect, 4);
  close(project(xy, 4).slice(0, 6), [0.25, 0, 0, 0, 0, 1], 'xmag + ymag');
  // xmag 4 with aspect 2: half-height 2 whatever the viewport.
  const xa = daeCameraView(dae, 3);
  assert.equal(xa.aspect, 2);
  close(project(xa, 1).slice(0, 6), [0.5, 0, 0, 0, 0, 0.5], 'xmag + aspect');
  // Assigning the view clears a perspective camera's projection and sets this one.
  const camera = { position: [0, 0, 0], project: undefined };
  Object.assign(camera, xa);
  assert.equal(typeof camera.project, 'function');
  Object.assign(
    camera,
    daeCameraView(
      parseDAE(
        document(YUP, cameras(perspective('p', '<yfov>40</yfov><znear>1</znear><zfar>9</zfar>')), cameraNode('p')),
      ),
    ),
  );
  assert.equal(camera.project, undefined);
  assert.equal(camera.fov, 40);
});

test('lights: every type with color, attenuation, spot angles and world directions after Z_UP centimeters', () => {
  const light = (id, type, body) =>
    `<light id="${id}" name="${id} light"><technique_common><${type}>${body}</${type}></technique_common></light>`;
  const dae = parseDAE(
    document(
      ZUP_CM,
      '<library_lights>' +
        light('sun', 'directional', '<color>2 1 0.5</color>') +
        light('fill', 'directional', '<color>0.5 0.5 0.5</color>') +
        light('sky', 'ambient', '<color>0.2 0.1 0.05</color>') +
        light(
          'bulb',
          'point',
          '<color>1 0.5 0</color><constant_attenuation>1</constant_attenuation>' +
            '<linear_attenuation>0.5</linear_attenuation><quadratic_attenuation>0.25</quadratic_attenuation>',
        ) +
        light('linear', 'point', '<color>3 3 3</color><linear_attenuation>0.02</linear_attenuation>') +
        light('flat', 'point', '<color>1 1 1</color><constant_attenuation>4</constant_attenuation>') +
        light(
          'cone',
          'spot',
          '<color>0 2 0</color><quadratic_attenuation>0.0001</quadratic_attenuation>' +
            '<falloff_angle>60</falloff_angle><falloff_exponent>20</falloff_exponent>',
        ) +
        light('wide', 'spot', '<color>1 1 1</color>') +
        '</library_lights>',
      // The sun points down file -Z: Y-up -Y. "fill" turns 90 degrees about file X, so its -Z becomes file +Y,
      // which is Y-up -Z. The bulb sits at (100, 200, 0) cm: Y-up (1, 0, -2) m. The cone at 300 cm up: (0, 3, 0).
      '<node id="a"><instance_light url="#sun"/><instance_light url="#sky"/></node>' +
        '<node id="b"><rotate>1 0 0 90</rotate><instance_light url="#fill"/></node>' +
        '<node id="c"><translate>100 200 0</translate><instance_light url="#bulb"/><instance_light url="#linear"/>' +
        '<instance_light url="#flat"/></node>' +
        '<node id="d"><translate>0 0 300</translate><instance_light url="#cone"/><instance_light url="#wide"/>' +
        '<instance_light url="#missing"/></node>',
    ),
  );
  assert.deepEqual(
    dae.lights.map((l) => [l.id, l.type]),
    [
      ['sun', 'directional'],
      ['sky', 'ambient'],
      ['fill', 'directional'],
      ['bulb', 'point'],
      ['linear', 'point'],
      ['flat', 'point'],
      ['cone', 'spot'],
      ['wide', 'spot'],
    ],
  );
  assert.ok(dae.warnings.some((w) => /instance_light "#missing" names no <light>/.test(w)));
  const [sun, , fill, bulb, , , cone, wide] = dae.lights;
  assert.equal(sun.name, 'sun light');
  assert.deepEqual(sun.color, [2, 1, 0.5]);
  close(sun.direction, [0, -1, 0], 'sun direction');
  close(fill.direction, [0, 0, -1], 'fill direction', 1e-12);
  close(bulb.position, [1, 0, -2], 'bulb position', 1e-12);
  // Per-centimeter coefficients become per-meter: linear 0.5 / 0.01 = 50, quadratic 0.25 / 0.0001 = 2500.
  assert.equal(bulb.constantAttenuation, 1);
  near(bulb.linearAttenuation, 50, 'linear');
  near(bulb.quadraticAttenuation, 2500, 'quadratic', 1e-6);
  close(cone.position, [0, 3, 0], 'cone position', 1e-12);
  close(cone.direction, [0, -1, 0], 'cone direction');
  assert.deepEqual([cone.falloffAngle, cone.falloffExponent], [60, 20]);
  assert.deepEqual([wide.falloffAngle, wide.falloffExponent, wide.constantAttenuation], [180, 0, 1]);

  const engine = daeEngineLights(dae, { intensity: 2 });
  // Sun: toward the light (0, 1, 0), color / 2, brightest channel 2 x exposure 2.
  close(engine.sun.toward, [0, 1, 0], 'sun toward');
  assert.deepEqual([engine.sun.color, engine.sun.intensity], [[1, 0.5, 0.25], 4]);
  assert.equal(engine.directional.length, 1);
  close(engine.directional[0].direction, [0, 0, -1], 'fill', 1e-12);
  assert.deepEqual([engine.directional[0].color, engine.directional[0].intensity], [[1, 1, 1], 1]);
  close(engine.ambient.color, [1, 0.5, 0.25], 'ambient color');
  near(engine.ambient.intensity, 0.4, 'ambient intensity');
  const [b, lin, flat, c, w] = engine.local;
  // Quadratic set: decay 2, intensity 1 x 2 / 2500; range sqrt(256 x intensity).
  assert.equal(b.decay, 2);
  near(b.intensity, 2 / 2500, 'bulb intensity', 1e-15);
  near(b.range, Math.sqrt((256 * 2) / 2500), 'bulb range', 1e-12);
  assert.deepEqual(b.color, [1, 0.5, 0]);
  assert.equal(b.direction, undefined);
  // Linear only (0.02 per cm = 2 per m): decay 1, intensity 3 x 2 / 2, range 256 x 3.
  assert.deepEqual([lin.decay, lin.intensity, lin.range], [1, 3, 768]);
  // Constant only: decay 0, unlimited range, intensity 2 / 4.
  assert.deepEqual([flat.decay, flat.intensity, flat.range], [0, 0.5, 0]);
  // Spot: quadratic 0.0001 per cm^2 = 1 per m^2; half of 60 degrees; inner where cos^20 = 1/2.
  assert.equal(c.decay, 2);
  near(c.intensity, 4, 'cone intensity', 1e-9);
  close(c.direction, [0, -1, 0], 'cone engine direction');
  near(c.outerAngle, Math.PI / 6, 'outer');
  near(c.innerAngle, Math.acos(0.5 ** (1 / 20)), 'inner');
  assert.ok(c.innerAngle < c.outerAngle);
  // Default spot: falloff 180 is a hemisphere, exponent 0 a hard edge.
  assert.deepEqual([w.outerAngle, w.innerAngle, w.decay, w.range], [Math.PI / 2, Math.PI / 2, 0, 0]);
  assert.throws(() => daeEngineLights(dae, { intensity: -1 }), RangeError);
});

test('lights follow a pose of their node', () => {
  const floats = (id, values) =>
    `<source id="${id}"><float_array id="${id}-a" count="${values.length}">${values.join(' ')}</float_array>` +
    `<technique_common><accessor source="#${id}-a" count="${values.length}"><param name="V" type="float"/>` +
    '</accessor></technique_common></source>';
  // The node turns from 0 to 90 degrees about Y: a spot's -Z becomes -X; the translation 2 on X stays.
  const dae = parseDAE(
    document(
      YUP,
      '<library_lights><light id="s"><technique_common><spot><color>1 1 1</color></spot></technique_common></light>' +
        `</library_lights><library_animations><animation>${floats('in', [0, 1])}${floats('out', [0, 90])}` +
        '<sampler id="sm"><input semantic="INPUT" source="#in"/><input semantic="OUTPUT" source="#out"/></sampler>' +
        '<channel source="#sm" target="n/turn.ANGLE"/></animation></library_animations>',
      '<node id="n"><translate>2 0 0</translate><rotate sid="turn">0 1 0 0</rotate><instance_light url="#s"/></node>',
    ),
  );
  close(dae.lights[0].direction, [0, 0, -1], 'rest');
  const posed = daeEngineLights(dae, { pose: poseDAE(dae, 1) }).local[0];
  close(posed.direction, [-1, 0, 0], 'posed', 1e-12);
  close(posed.position, [2, 0, 0], 'posed position', 1e-12);
});

test('malformed lookat, skew, cameras and lights give errors and warnings that name the fix', () => {
  const at = (asset, libraries, nodes) => () => parseDAE(document(asset, libraries, nodes));
  rejects(at(YUP, '', '<node><lookat>0 0 0 1 1</lookat></node>'), 'syntax', /lookat> needs 9 finite numbers, got 5/);
  rejects(at(YUP, '', '<node><skew>45 0 1 0</skew></node>'), 'syntax', /skew> needs 7 finite numbers/);
  // Eye on the interest point: warned, only the eye translation is kept.
  const degenerate = parseDAE(document(YUP, '', '<node id="n"><lookat>1 2 3 1 2 3 0 1 0</lookat></node>'));
  assert.ok(degenerate.warnings.some((w) => /<lookat>.*only the eye is used: fix eye, interest or up/.test(w)));
  close(degenerate.nodes[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], 'degenerate lookat');
  // Up along the view.
  assert.ok(
    parseDAE(document(YUP, '', '<node id="n"><lookat>0 0 0 0 1 0 0 1 0</lookat></node>')).warnings.some((w) =>
      /lookat/.test(w),
    ),
  );
  // Parallel skew axes, a zero translation axis, and an angle that turns the axis past the other: skipped.
  for (const values of ['45 1 0 0 1 0 0', '45 0 1 0 0 0 0', '90 0 1 0 1 0 0']) {
    const skipped = parseDAE(document(YUP, '', `<node id="n"><skew>${values}</skew></node>`));
    assert.ok(
      skipped.warnings.some((w) => /<skew> is skipped: give a nonzero translation axis/.test(w)),
      values,
    );
    close(skipped.nodes[0].matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], `skipped ${values}`);
  }
  const camera = (body) => at(YUP, cameras(perspective('c', body)), cameraNode('c'));
  rejects(camera('<yfov>45</yfov><znear>1</znear>'), 'syntax', /needs <znear> and <zfar>; add both/);
  rejects(camera('<znear>1</znear><zfar>9</zfar>'), 'syntax', /needs <xfov> or <yfov>; add one/);
  rejects(camera('<aspect_ratio>1</aspect_ratio><znear>1</znear><zfar>9</zfar>'), 'syntax', /needs <xfov> or <yfov>/);
  rejects(camera('<yfov>200</yfov><znear>1</znear><zfar>9</zfar>'), 'range', /<yfov> 200 is invalid; give degrees/);
  rejects(camera('<yfov>45</yfov><znear>0</znear><zfar>9</zfar>'), 'range', /give 0 < znear < zfar/);
  rejects(camera('<yfov>45</yfov><znear>9</znear><zfar>1</zfar>'), 'range', /znear 9 and zfar 1/);
  rejects(camera('<yfov>a</yfov><znear>1</znear><zfar>9</zfar>'), 'syntax', /invalid number "a"/);
  rejects(
    camera('<yfov>45</yfov><aspect_ratio>-1</aspect_ratio><znear>1</znear><zfar>9</zfar>'),
    'range',
    /width \/ height > 0/,
  );
  rejects(
    at(YUP, cameras(orthographic('c', '<xmag>0</xmag><znear>0</znear><zfar>9</zfar>')), cameraNode('c')),
    'range',
    /a size > 0/,
  );
  const unsupported = parseDAE(
    document(
      YUP,
      '<library_cameras><camera id="c"><optics><technique profile="X"/></optics></camera></library_cameras>',
      `${cameraNode('c')}${cameraNode('nothing')}`,
    ),
  );
  assert.equal(unsupported.cameras.length, 0);
  assert.ok(
    unsupported.warnings.some((w) => /camera "c" has no technique_common <perspective> or <orthographic>/.test(w)),
  );
  assert.ok(unsupported.warnings.some((w) => /instance_camera "#nothing" names no <camera>/.test(w)));
  const light = (type, body) =>
    at(
      YUP,
      `<library_lights><light id="l"><technique_common><${type}>${body}</${type}></technique_common></light></library_lights>`,
      '<node><instance_light url="#l"/></node>',
    );
  rejects(light('point', '<color>1 1</color>'), 'syntax', /<color> needs 3 finite numbers >= 0/);
  rejects(
    light('point', '<color>1 1 1</color><linear_attenuation>-1</linear_attenuation>'),
    'range',
    /is negative; give a number >= 0/,
  );
  rejects(
    light('point', '<color>1 1 1</color><constant_attenuation>0</constant_attenuation>'),
    'range',
    /all zero; give constant_attenuation 1/,
  );
  rejects(light('spot', '<color>1 1 1</color><falloff_angle>0</falloff_angle>'), 'range', /give degrees in \(0, 360\]/);
  rejects(
    light('spot', '<color>1 1 1</color><falloff_exponent>-2</falloff_exponent>'),
    'range',
    /falloff_exponent> -2 is negative/,
  );
  const other = parseDAE(
    document(
      YUP,
      '<library_lights><light id="l"><technique profile="X"/></light></library_lights>',
      '<node><instance_light url="#l"/></node>',
    ),
  );
  assert.equal(other.lights.length, 0);
  assert.ok(other.warnings.some((w) => /light "l" has no technique_common/.test(w)));
  assert.throws(
    () => daeCameraView(other, 0),
    (e) => e instanceof RangeError && /index below 0/.test(e.message),
  );
  assert.throws(() => daeFrame(other, { matrix: [], children: [] }), TypeError);
});

test('instance_node copies give one camera per copy, each at its own frame', () => {
  const dae = parseDAE(
    document(
      YUP,
      `${cameras(perspective('c', '<yfov>30</yfov><znear>1</znear><zfar>9</zfar>'))}` +
        '<library_nodes><node id="rig"><instance_camera url="#c"/></node></library_nodes>',
      '<node><translate>1 0 0</translate><instance_node url="#rig"/></node>' +
        '<node><translate>0 0 -4</translate><instance_node url="#rig"/></node>',
    ),
  );
  assert.equal(dae.cameras.length, 2);
  close(daeCameraView(dae, 0).position, [1, 0, 0], 'first copy');
  close(daeCameraView(dae, 1).position, [0, 0, -4], 'second copy');
  assert.notEqual(dae.cameras[0].perspective, dae.cameras[1].perspective);
});
