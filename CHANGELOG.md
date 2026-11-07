# Release notes

## Unreleased

### Networking

- `@margoengine/net/fields`: `FieldBuffer` interpolates scale, colour in linear light, looping animation time and any other named field alongside the pose.
- `@margoengine/net/delay`: `AdaptiveDelay` picks the render delay from measured jitter and loss, follows delay spikes, and runs the view's clock so it never jumps back.

### Physics

- `@margoengine/physics/next` gains `Physics`, `PhysicsBody` and `PhysicsCollider` on the own solver, with the root entry's names and no peer install. Free motion only for now: what needs contacts, joints or queries throws `unsupported`. `KernelWorld` gains `snapshot`, `restore`, `setPose`, `setTarget` and `setLocks`. A replay holds 10,000 steps bit-equal across Node, native code, Chromium and Firefox.
- `@margoengine/physics/next`, a preview of Margo's own solver: a Rust kernel in WebAssembly with its world and memory views, bodies that move under gravity, forces and impulses, `substeps` (default 4), and `addCollider` for balls, boxes and capsules, which work out a body's mass, centre and inertia, sweep and prune with `world.pairs()`, and islands that sleep. Rapier stays the default.
- Revolute and prismatic joints take `frameA` and `frameB` in place of `axis`, so limits count from the rest pose. `physics.solverIterations`, `body.additionalSolverIterations`, `body.appliedForce`, `body.appliedTorque` and `physics.contactPoints(body)` read what used to need the solver's own objects, and `@margoengine/ragdoll` now runs on the public Physics API alone: `Physics.load()` replaces passing `rapier`.
- `@margoengine/physics2d/outline`: `outlineColliders` and `traceOutlines` make colliders from a sprite's alpha, holes and hollows included.
- Bodies work on meshes at any depth of a hierarchy: parents are written before their children, so a body added before its parent no longer lags a frame, a nested glTF node is fitted at its world scale, and a geometry-free root below another mesh keeps its parts where they are. `{type: 'kinematicPosition', follow: true}` makes a mesh drive its body, for a moving part of a model that pushes what it meets. `physics.colliderCount` counts the world's colliders.
- `body.colliders`, events and query hits now hand you a `PhysicsCollider`: `shape` replaces `shapeType()`, `valid` replaces `isValid()`, and the setters and getters keep their names. New shapes `voxels` and `halfSpace`, and the options `massless` and `fixInternalEdges`, cover what `custom` was needed for. `PhysicsBody` gains `centerOfMass`, `principalInertia`, `inertiaFrame` and `setMassProperties`, and `PhysicsJoint` gains `anchorA` and `anchorB`. The voxel, glTF and interactivity packages use these and no longer reach the solver's own objects.
- `await Physics.load()` and `await Physics2D.load()` get the solver ready once per app, and `new Physics(engine)` then needs no options. The stage, React and `applyGLTFPhysics` load it by themselves, so their `rapier` options went, and the Rapier peer moved from `@margoengine/react` and `@margoengine/stage` to `@margoengine/physics` and `@margoengine/physics2d`, which keep it as an optional peer you install beside them. The `rapier` option of `Physics` still works.

### Short hex colours in core

- `PbrMaterial`, a scene's `clearColor` and a view's clear colour take CSS `#rgb` as well as `#rrggbb`: `'#555'` is `'#555555'`. They threw `Invalid Color` before. Alpha forms (`#rgba`, `#rrggbbaa`) are still refused, as core colours have no alpha.

### Frame counts

- `engine.stats` now reads the frame last drawn. After `engine.render({ camera })` with another camera, `visible` and `drawCalls` used to read the engine camera's view and lose what packages drew, so an app passing its own camera every frame read counts for a view it never showed. A pick no longer changes either count.

### Failed allocations

