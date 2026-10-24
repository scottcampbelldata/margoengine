// The one source of margoengine.com/errors (site/errors.html, written by scripts/errors/page.mjs). Core and the stage
// keep their error messages short and end each with "; see https://margoengine.com/errors#<id>" (fault, typeError and
// rangeError in packages/shared/errors.js). tests/errors-page.test.js checks that every id a core or stage throw links
// to is here, that every MargoError code core throws has its entry, and that the page matches this file.
// Entry: id (the anchor), title, kind ('code' for a MargoError code, else 'family'), messages (the short texts that
// link here), cause and fix (plain text for developers; `code` spans in backticks).

/** @type {{id: string, title: string, kind: 'code' | 'family', messages: string[], cause: string, fix: string}[]} */
export const entries = [
  {
    id: 'disposed',
    title: 'disposed: used after dispose()',
    kind: 'code',
    messages: ['Engine disposed', 'Mesh disposed', 'Transforms disposed'],
    cause:
      'The engine, a mesh or the transform store was disposed, and the code kept a reference and called it again. A pick still waiting when the engine is disposed resolves null instead.',
    fix: 'Drop references when you call `dispose()`, and create a new `Engine` or mesh (`engine.createMesh()`) to keep drawing. Check `engine.disposed` before late callbacks (timers, fetches, promise continuations) touch the engine.',
  },
  {
    id: 'unsupported',
    title: 'unsupported: the browser or device lacks something needed',
    kind: 'code',
    messages: [],
    cause: 'The browser or GPU lacks a capability the call needs. See the WebGPU entry for the messages core throws.',
    fix: 'Feature-test before calling, or offer a fallback path. Branch on `error.code === "unsupported"`.',
  },
  {
    id: 'state',
    title: 'state: not valid right now',
    kind: 'code',
    messages: [],
    cause:
      'The call is valid in general but not at this moment: a re-entrant call from a callback, a missing prerequisite, or a device that is being restored. The re-entrancy, device restore and install entries list the messages.',
    fix: 'Retry later, from outside the callback, or after the prerequisite is in place.',
  },
  {
    id: 'failed',
    title: 'failed: the operation ran and produced no result',
    kind: 'code',
    messages: [],
    cause: 'The GPU or the transform kernel could not complete the work. See the GPU lost and limits entries.',
    fix: 'Read the message for the GPU or kernel detail; most failures are recovered by the engine or need smaller inputs.',
  },
  {
    id: 'webgpu',
    title: 'WebGPU required or unavailable',
    kind: 'family',
    messages: ['WebGPU required', 'WebGPU unavailable', 'WebGPU adapter unavailable', 'No WebGPU canvas'],
    cause:
      '`engine.pick` and `engine.rebootDevice` need the WebGPU backend; on the WebGL2 fallback they reject. `Engine.create` found no `navigator.gpu`, no adapter, or a canvas that already has another context.',
    fix: 'Use a browser with WebGPU (current Chrome, Edge or Safari; margoengine.com/webgpu), turn on hardware acceleration, or pass `{backend: "auto", fallback: webglRenderer}` from `@margoengine/webgl`. Give the engine a fresh canvas that has no 2D or WebGL context.',
  },
  {
    id: 'device-restore',
    title: 'Geometry unavailable during device restore',
    kind: 'family',
    messages: ['Geometry unavailable'],
    cause:
      'The GPU device was lost and the engine is recreating it; GPU resources cannot be read or created until it finishes.',
    fix: 'Wait for `engine.rebootDevice()` (or the next frame) to finish, then retry. Packages restore their GPU state in `onDeviceRestored`.',
  },
  {
    id: 'gpu-lost',
    title: 'GPU lost or a GPU validation error',
    kind: 'family',
    messages: ['GPU lost: <reason>', '<WebGPU validation message>'],
    cause:
      'The browser lost the GPU device (driver reset, tab in the background too long, GPU process crash), or WebGPU reported an uncaptured validation error.',
    fix: 'Core recreates the device itself; recreate textures your code owns (view `target`s) in `onDeviceRestored`. A validation error names the GPU object at fault: fix the call that created it.',
  },
  {
    id: 'reentrancy',
    title: 'Render or frame graph re-entered',
    kind: 'family',
    messages: ['Render recursion', 'Graph executing', 'Graph recursion'],
    cause:
      '`engine.render` was called from inside a frame callback, a plugin hook or a pass, or a pass added passes to the graph or ran the graph while it was executing.',
    fix: 'Call `render` from your own loop or `engine.start()`, never from inside a frame. Add or remove passes from `registerPasses`, `setup` or outside the frame.',
  },
  {
    id: 'install',
    title: 'Optional package missing or format unknown',
    kind: 'family',
    messages: ['Install <package>', 'Specify format'],
    cause:
      '`stage.load` needs an optional package for this format and it is not installed, or the URL has no known extension.',
    fix: 'Install the named package (for example `npm i @margoengine/gltf`), or pass `{format}`: one of gltf, glb, stl, obj, step, iges.',
  },
  {
    id: 'camera',
    title: 'Camera and controls values',
    kind: 'family',
    messages: [
      'Invalid projection',
      'Camera at target',
      'Vertical camera',
      'Invalid frustum',
      'Invalid fit',
      'Bounds exceed far: raise camera.far',
      'Invalid pivot',
      'Invalid orbit',
      'Invalid pan',
    ],
    cause:
      'The camera cannot build a view: `fov` outside 0-180, `near` not above 0 or `far` not above `near`, the position equal to the target, a view parallel to `camera.up`, or non-finite values. `fitToBoundingBox` needs min <= max, aspect > 0, duration >= 0 and padding >= 1, and a box that fits inside `far`. Controls need finite input and a camera off its target.',
    fix: 'Keep 0 < fov < 180 and 0 < near < far; move the position off the target; for straight-down views set `camera.up` (for example `[0, 0, -1]`) or use `CameraProjection` from `@margoengine/cameras`. Raise `camera.far` for large models.',
  },
  {
    id: 'transform',
    title: 'Transform values',
    kind: 'family',
    messages: [
      'Invalid transform',
      'Scale nonzero',
      'Quaternion nonzero',
      '<name>: <n> values',
      '<name>: finite values',
      'Invalid transform/bounds: <id>',
    ],
    cause:
      'A position, rotation, scale, quaternion or other vector had the wrong length, a value that is not a finite float32, a zero scale, or an all-zero quaternion. The kernel names the entity whose transform or bounds went non-finite.',
    fix: 'Pass arrays of the stated length with finite numbers; use nonzero scale factors and a nonzero quaternion. Look for divisions by zero or NaN upstream of the entity id the kernel reports.',
  },
  {
    id: 'hierarchy',
    title: 'Parents and meshes from another engine or scene',
    kind: 'family',
    messages: ['Foreign parent', 'Hierarchy cycle', 'Parent depth: 64', 'Foreign mesh'],
    cause:
      'A parent belongs to another engine or scene, would make the mesh its own ancestor, or nests deeper than 64 levels; or the stage was given a mesh of another engine.',
    fix: 'Parent meshes of the same engine and scene, pick a parent outside the mesh subtree, and keep hierarchies under 64 levels. Create meshes with the scene they belong to (`scene.createMesh()`).',
  },
  {
    id: 'scene',
    title: 'Scenes',
    kind: 'family',
    messages: ['Unknown scene: use engine.createScene()', 'Default scene: dispose the engine instead'],
    cause:
      'A scene from another engine, or one already disposed, was passed in; or `engine.scene` (the default scene) was disposed.',
    fix: 'Use scenes from this engine: `engine.createScene()`. The default scene lives as long as the engine: call `engine.dispose()`.',
  },
  {
    id: 'geometry',
    title: 'Geometry',
    kind: 'family',
    messages: ['Invalid geometry', 'Box size: positive', 'Sphere radius', 'Sphere segments: 3..256', 'No geometry'],
    cause:
      'Core geometry needs 3 to 1,000,000 vertices, a triangle index count that is a multiple of 3, indices inside the vertex range, and finite positions and normals. Boxes and spheres need positive sizes and 3-256 segments. Fitting needs at least one mesh with geometry.',
    fix: 'Split meshes over 1,000,000 vertices, check index ranges, and pass positive sizes. Give the model meshes with geometry before fitting.',
  },
  {
    id: 'material',
    title: 'Material values',
    kind: 'family',
    messages: ['Invalid material', 'Invalid Color'],
    cause:
      'A material colour, roughness or metalness was outside 0..1 or not finite, `doubleSided` was not a boolean, a colour was not `#rrggbb` or linear `[r, g, b]`, or the material data was changed directly to an invalid value.',
    fix: 'Pass `#rrggbb` or linear `[r, g, b]` in 0..1, roughness and metalness in 0..1, a boolean `doubleSided`, and change values with `material.set()`.',
  },
  {
    id: 'lighting',
    title: 'Lighting values',
    kind: 'family',
    messages: ['Invalid lighting'],
    cause: 'The light direction was zero, or an intensity, radiance or ambient value was negative.',
    fix: 'Use a nonzero light direction and non-negative intensities.',
  },
  {
    id: 'views',
    title: 'Views, rectangles and picking',
    kind: 'family',
    messages: [
      'Invalid views',
      'Invalid view: pass {camera, viewport}',
      'Invalid view target: use 1-sample colour',
      'Partial-view clear: draw extra attachments with clear: false',
      'Invalid draw rectangle',
      'Draw rectangle exceeds target',
      'Invalid pick',
    ],
    cause:
      '`render({views})` needs a non-empty array of `{camera, viewport}`. A view target needs 1-sample colour and a depth of the same size. A pass drawing a partial rectangle with extra colour attachments cannot clear them. Draw rectangles are 4 integers inside the target. `pick` needs finite CSS pixel coordinates.',
    fix: 'Pass `{camera, viewport}` objects; use 1-sample target textures; draw extra attachments with `clear: false`; keep rectangles inside the target; pass finite numbers to `pick`.',
  },
  {
    id: 'limits',
    title: 'Capacity and GPU limits',
    kind: 'family',
    messages: ['Capacity: 1..8388608', 'Capacity', 'Transform allocation', 'GPU buffer limit', 'Shader limit: 64'],
    cause:
      'The transform store capacity is outside 1..8,388,608, a grow did not raise it, the kernel could not allocate memory, a buffer is larger than the device allows, or more than 64 shader variants were requested.',
    fix: 'Lower `capacity`, split large geometry, and reuse materials and plugins so fewer shader variants are built.',
  },
  {
    id: 'arguments',
    title: 'Wrong argument types',
    kind: 'family',
    messages: [
      'Expected canvas',
      'Unknown backend',
      'Invalid camera',
      'Invalid geometry',
      'Invalid material',
      'Invalid plugin',
      'Invalid pass',
      'Invalid delta',
      'receiveShadow: boolean',
      'Visibility: boolean',
      'Box: 3 values',
      'fit: boolean',
      'Invalid stage options',
      'Expected element',
    ],
    cause:
      'An argument had the wrong type: not a canvas or element, an unknown backend, a camera, geometry or material not from core, a plugin without a unique name and `setup`, a pass without a unique name, finite order and `execute`, a frame delta outside 0..1 seconds, or a non-boolean flag.',
    fix: 'Pass core objects (`Camera`, `Geometry`, `PbrMaterial`), a backend of "auto", "webgpu" or "webgl2", plugins and passes with unique names, and booleans for flags.',
  },
];
