// The physics render check on the WebGL2 preview backend (`@margoengine/webgl2-compat/preview`), which has no GPU device to read from: the
// meshes follow the bodies, and the settled stack's pixels are read from the page's WebGL2 context, as the preview's own check does.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { meshRuntime } from '@margoengine/core/extension';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';
import { Physics } from '@margoengine/physics';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const SIZE = 256;

// World point to pixel with the engine's column-major view-projection.
const project = (m, [x, y, z]) => {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12],
    cy = m[1] * x + m[5] * y + m[9] * z + m[13],
    w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [Math.round(((cx / w) * 0.5 + 0.5) * SIZE - 0.5), Math.round((0.5 - (cy / w) * 0.5) * SIZE - 0.5)];
};

window.runPhysicsPreviewTests = async () => {
  await Physics.load();
  const canvas = document.querySelector('#view');
  const engine = await Engine.create(canvas, {
    backend: 'webgl2',
    fallback: webglRenderer,
    exactSize: [SIZE, SIZE],
    camera: { position: [0, 3, 14], target: [0, 2.5, 0], fov: 45, near: 0.1, far: 100 },
  });
  const report = { checks: [], backend: engine.backend };
  assert(engine.backend === 'webgl2', `the engine runs on ${engine.backend}, not the WebGL2 preview`);
  const physics = new Physics(engine);
  assert(engine.hasPlugin('physics'), 'physics plugin attached');
  const floor = engine
    .createMesh()
    .setGeometry(box(12, 1, 12))
    .setMaterial(new PbrMaterial({ color: '#808080' }))
    .setPosition([0, -0.5, 0]);
  physics.addBody(floor, { type: 'fixed' });
  const cube = box(1, 1, 1),
    red = new PbrMaterial({ color: '#ff2020' }),
    blue = new PbrMaterial({ color: '#2040ff' });
  const stack = [];
  for (let i = 0; i < 5; i++) {
    const mesh = engine
      .createMesh()
      .setGeometry(cube)
      .setMaterial(i % 2 ? blue : red)
      .setPosition([0.02 * (i % 2), 2 + i * 1.3, 0])
      .setRotation([0, 0.05 * i, 0]);
    stack.push({ mesh, body: physics.addBody(mesh, { colliders: { shape: 'box', friction: 0.8 } }), red: i % 2 === 0 });
  }
  let worstMoving = 0;
  const deltas = [1 / 60, 1 / 75, 1 / 50, 1 / 144, 1 / 30];
  for (let frame = 0; frame < 40; frame++) {
    engine.render({ delta: deltas[frame % deltas.length] });
    for (const { mesh, body } of stack) {
      const matrix = meshRuntime(mesh).matrix,
        p = body.pose,
        a = physics.alpha;
      for (let axis = 0; axis < 3; axis++)
        worstMoving = Math.max(worstMoving, Math.abs(matrix[12 + axis] - (p[axis] + (p[axis + 7] - p[axis]) * a)));
    }
  }
  assert(worstMoving < 1e-4, `Rendered positions differ from the interpolated physics state by ${worstMoving}`);
  report.movingError = worstMoving;
  report.checks.push(
    'On the preview, rendered world matrices equal the interpolated physics poses while the stack falls',
  );

  for (let frame = 0; frame < 300; frame++) engine.render({ delta: 1 / 60 });
  const gl = canvas.getContext('webgl2');
  assert(gl, 'the page has the WebGL2 context the preview draws with');
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  // readPixels counts rows from the bottom.
  const at = (x, y) => [...pixels.slice(((SIZE - 1 - y) * SIZE + x) * 4, ((SIZE - 1 - y) * SIZE + x) * 4 + 3)];
  report.stack = [];
  for (const [i, { body, red: isRed }] of stack.entries()) {
    const [x, y, z] = body.position,
      pixel = project(engine.camera.matrix, [x, y, z + 0.5]),
      color = at(...pixel);
    report.stack.push({ y: Math.round(y * 1000) / 1000, pixel, color });
    assert(Math.abs(y - (0.5 + i)) < 0.05 && Math.abs(x) < 0.1, `Box ${i} settled at ${body.position}`);
    assert(isRed ? color[0] > color[2] + 40 : color[2] > color[0] + 40, `Box ${i} pixel ${pixel} is ${color}`);
  }
  const floorPixel = at(...project(engine.camera.matrix, [3, 0, 3]));
  assert(Math.abs(floorPixel[0] - floorPixel[2]) < 20 && floorPixel[0] > 20, `Floor pixel is ${floorPixel}`);
  report.floor = floorPixel;
  report.checks.push(
    'On the preview, the settled stack renders where the bodies are, in each box colour, over the floor',
  );
  // The debug buffer on the preview, which draws no Lines: any backend draws it with plain WebGL2 lines from its own context.
  const debug = physics.debugRender({ contacts: false }),
    points = debug.vertices.length / 3,
    stride = debug.colors.length / points,
    overlay = document.createElement('canvas');
  assert(points > 0 && Number.isInteger(stride) && stride >= 3, 'debugRender returns line buffers');
  overlay.width = overlay.height = SIZE;
  document.body.append(overlay);
  const og = overlay.getContext('webgl2', { preserveDrawingBuffer: true }),
    shader = (type, source) => {
      const s = og.createShader(type);
      og.shaderSource(s, source);
      og.compileShader(s);
      assert(og.getShaderParameter(s, og.COMPILE_STATUS), og.getShaderInfoLog(s));
      return s;
    },
    program = og.createProgram();
  og.attachShader(
    program,
    shader(
      og.VERTEX_SHADER,
      '#version 300 es\nin vec3 p;in vec4 c;uniform mat4 m;out vec4 v;void main(){gl_Position=m*vec4(p,1.0);v=c;}',
    ),
  );
  og.attachShader(
    program,
    shader(og.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;in vec4 v;out vec4 o;void main(){o=v;}'),
  );
  og.linkProgram(program);
  assert(og.getProgramParameter(program, og.LINK_STATUS), og.getProgramInfoLog(program));
  og.useProgram(program);
  const feed = (name, data, size) => {
    const buffer = og.createBuffer(),
      at = og.getAttribLocation(program, name);
    og.bindBuffer(og.ARRAY_BUFFER, buffer);
    og.bufferData(og.ARRAY_BUFFER, data, og.STATIC_DRAW);
    og.enableVertexAttribArray(at);
    og.vertexAttribPointer(at, size, og.FLOAT, false, 0, 0);
  };
  feed('p', debug.vertices, 3);
  feed('c', debug.colors, stride);
  og.uniformMatrix4fv(og.getUniformLocation(program, 'm'), false, engine.camera.matrix);
  og.viewport(0, 0, SIZE, SIZE);
  og.clearColor(0, 0, 0, 0);
  og.clear(og.COLOR_BUFFER_BIT);
  og.drawArrays(og.LINES, 0, points);
  const lit = new Uint8Array(SIZE * SIZE * 4);
  og.readPixels(0, 0, SIZE, SIZE, og.RGBA, og.UNSIGNED_BYTE, lit);
  let drawn = 0;
  for (let i = 3; i < lit.length; i += 4) if (lit[i] > 0) drawn++;
  const top = stack[4].body.position,
    edge = project(engine.camera.matrix, [top[0], top[1] + 0.5, top[2] + 0.5]),
    mark = [-1, 0, 1].flatMap((dy) =>
      [-1, 0, 1].map((dx) => lit[((SIZE - 1 - (edge[1] + dy)) * SIZE + edge[0] + dx) * 4 + 3]),
    );
  assert(drawn > 100, `the debug lines drew only ${drawn} pixels`);
  assert(
    mark.some((alpha) => alpha > 0),
    `the top box's edge at ${edge} is not drawn: ${mark}`,
  );
  report.debugPixels = drawn;
  report.checks.push(
    'On the preview, the physics debugRender buffer drawn with plain WebGL2 lines marks the edge of a box',
  );
  engine.dispose();
  assert(physics.isDisposed, 'engine.dispose() disposes the physics plugin');
  report.checks.push('engine.dispose() frees the physics world on the preview');
  return report;
};