- `mesh.setGeometry()` that throws now changes nothing. A geometry over the GPU buffer limit used to leave a half-made batch: the retry returned without buffers and the next frame threw a `TypeError`. A failed growth destroyed the buffers of meshes already drawing, so they stopped too. Now the error reaches you, the mesh keeps drawing its old geometry and a retry works. While a batch grows it holds its old and new buffers for a moment.
- `Renderer.add` on a geometry it already holds now replaces its storage, new first, and a throw keeps the old one; `engine.retain` no longer calls `remove` first. Core's renderer and `@margoengine/webgl` do this, and a custom `fallback` renderer must too.
- `engine.retain` growing a batch no longer blanks the instances already drawn.
- Geometry set during a device restore reaches the right renderer: inside `onDeviceRestored` it used to get no buffers, or too small a buffer, and the next frame failed.
- One plugin throwing in `onDeviceRestored` no longer leaves the plugins after it on the lost device, and one throwing in `dispose` no longer stops `scene.dispose()`, which left the other plugins and the scene's meshes behind. The first error still reaches you.
- An invalid material now fails every frame until it is fixed. It failed once, then the next frame drew part of the batch with no error, and the meshes after it stayed missing even once the material was fixed.
- A failed `engine.rebootDevice()` on a healthy device no longer kills the canvas. It moved the canvas to the new device before rebuilding the geometry there, so when the rebuild failed the canvas stayed on a destroyed device and the next frame failed WebGPU's validation. The canvas now moves last.
- A restore that ends after `engine.dispose()` no longer unconfigures the canvas, which may belong to a new engine by then.
- `engine.createMesh()` failing to grow the store keeps the engine's slot tables, which a later frame could read and crash on.
- `LodInstances` and `DynamicInstances` release exactly what they took when `setup` fails.

### Model viewer

- A failed `addViewer` now leaves the stage unchanged. It framed the camera before the steps that can fail, so a failure cleaned up the model and left the camera on near, far, target and position set for a model that was gone, and ended any fit still animating. Framing is now the last step, and a failure while framing puts the camera back.
- `addViewer` imports all its packages alongside the model, so a missing package fails before anything is set up and the model never draws unframed.
- A part that throws while cleaning up no longer replaces the error `addViewer` rejects with, or stops the other parts going: it goes to `engine.onError`. `viewer.dispose()` removes every part, throws the first error and reports the rest.
- `addViewer` frames a model through a long lens. Below about a 1.3 degree `fov` it rejected with `Bounds exceed far: raise camera.far`, a value it had just set itself.

### Packaging

- A page that imports `margoengine/react` no longer gets the Draco and Basis Wasm in its build. Moved out of that entry: `Model` and `Gltf` (now `margoengine/react/gltf-pro`), `Fbx` (`/fbx`), `Animation` (`/animation`) and `BatchedMesh`, `BatchedItem`, `MeshTransmissionMaterial` (`/materials`).
- `npm run publish:rehearsal` proves a release without making one: it audits all 102 tarballs, then runs `npm install margoengine` and `npm create margo` in clean projects against a stand-in registry on 127.0.0.1 that refuses every write. `npm run publish:dry-run` and the publish workflow run it.
- `FloatingOrigin`, `OctreeCloud` and `TilesRenderer` now implement the `EnginePlugin` their `setup` takes, so their published types compile in an app with `skipLibCheck` off.
- The `create-margo` description no longer lists a `cad` template that does not exist.

### Apple GPUs

- glTF PBR materials without textures or effects draw in WebKit: it gives an invalid layout for an empty group past the last one a shader uses, so `@margoengine/gltf-pro` now binds one explicit empty group there.
- Reflection probes no longer lose texels: `LightProbes` wrote two neighbouring texels into one `vec4u` from different workgroups, and an Apple GPU kept only one of them, so about half the texel pairs of the rough levels held a black texel.
- The south pole of a `GeometryGenerator.sphere` is no longer a ring turned inside out: an accurate `sin` of f32 pi is a tiny negative.

### Light tier on displays that are no multiple of 60

- `capFrameRate` and `paceEngine` no longer fall below their rate: a 100 Hz display renders 100 FPS on the light tier, not 50, and 90 Hz renders 90, not 45. 60, 120, 144 and 240 Hz are unchanged.
- The light tier's GPU reading counts the time a frame's passes cover, so a GPU that runs passes side by side (Apple M6) reads what it spends: 8.8 ms, not 31.4 ms.

### voxel-net resumes a dropped connection (protocol 4, unreleased)

- **Breaking:** `PROTOCOL_VERSION` is 4. A server and its clients must be built from the same version; the server closes
  another one with 1008 and a reason naming both.
- A hello can ask for a player back and a welcome hands out a token. The server parks a dropped player for 30 s and takes
  it back on the same connection state; `connectVoxelNet` and `VoxelBot` resume on their own, because every proxied socket
  is cut at about 15 minutes.

### voxel-net app messages (protocol 3, unreleased)

- **Breaking:** `PROTOCOL_VERSION` is 3. A server and its clients must be built from the same version; the server closes
  another one with 1008 and a reason naming both.
- `VoxelServer.send(player, data)` and `broadcast(data)` carry a game's own bytes (at most `MAX_APP_BYTES`, 16,384) to
  one player or all as a new `app` message (kind byte 25), and `client.onApp(data)` receives them. The package never
  reads the payload. `send` returns `false` for a player who has left; hostile arguments throw `TypeError` or
  `RangeError`. `metrics.bytesOut.app` and `stats.received.app` count them. A client cannot send one.

### voxel-net notices a dead network, both ways (protocol 2, unreleased)

- `connectVoxelNet` gives up on a server that sent nothing for the new `serverTimeout` (default 15,000 ms; 0 never does):
  `onError` gets a MargoError `'failed'`, then `onClose` gets the new `SERVER_SILENT_CODE` (4408), reason
  `'server-silent'`, `byClient: false`. Before, a dead route left a frozen world until the socket closed, if ever.
- `VoxelServer` closes a client that sent no byte for the new `clientTimeout` (default 20,000 ms) with 1008
  `'client-silent'` and frees its slot, counts and chunks. Before, a lone dead client held them for ever. A new
  `heartbeatInterval` option (default 5,000 ms) paces a new `heartbeat` message, sent only to a client with no other
  traffic, and a WebSocket ping, sent only to a client that sent nothing. Hidden tabs answer pings and stay.
- `WebSocketConnection.close` cuts off a peer that has not finished closing after 2 s, and `WebSocketConnection.ping()`
  is new. Before, `VoxelServer.close()` never resolved while a client had stopped reading.

### voxel-net names and snapshots (protocol 2)

- **Breaking:** `PROTOCOL_VERSION` is 2. Server and clients must be built from the same version; a client on another one
  is closed with 1008 and a reason naming both. `connectVoxelNet` now passes any close but 1000 and 1001 to `onError`
  as a MargoError `'failed'` with the code and reason; before, a refused page heard nothing.
- `client.onClose({ code, reason, byClient })`: `connectVoxelNet` calls it once when the connection has ended, a clean
  server shutdown (1001, no `onError`) included, so a page can rejoin without a socket of its own.
- `RemotePlayer.name`: other players' display names, from a new `names` message. The server cleans every name with the
  new `cleanPlayerName` (controls, bidi overrides, zero widths, blank letters, angle brackets, stacked marks) and the
  new `filterName` option applies your own rule. `player.name` and `authenticate` now see the cleaned name.
- `VoxelServer.exportEdits()` and `importEdits(map)` read and replace the edited chunks, for snapshots and rollback;
  `VoxelEditStore` gains an optional `delete(key)`, which `importEdits` needs to put a stored chunk back to the generator's.

### netcode room limits

- `new RoomServer(options)`: `joinTimeout` (10,000 ms, then `CloseCode.timeout`), `maxConnections` (1,024 joined or
  joining, then `CloseCode.full`), `maxRooms` (256: `create` rejects with MargoError `'failed'`, a client's `create` or
  `joinOrCreate` is refused) and `limits.messagesPerSecond` / `limits.burst` (120 and 60, a token bucket per client,
  then `CloseCode.rateLimit`; a room may set `maxMessagesPerSecond` and `messageBurst`). Options out of range throw
  RangeError; `rooms.connections` counts open connections. `new RoomServer()` keeps working with these defaults.
- A timed patch or `setSimulationInterval` step that throws no longer throws uncaught: it goes to
  `RoomServer.onerror(error, room)` and stops that room. A client that leaves while `onAuth` runs is no longer seated
  as a ghost, and an aborted join rejects with the abort reason.

### netcode raw WebSocket listener (breaking default)

- **Breaking:** `listenWebSocket` (and `serve`, which uses it) from `@margoengine/netcode/node` now defaults `origins` to
  the server's own host, like `RoomServer`'s neighbours `VoxelServer` and `acceptWebSocket`: a browser page must come
  from `http://` or `https://` plus the request's `Host`. Pages on another origin get HTTP 403; pass
  `origins: ['https://your.page']`, or `origins: '*'` for the old behaviour (any page). Clients that send no Origin (Node,
  bots) still connect unless a list is given, as before.
- New `maxConnections` (1,024; the next upgrade is answered with HTTP 503 before a connection exists) and
  `firstMessageTimeout` (10,000 ms; a connection with no message by then is closed with `CloseCode.timeout`). Options out
  of range throw RangeError, and an `origins` that is not `'*'` or a list of strings throws TypeError.

### voxel-net server limits (breaking default)

- **Breaking:** `VoxelServer` `origins` (and `acceptWebSocket`) now default to the server's own host: a browser page
  must come from `http://` or `https://` plus the request's `Host`. Pages on another origin get HTTP 403 with a message
  naming the option; pass `origins: ['https://your.page']`, or `origins: '*'` for the old behaviour. Clients that send
  no Origin (Node, bots) still connect. The sandbox's `server.mjs` allows its dev server and takes `--origins`.
- `maxPending` (64) and `maxPerAddress` (8) cap connections that have not joined, checked before the 101 answer (HTTP
  503 and 429); `helloTimeout` is now 3,000 ms (was 10 s).
- `authenticate(req, hello)` checks the upgrade request and the hello; a string becomes `player.identity`;
  `authTimeout` (5,000 ms) bounds each call.
- `maxEditedChunks` (65,536) bounds edited chunks in memory; past it the least recently edited ones go to a
  `VoxelEditStore` (`save`, `load`), which `close()` also fills. `connectWebSocket` takes `headers`, and a refused
  upgrade's error now holds the server's reason.

### Added

- `@margoengine/shader/editor`: `NodeEditor`, a visual node editor for the portable surface graph (palette, wires, typed
  constants, undo and redo, live validation with the node to fix, WGSL view, keyboard and screen-reader friendly), and the
  DOM-free `GraphModel` behind it. `editor.onGraph` reports each new valid graph for hot reload.

- `@margoengine/vfx`: soft particles. `softness` (world units, default 0 = off) fades a particle over that distance in
  front of any opaque surface behind it, so it no longer shows a hard line where it meets the floor or a wall; `depth: () =>
  depthTexture.texture` supplies the scene depth (`DepthTexture` from `@margoengine/post/depth`, 1 sample or the scene's
  sample count). New optional entry `@margoengine/vfx/soft` (`{soft}` on `/base`; the root `VFX` has it). Effects with
  `softness` off compile the same WGSL and make the same GPU calls as before.

- `@margoengine/vfx`: two optional features. `curves: {size, alpha, color}` (`@margoengine/vfx/curves`) shapes each
  particle's size, opacity and colour over its life; `emitter` (`@margoengine/vfx/emitter`) starts births on a sphere
  (volume or shell), a cone or the area-weighted surface of a triangle mesh and pushes them along the shape's direction
  with `speed`. Both are on the root `VFX`; `VFX` from `/base` takes them as `{curves}`, `{emitter}`. Effects that set
  neither compile the same WGSL and make the same GPU calls as before. `GPUParticles` in `@margoengine/creative` now
  extends `VFX` from `@margoengine/vfx/base` with the obstacles, wrap, sort and texture features (it no longer loads
  the larger root; `instanceof` the root `VFX` is false).

### Error messages and classes (developer-experience pass, packages animation to lod)

Every throw message now names its fix after a `; ` clause, so match on `error.code` or the error class, not on the
whole message text. Changed classes (all still extend `Error`):

- `@margoengine/animation`: `Animation.play` on a disposed animation throws `MargoError` code `disposed`;
  `Animation.setup` with a disposed model or another engine throws code `attached`, without WebGPU code `unsupported`;
  `VATCrowd.addLighting` with an effect from another engine throws code `attached`; duplicate animation targets, more
  than eight joint influences and singular skinned or VAT root transforms are `RangeError`.
- `@margoengine/animator`: `addFootIK` on a chain that is not a direct hip, knee, ankle chain is `TypeError`; foot IK
  with non-uniform or non-positive scales is `RangeError`; a rotation writer re-entering an update, and attaching an
  Animator before its Animation, throw `MargoError` code `state`. `Unknown animator clip "X"` quotes the name.
- `@margoengine/audio`: `play()` with no source throws `MargoError` code `state`; use after `dispose()` code
  `disposed`; missing Web Audio or `fetch` code `unsupported`; an HTTP or decode failure code `failed`.
- `@margoengine/blender`, `@margoengine/bvh`: classes unchanged, messages end with a fix clause.
- `@margoengine/cameras`: `FloatingOrigin` methods used before `engine.use(origin)` throw `MargoError` code `state`.
- `@margoengine/controls`: `connect()` on disposed controls (and `TransformControls`) throws `MargoError` code `disposed`; a
  failed gizmo shader compile or link throws `MargoError` code `unsupported`, with the GL log and the advice to use a
  WebGL2 context.
- `@margoengine/cinematic`, `clustered`, `creative`, `culling`, `dof`, `ecs`: classes unchanged, messages end with a
  fix clause.

### Open source release

- Every published package is now under the Apache License 2.0.
- Every package.json has repository, homepage, bugs, keywords, license and author fields.
- Added CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue and pull request templates, `.editorconfig`,
  `examples/README.md` and `docs/api-overview.md`.
- CI runs lint, typecheck, the package build, the API report check, quality checks, the full test suite and the
  kernel tests on every push and pull request.

Verified on 16 October 2026. These changes are available in source; this entry
does not announce an npm publication or a package version change.

### Public API migrations retained during consolidation

The optional-package hygiene changes remain in place. Shared shapes and error
codes follow [the package conventions](docs/conventions.md); update imports as
follows when moving an earlier checkout to the consolidated tree:

| Earlier API | Current API |
| --- | --- |
| Geometry `Vec2` / `Vec3` | `MutableVec2` / `MutableVec3` from `@margoengine/math` (same tuple shapes) |
| Navigation `Vector3` | `Vec3Like` from `@margoengine/math` (same object shape) |
| Lines `ExpandOptions` | `ExpandLineOptions` |
| Points `projectPoint`, `PickHit`, `Blending`, `TextureSource` | `projectToPixels`, `PointsPickHit`, `PointsBlending`, `PointsTextureSource` |
| Procedural `SurfaceOptions` | `MarchingCubesOptions` |
| Tween `smoothstep` | `easeSmoothstep` |
| Shader `Input`, `Stage`, `TextureSource` | `NodeInput`, `ShaderStage`, `BindableTexture` |
| VFX `texture` feature (`@margoengine/vfx/texture`) | `textureFeature`; pass it as `new VFX(options, { texture: textureFeature })` |
| LOD `Vec3` | `MutableVec3` for results (`octDecode`, `frameDirection`, `frameBasis`, `Imposter.center`) and `Vec3` for inputs, from `@margoengine/math` |
| Sky and terrain colour type `Color` | `Vec3` from `@margoengine/math` (same tuple shape) |
| Terrain `HeightField` | `HeightField` from `@margoengine/math`, re-exported by terrain (same shape) |

Math is the shared home for vector, quaternion, matrix, color and geometric
shape types. Core's `Vec3` remains available and is re-exported by math. Lines,
points and text continue to re-export their color and mesh-world helpers from
math. Optional packages use `MargoError` with a stable `code`; core and stage
retain their frozen error contract. Shader operations carry typed result nodes
instead of public `Node<any>` results.

The lighting, post and environment packages (environment, post, creative,
clustered, tonemap, shadows, taa, sky, water, terrain, dof, oit, toon,
transitions, splats, vfx, scatter, lod, webgl, culling) now follow the same
conventions: every former bare `Error` is a `MargoError` with a `code`, or a
`TypeError` / `RangeError` for malformed input, and keeps its old text as the
start of the message. Environment's EXR, inflate and UltraHDR decoders throw
`MargoError` `'failed'` for damaged files and `'unsupported'` for features
they do not decode, as its HDR decoder already did. A lost WebGL context now
reports `MargoError: WebGL context lost; create a new engine`. Private
pass-context aliases visible in the published types are named per package
(`PostPassContext`, `ShadowPassContext`, `SkyPassContext`,
`TerrainPassContext`, `ScatterPassContext`); vfx's `Owned` is
`OwnedResources`. Environment, sky, water, terrain, oit, toon, transitions,
vfx, scatter, lod, webgl and culling list `@margoengine/math` under
`dependencies`; dof and tonemap list it under `devDependencies`, as post,
clustered, shadows, taa, splats and creative already did.

The scenery `sky-moon` implementation was deliberately replaced by the
`SkyMoon` preset over `@margoengine/sky`. Keep that single implementation rather
than restoring `SkyMoonPass`. The consolidation record
lists all 74 public packages, preserved optional entries and audit decisions.

### Errors name their fix (packages materials to xr)

Every thrown message in these packages now says what to do about the problem. A former bare `Error` is now a
`MargoError` with a `code` (`disposed`, `attached`, `state`, `unsupported`, `failed`) or a `TypeError` / `RangeError`.
Message text changed: branch on `error.code` or the class, not the text. Changed error types:

- materials: bare `Error` became `MargoError` (`state`, `disposed`, `attached`); a node-graph cycle and a graph
  without exactly one emit are now `TypeError`.
- physics: bare `Error` became `MargoError` (`disposed`, `attached`, `state`).
- react: bare `Error` became `MargoError` (`state`, `disposed`, `attached`, `unsupported`).
- quality: `warmUp` accepts a `signal` (AbortSignal) and rejects with its reason.
- selection: bare `Error` became `MargoError` (`disposed`, `attached`, `state`, `unsupported`); `pick` on a Picking that is not attached is `state` (it said the Picking was disposed).
- stats, video: bare `Error` became `MargoError` (`disposed`, `attached`, `unsupported`, `failed`); both now list `@margoengine/math` under dependencies.
- usdz: malformed USD files throw `LoaderError` (format `USD`, code `syntax`, `unsupported` or `limit`) instead of a bare `Error`; the message text is unchanged.

### USDZ dependency cleanup

- `@margoengine/usdz` reads USDA and USDC with its own parsers (`src/crate.ts` and
  the shared `readUSDA`). The unused vendored Three.js parsers and their
  `THIRD-PARTY-NOTICES.txt` were removed on 2026-10-21; the package ships only `dist`.
- Removed `three` and `@types/three` from the root development dependencies and
  lockfile. Benchmark and visual-parity tooling uses a separately cached,
  integrity-checked Three.js 0.186.1 reference.
- USDA and USDC parsing remains synchronous; USDZ archive parsing and model
  creation remain asynchronous. Existing USDA/USDC fixture output is unchanged.
  USDZ remains an ancillary format outside the six core launch packages; no new
  package was introduced.

### Compressed glTF in glTF Pro

- `@margoengine/gltf-pro` uses its `@margoengine/decoders` dependency to load
  `KHR_draco_mesh_compression` primitives and `EXT_meshopt_compression` buffer
  views from glTF and GLB. Unknown required extensions still reject.
- `parseGLTF(engine, input, buffers, images)` keeps its synchronous return value
  for uncompressed and Meshopt input. Meshopt uses the TypeScript decoder at the
  buffer-view boundary, caches decoded bytes and needs no workers or Wasm.
- `parseGLTFAsync(engine, input, buffers, images, options)` supports compressed
  in-memory input. `loadGLTF(engine, url, options)` handles compressed downloads
  automatically. Both accept `{signal, draco}`; caller-supplied decoders remain
  caller-owned. Default Draco workers and bundled Wasm start lazily and temporary
  workers are released on success, failure and cancellation.
- Draco extraction honors accessor component types so integer UVs and colors
  normalize once. Triangle extraction promotes to Uint32 at 65,536 vertices.
  Decoded counts, attribute widths, index ranges and output-byte budgets are
  checked before GPU construction; output preflight does not cap Draco's
  internal Wasm geometry allocations.
- The basic `@margoengine/gltf` subset is unchanged. `gltf-pro` also loads
  `KHR_texture_basisu` textures lazily, uploads complete GPU-ready mip chains,
  and releases loader-owned transcoder workers.

### Optional material and asset extensions

- `@margoengine/materials` adds clearcoat, transmission, IOR, volume and a closed
  TypeScript node graph through the isolated group 3 material slot. It now also
  supports sheen, specular color, anisotropy and iridescence through caller
  factories or explicit installation of optional Khronos material metadata.
  Color textures decode sRGB; data textures remain linear. The new lobes affect
  directional and fixed hemisphere lighting; clustered and environment lighting
  retain the base PBR response.
- Zero sheen, anisotropy and iridescence and neutral specular preserve baseline
  pixels exactly. Specular factor zero removes dielectric reflection, as glTF
  requires. Core, stage and the baseline PBR shader remain unchanged.
- `KHR_texture_transform` and UV1 use the existing vertex layout and optional
  group 3 factors. Standard UV0 primitives retain their original bindings.
  `@margoengine/animation` supports four or eight normalized joint influences,
  with separate kernels and unchanged single-clip allocation behavior.
- The React package adds its declarative `Stage` wrapper and lowercase element
  aliases. The FBX suite includes a reproducible CC0 Blender rig and required
  real-file skinning, playback, seek and restoration checks.

### Local-light shadows

- `@margoengine/clustered` adds opt-in point and spot shadow maps with explicit
  caster registration, alpha-mask/UV1 transforms, per-light bias settings and
  device restoration. Core, PBR and terrain receive the shadows; directional
  cascades and frozen core/stage sources remain unchanged. The GPU checks cover
  45 captures, all six point faces, TAA and directional composition, and release
  all 288 tracked GPU resources. Unshadowed shaders and bindings remain exact.

### React scene ergonomics

- Canvas-level pointer events use the engine's existing picking path, serialize
  GPU readbacks, and coalesce hover updates. Clicks distinguish dragging; the
  WebGL fallback skips unsupported picking.
- Suspense, a canvas-owned source cache and `preload()` retain independent model
  instances and abort unused pending loads. Hooks expose camera, size, engine,
  clock and invalidation; `Group`/`group`, demand rendering and optional `Html`
  stay in `@margoengine/react`. All 45 React lifecycle tests pass on Node 24.

### Optional React scene components

- `@margoengine/react/kit`, `/post`, `/physics` and `/xr` expose native scene
  helpers, FBX loading, effects, Rapier bodies and XR controllers through lazy
  optional peers. Loaded-model colliders support bounds fallbacks and explicit
  cuboid/ball children with live transform updates. Conflicting post-effect
  capture owners report an error. React 18 packed consumers pass 118 behavioral
  tests; the React 19 workspace suite passes 123 tests.

### Loaded PBR geometry consumers

- A canonical weak registry now feeds inspector overlays, line helpers, static
  raycasts, automatic picking/selection, direct mesh shadow casters,
  TAA and native XR. Multiple primitives retain their identities even when they
  share GPU buffers. Disposal, hidden ancestors and reused mesh slots are guarded.
- Native XR owns PBR resources and skin/morph kernels on its compatible device,
  with separate eye uniforms and live animation/extension replacement handling.
  Static TAA storage is allocated only when used; standard PBR buffer flags stay
  unchanged. Current COPY_SRC deformation is copied from the GPU.
- Four original stage-facade audits remain executable TODOs: mixed `Stage.fit`
  and its internal raw adapter still read core geometry only. Supported model
  bounds/raw and explicit camera-fitting alternatives have passing regressions.
  Core and stage stay frozen; these four limitations are not reported as fixed.
- Physics and glTF export read loader-owned bind-pose primitives
  through an optional CPU geometry bridge. Loaded glTF/FBX meshes retain their
  original core geometry slots and hierarchy. Unsupported export data and
  operations without usable triangles report explicit errors. Ten real-loader
  regressions and twelve WebGPU audit checks pass.

### Attached PBR model colliders

- `physics.addBody(model.root)` now gathers static descendants of a geometry-free
  root into one fitted box. Authored hierarchy, offsets, rotations and scales
  remain intact; Rapier's rigid frame retains root scale exactly once.
- Skinned or morphed geometry-derived colliders reject with
  `Skinned mesh needs an explicit collider`. Explicit capsules/dimensions and
  direct-node fitting retain their existing behavior. Failed fits leave no body.
- Eleven standalone built-entry Box regressions and five real-Rapier cases cover
  attached roots, transformed hierarchies, export, BVH/helpers and cleanup.
  The native GPU gate also loads complete Draco Avocado with all three original
  textures, verifies the exact synchronous diagnostic, and releases its worker.

### Optional mixed scene helpers

- `@margoengine/gltf-pro/scene` exposes `getSceneBounds`, `fitScene`, and
  `gatherSceneBuffers` for selected core/PBR mesh roots and their descendants.
  Mixed bounds use actual CPU vertices under current world transforms; camera
  fitting includes offscreen geometry and filters hidden ancestors by default.
- GPU records borrow existing core/PBR buffers with explicit 24/80-byte strides,
  world matrices, index counts and primitive metadata. Overlapping selections
  do not duplicate nodes; shared buffers retain distinct node/primitive records.
  Fresh queries follow animation and device restoration without uploading or
  owning geometry. WebGL2 bounds/fitting work; GPU gathering returns `null`.
- Both real Box and FBX assets have helper regressions. The four original
  frozen-facade TODOs remain unchanged: callers opt into the new entry instead
  of replacing `Stage.fit` or its internal raw adapter.

### Picking on skinned and morphed meshes

- Registered PBR models support current-pose GPU picking and selection outlines
  through `@margoengine/selection`; the existing core hook serves `engine.pick`.
  Four/eight-influence skinning, morphs, alpha/UV1 transforms, mip filtering,
  shared depth and both outline algorithms pass hardware and SwiftShader checks.
  `Raycaster.intersectModel()` snapshots the same GPU output for CPU triangle
  queries, with BVH refitting and coherent world transforms. Pending reads,
  replacement, disposal and restoration invalidate stale results and release
  staging resources. Core and stage are unchanged; baseline PBR layouts and pixels
  are preserved. The shader's generated names now describe their contents.

### Verification and footprint

- The workspace build passes. The full Node 24 suite passes **1,318 tests**, with
  zero failures or skips and **four known frozen-stage TODO audits** that retain
  their original failing assertions. Strict TypeScript checks and packed exports/imports
  pass across **all 63 packages**, including strict Bundler and NodeNext consumers.
- Regression coverage includes real normalized Draco UV/color data, index
  extraction at 65,535 / 65,536 / 65,537 vertices, Meshopt fallback buffers,
  interleaving, offsets, all supported modes/filters and malformed layouts.
- The production Vite/WebGPU browser check passes for Meshopt and Draco glTF/GLB.
  Meshopt and uncompressed synchronous parsing produce the expected geometry
  without decoder workers or Wasm requests. Draco worker assets resolve,
  temporary workers terminate, and tested model disposal leaves no meshes or
  WebGPU validation errors.
- The combined extension browser suite also passes 42 node-material, 59 new-lobe
  and 82 texture-coordinate captures, complete Khronos material/KTX2/UV1 assets,
  and independent eight-influence GPU deformation readback. New-lobe assets
  restore bit for bit and release every tracked GPU resource and decoder worker.
- The silent-geometry browser suite passes 36 captures on hardware and
  SwiftShader, compiles 67 shader modules, and destroys all 337 tracked resources.
  Inspector overlays survive frustum edges; native-device PBR eye kernels match
  the desktop FBX pose bit for bit. No GPU or page errors are reported.
- The attached-root Box and complete Avocado browser gate passes on RTX A6000
  and SwiftShader: six captures, five shaders, all 35 tracked GPU resources
  released, one decoder worker terminated, and no GPU/page errors. Attaching
  physics preserves Box pixels bit for bit; local export and world geometry
  survive reimport.
- Mixed scene helpers pass on RTX A6000 and SwiftShader with both real Box/FBX
  assets and core geometry. Each adapter checks six captures and eight shaders,
  releases all 64 tracked GPU resources across device restoration, and reports
  zero GPU/page errors. Helper queries perform no GPU work; query and restoration
  frames preserve pixels exactly. Fifteen new Node regressions also pass.
- `npm run measure:size` reports **50,207 bytes raw / 21,107 bytes gzip** for
  core + stage, including embedded Wasm and both backends. Core and stage remain
  feature-frozen. CI rejects **25,000 gzip bytes or above** and checks package
  isolation; optional parser/decoder features add no base-bundle code.
- CI runs `npm run typecheck` after package builds and retains the production
  compression browser report as a build artifact.

Repeat the checks from a built checkout with `npm run typecheck`,
`npm run test:modules:packages`, `npm run modern:test:usdz`,
`npm run modern:test:gltf-compression`, `npm run modern:test:extensions` and
`npm run measure:size`.
`npm run test:all` rebuilds the workspace and runs the full suite; use Node 24
to match CI. See the [USDZ](packages/usdz/README.md),
[glTF Pro](packages/gltf-pro/README.md) and [decoder](packages/decoders/README.md)
guides for API details and supported subsets.
