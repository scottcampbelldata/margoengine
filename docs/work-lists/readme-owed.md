# README work owed

Scott (2026-11-09): README examples and `check:readme-run` wait until the features are built. Each job that changes a package adds one line here. The README phase before release clears this list; it must be empty at release.

| Package | What its README must cover | Added by |
|---|---|---|
| @margoengine/lightmap | directional: bakeDirectionalLightmap and directionalIrradiance (direction and directional maps, evaluating with a mapped normal) | batch 54 job 6 |
| `@margoengine/webgl2-compat` | Compute binding limits across automatic/explicit layouts, validation scopes, async `GPUPipelineError` and recovery example. | Batch 273 failure 18 |
| @margoengine/fsm | events: EventMachine send/plan data, EventState/Transition hooks and guards, EventTrace capacity and disposal; payloads are references | batch-250 job 1 |
| margoengine | Generated fsm/events alias and payload entry availability | batch-250 job 1 |
| @margoengine/fsm | final: FinalMachine, final leaf constraints, done.state.parent, always guards, macrostep bound, stopped top-level final and goto restart | batch-250 job 2 |
| @margoengine/netcode | lobby: LobbyRoom metadata/privacy, RoomLobby filters, reservation lifetime/cancel, one-time joinById seatToken and server-held join identity; correct stale limits | batch-256 job 1 |
| margoengine | Generated netcode/lobby alias | batch-256 job 1 |
| margoengine | Generated fsm/final alias | batch-250 job 2 |
| @margoengine/tiles | tiles/style expressions, conditions/defines, renderer decorator and model/instance/point binding lifecycle | batch 239 job 1 |
| margoengine | tiles/style generated optional re-export | batch 239 job 1 |
| @margoengine/fsm | invoke: InvokeMachine, one/many task ids, run(context,signal,data), done.invoke.id/output, error.invoke.id/error, invocations/settled, AbortSignal and using; FinalMachine stable extension receives entering data | batch-250 job 3 |
| margoengine | Generated fsm/invoke alias | batch-250 job 3 |



| @margoengine/webgl2-compat | Canvas output persistence when reconfiguring between page-backed XR and offscreen devices; supported XR preparation. | Batch 273 XR group |
| @margoengine/behavior | subtrees: explicit registries, reference-aware validateTree, resolveTree and SubtreeTree with occurrence-local state and limits | batch-251 job 1 |
| margoengine | Generated behavior/subtrees alias | batch-251 job 1 |

| @margoengine/navmesh | queries: raycast wall edge/normal, local moveAlongSurface, filters, tiled lifetime and height projection | batch-252 job 1 |
| margoengine | Generated navmesh/queries alias | batch-252 job 1 |


| @margoengine/sciviz | Review climate/solver file examples and limits for netcdf/vtk in the README phase; existing examples and 57 runtime checks were completed before deferral. | Batch 171 job 5 |
| @margoengine/loaders | Review the lazy VTK XML dataset API example in the README phase; the existing example was validated before deferral. | Batch 171 job 5 |
| margoengine | Cover the sciviz/netcdf and sciviz/vtk aliases in the README phase. | Batch 171 job 5 |
| @margoengine/behavior | inspect: mount TreeInspector, trace:true, automatic/manual refresh, pause/resume, abort and disposal, idle vs last tick | batch-251 job 2 |
| margoengine | Generated behavior/inspect alias | batch-251 job 2 |



| @margoengine/ui | Optional input: TextInput/TextArea/password, native bridge, selection, clipboard, IME, accessibility, defaults and disposal. | batch-258 job 1 |
| margoengine | ui/input umbrella entry and native-editing attachment. | batch-258 job 1 |
| @margoengine/fsm | inspect: MachineView mounting in Inspector shadow root or parent, existing trace ownership, refresh/live/capacity, filtering, AbortSignal and disposal | batch-250 job 4 |
| margoengine | Generated fsm/inspect alias | batch-250 job 4 |

| @margoengine/save | opfs: namespace/directory defaults, binary and empty saves, atomic close, cancellation boundary, key limit and cross-tab last-close-wins | batch-255 job 3 |
| margoengine | Generated save/opfs alias | batch-255 job 3 |
- @margoengine/controls: document /collide OrbitControls and MapControls, explicit blockers, five-ray sampling, clearance, restoration, filters and disposal.
- margoengine: document the generated /controls/collide alias.


| @margoengine/navmesh | queries partial route/path, nearest endpoint metric, optional Crowd surface, agent.partial and partial-arrival replanning | batch-252 job 2 |
| @margoengine/netcode | presence: RoomNode run/close, remote routed reservations, lease defaults, PresenceStore adapter contract, same-host SQLite and network-store integration | batch-256 job 2 |
| margoengine | Generated netcode/presence alias | batch-256 job 2 |

| @margoengine/sciviz | Review derived-field CPU/GPU examples and stated numerical bounds in the README phase. | Batch 171 job 4 |
| margoengine | Cover the sciviz/derive alias in the README phase. | Batch 171 job 4 |
| @margoengine/sprites | SliceLayer/addSlice: fixed borders, stretch/repeat, scrolling, partial tiles, resize, transforms and pages; SpriteInput dx/dy gradients before masking | batch-245 job 1 |
| margoengine | Document the sprites/slice alias and its optional imports | batch-245 job 1 |


| @margoengine/save | signed: signedStorage with raw/CryptoKey keys, safe recovery/check, injected WebCrypto, secret ownership, no unsigned legacy, replay/confidentiality limits | batch-255 job 4 |
| margoengine | Generated save/signed alias | batch-255 job 4 |
- @margoengine/controls: document /box-gizmo attach, handles, uniform/per-axis corner scaling, pivots, edge rotation, snapping, cancellation, bounds refresh and cleanup.
- margoengine: document the generated /controls/box-gizmo alias.

| @margoengine/navmesh | queries seeded randomPoint, strict randomPointAroundCircle, rejection bound, distanceToWall and partial seam intervals | batch-252 job 3 |
| @margoengine/behavior | fuzzy: JSON shapes/rules, finite domains, hedges, weighted consequences, pure FuzzySystem evaluation, centroid/mean-of-max/max-average sampling and fallback | batch-251 job 3 |
| margoengine | Generated behavior/fuzzy alias | batch-251 job 3 |
| @margoengine/fsm | scxml: importSCXML/exportSCXML, browser DOMParser and explicit Node parser, supported subset, named bindings, namespace extensions, limits and extensions:false rejection | batch-250 job 5 |
| margoengine | Generated fsm/scxml alias | batch-250 job 5 |
| @margoengine/netcode | generate-rust: schema.json input, Msg types and f_ fields, enum indices, boxed optionals, full/delta methods, errors, native Rust toolchain and nesting limit | batch-256 job 3 |
| margoengine | Generated netcode/generate-rust alias | batch-256 job 3 |
| @margoengine/behavior | text: parseTreeText/printTreeText syntax, utilities, JSON attributes, comments, external subtree registry, diagnostics and bounds | batch-251 job 4 |
| margoengine | Generated behavior/text alias | batch-251 job 4 |
| @margoengine/sprites | skeletal IK controls, bone lengths, slot attachments, addSkeleton, draw-order/attachment keys and Bezier curves | batch-245 job 2 |

| @margoengine/navmesh | wasm worker builders, returned work counts, separate asset hosting, abort/deadline, SIMD requirement and tiled runtime rebuild behavior | batch-252 job 4 |
| margoengine | Generated navmesh/wasm alias | batch-252 job 4 |
- @margoengine/controls: document /presentation product picking, springs, bounded rotation, snap-back/polar zoom, ScrollArea ownership, native/wheel/infinite scroll, helpers, Spline paths, mesh/camera targets, focus and cleanup; note the optional tween peer.
- margoengine: document /controls/presentation alias.
| @margoengine/behavior | triggers: sphere/box contact semantics, TriggerSystem update events, shared-board per-agent keys, namespaces, mutation/deletion/disable and disposal | batch-251 job 5 |
| margoengine | Generated behavior/triggers alias | batch-251 job 5 |

- @margoengine/tween: awaitable AsyncTween tasks and AsyncTimeline, AbortSignal cancellation, replay and caller-owned clocks (batch 215 job 1).
- margoengine: optional tween/async re-export and the same await/cancel lifecycle (batch 215 job 1).
- @margoengine/tween: props to/from/fromTo, relative arithmetic, Vector3, keyframe values/offsets, immediate starts, pause/speed and AbortSignal (batch 215 job 2).
- margoengine: tween/props alias (batch 215 job 2).
- @margoengine/tween: optional Timeline mixed clips, nesting/local speed, labels, replay promises, seek vs playback callbacks and cancellation (batch 215 job 3).
- margoengine: tween/timeline alias (batch 215 job 3).
- @margoengine/tween: TweenControl world, key vs target overwrite, partial cancellation promises, pause and global/local speed (batch 215 job 4).
- margoengine: tween/control alias (batch 215 job 4).
- @margoengine/tween: pinTimeline, window/element sections, full/root label maps, snap modes, input cancellation, responsive refresh and disposal (batch 215 job 5).
- margoengine: tween/scroll-pin alias (batch 215 job 5).
- @margoengine/tween: VelocityTracker release timestamps, inertia friction, endpoint/list/function selection, hard vs bouncy ranges, rest thresholds, caller clock and cancellation (batch 215 job 6).
- margoengine: tween/inertia alias (batch 215 job 6).
| @margoengine/input | vector: VectorInput, wasd, radial processing, generated scalar channels, contexts, rebinding and replay | batch-253 job 1 |
| margoengine | Generated input/vector alias | batch-253 job 1 |
| @margoengine/inspector | Standalone tweak bindings, folders, colours, vectors, enums, buttons and gesture undo. | Batch 262 job 1 |
| margoengine | Optional inspector/tweak import and shared history usage. | Batch 262 job 1 |

| @margoengine/navmesh | obstacles ObstacleNavMesh, cylinder/rotated-box shapes, world dimensions, grouped handles, moves, deferred rebuilds and baked cell-run semantics | batch-252 job 5 |
| margoengine | Generated navmesh/obstacles alias | batch-252 job 5 |
| @margoengine/netcode | migrate: HostMigration full mesh, confirm and confirmed semantics, waitForHost, handoff, epochs, owned links, cancellation/deadlines, checkpoint/peer limits and partition constraints | batch-256 job 4 |
| margoengine | Generated netcode/migrate alias | batch-256 job 4 |
| @margoengine/input | xr: descriptors/map/binding, attach/update order, source filters, select/grip/poses, pinch distances, recording and lifecycle | batch-253 job 2 |
| margoengine | Generated input/xr alias | batch-253 job 2 |
| @margoengine/inspector | Selection gizmos, camera arbitration, toolbar and whole-drag undo. | Batch 262 job 2 |
| margoengine | Optional inspector/gizmo import. | Batch 262 job 2 |



- @margoengine/audio/pan: StereoAudio pan -1..1, native AudioParam automation, non-positional mono/stereo input and disposal.

- @margoengine/controls: document /device-orientation, user-gesture permission, secure context, AbortSignal/timeout, relative alignment, screen compensation, yaw offset, recenter, smoothing and disposal.
- margoengine: document /controls/device-orientation alias.

| @margoengine/sciviz | Document atmosphere globe creation, UTC solar time, metre heights, wind units, scalar/point/cloud layers, disposal and model limits. | Batch 171 job 6 |
| @margoengine/sky | Document the planet entry frame, Hillaire transport bindings, physical limits and disposal. | Batch 171 job 6 |
| margoengine | Document the sciviz/atmosphere and sky/planet aliases. | Batch 171 job 6 |



| @margoengine/ui | ui/image: ImageTexture loading and snapshots, Image fit/source/slice/tint options, atlas residency and disposal by ownership. | batch-258 job 2 |
| margoengine | ui/image umbrella alias and image widget setup. | batch-258 job 2 |

| @margoengine/react | Review UI image usage from the React canvas during the README phase; no public React API change. | batch-258 job 2 |

| @margoengine/navmesh | build/tiles borderSize now pads grids, rounds up, combines with automatic clearance and counts toward the padded cell budget; remove former no-effect statement | batch-252 job 6 |
| @margoengine/input | lock: request/release, raw negotiation, legacy raw null, activation, timeouts/AbortSignal, x/y and control publication | batch-253 job 3 |
| margoengine | Generated input/lock alias | batch-253 job 3 |
- @margoengine/animation: document captureState/restoreState clip identity, time, pause, loop and speed.
- @margoengine/animator: document playback snapshots, fade/layer replacement, same model definitions and paired stateful-clock hooks.
- @margoengine/save: document optional scene-state stable bindings, light/shadow capture and transactional restoration.
| @margoengine/inspector | Scene primitives and lights, delete/duplicate/reparent, tree dragging, retained history handles and disposal. | Batch 262 job 3 |
| margoengine | Optional inspector/edit import and undoable scene editing. | Batch 262 job 3 |
| @margoengine/react | Material lifecycle proof observes current plugin identities, including StrictMode name reuse. | Batch 262 job 3 |

- @margoengine/audio/binaural: BinauralAudio first/second/third order AmbiX, inherited Audio transport, field rotation, HRTF graph costs and browser-dependent localization.
- @margoengine/worker (batch 257 job 1): document /rpc typed RpcClient, exposeRpc handlers/context, rpcTransfer and RpcPool; defaults, ownership, queue limits, cancellation, deadlines and failure/disposal examples.

- margoengine (batch 257 job 1): cover the generated worker/rpc alias with the worker RPC documentation.
| @margoengine/tiles | tiles/imagery terrain source, Mercator/metadata availability, WMS/WMTS/XYZ layers, matrix configuration, opacity and source disposal | batch 239 job 3 |
| margoengine | tiles/imagery generated optional re-export | batch 239 job 3 |
| @margoengine/input | layout: KeyboardLabels refresh/label/change/error, map support and permissions fallback, race/cancellation/disposal, Unicode key prompts | batch-253 job 4 |
| margoengine | Generated input/layout alias | batch-253 job 4 |

- @margoengine/materials: document serialization entry, versioned complete parameter libraries, embedded/URL textures, features, shared resources and external resource codecs.
- @margoengine/shader: document serialization codecs for compiled node/lighting programs, live shared uniforms, storage inputs and raw shader bindings.
- @margoengine/save: document optional materials capture/restore, assigning restored slots, lazy shader codecs, aborts and resource resolvers.
| @margoengine/html | texture-gl: portable HTMLTextureGL, both rasterizers, WebGPU/preview depth, input, disposal and resource lifetime. | Batch 260 job 1 |
| margoengine | Generated html/texture-gl alias. | Batch 260 job 1 |
- @margoengine/xr: document xr/locomotion SmoothLocomotion.attach after requestSession, thumbstick options, teleport/turn, stereo comfort defaults, onEye and disposal.


- @margoengine/mcp: document live page plugin, live-host relay, createLiveTools, dev opt-in, token/origin setup, error lifecycle, inspector edits and capture limits (batch 267 job 1).
- margoengine: document generated mcp/live and mcp/live-host aliases (batch 267 job 1).

- @margoengine/worker and margoengine (batch 257 job 2): cover /auto runScene, shared createScene context/attach and SceneInstance, emitted module URL, default lazy worker/CSP factory, modes, backend probe, transfer ownership, AbortSignal/deadlines and await using disposal.


- @margoengine/audio/voices: AudioVoiceManager.add returns transport handles; shared cap, priority, distance/cone/custom gain, virtual phase including pitch, caller ownership and raw-control exclusions.
| @margoengine/sprites | pickSprite target-pixel coordinates, box/pixel modes, RGBA8 atlas pages, opacity thresholds, masks and custom-effect limits | batch-245 job 3 |
| margoengine | Document the sprites/pick alias and target-pixel coordinate convention | batch-245 job 3 |
| @margoengine/html | blend: HTMLBlend rectangular apertures, canvas alpha requirement, shared ownership, input routing, panel transforms and disposal. | Batch 260 job 2 |
| margoengine | Generated html/blend alias and synchronised upstream export aliases. | Batch 260 job 2 |
| @margoengine/inspector | Startup texture capture, late viewers, mip/channel/layer/aspect previews, exposure/range, cancellation and capture limits. | Batch 262 job 4 |
| margoengine | Optional inspector/textures import and capture startup ordering. | Batch 262 job 4 |
| @margoengine/webgl2-compat | Stencil-aspect sampling extension, coded capability refusal, depth restoration and ordinary-view aliases. | Batch 262 job 4 |
| margoengine | Generated aliases for APIs already on main: save/scene-state, audio/binaural, materials/serialization, save/materials, shader/serialization and xr/locomotion; also inspector/textures. | Batch 262 job 4 |

- @margoengine/stats: document /geometry counters, topology registration, indexed vertex semantics, indirect metadata, unknown bundle work, frame reset, panel, report and disposal.
- margoengine: document /stats/geometry alias.
| @margoengine/input | haptics: native triggerRumble parameters/defaults, capabilities, completion/preemption, AbortSignal/timeout, reset ownership and physical acceptance | batch-253 job 5 |
| margoengine | Generated input/haptics alias plus restored existing audio/binaural, materials/serialization, save/materials, save/scene-state and shader/serialization mirrors | batch-253 job 5 |
- @margoengine/xr: document xr/hands SkinnedHands.create(xr, { left, right }), profile asset loading, hand-tracking session request, jointNames, borrowed model ownership and cleanup.


- @margoengine/audio/sprites: AudioSpriteBank named offset/duration/loop maps, overlap and natural-end disposal; loadAudioFallback URL/MIME lists, capability probing, abort and failure causes.
- @margoengine/worker (batch 257 job 3): replace the pointer-lock limitation with page/worker requestPointerLock and exitPointerLock, pointerLocked state, existing PointerLockControls integration, trusted activation, raw input, AbortSignal/deadline and disposal behavior.

- @margoengine/ecs (batch 249 job 1): objects entry, objectField factories, mixed ObjectComponent fields, identity, packed row lifetime and touch.
- margoengine (batch 249 job 1): generated ecs/objects alias.

- @margoengine/stats: document /gl asynchronous frame/pass timing, early plugin registration, explicit scopes, disjoint/loss handling, limits, unavailable state, draw counts, reports, panel and disposal.
- margoengine: document /stats/gl alias.
- @margoengine/xr: document xr/ar-extra session negotiation, DOM overlay root ownership, current/legacy image targets, copied observations, mesh visualization and persistent anchor lifetime/abort cleanup.




- @margoengine/ecs (batch 249 job 2): RelationQuery exact/wildcard terms, source filters, returned target ids/rows, products and mutation semantics.
- margoengine (batch 249 job 2): generated ecs/relation-query alias.

- @margoengine/splines (batch 225 kinds): centripetal/chordal Catmull-Rom, CubicSpline closed controls, global analytic derivatives, curvature/torsion singularities and repeated-knot conventions.

- margoengine (batch 225 kinds): generated splines/kinds alias and refreshed existing audio/sprites, audio/voices and xr/hands aliases.

| @margoengine/scatter | Native and full-compatibility shadow culling, actual command-count observation and parity limits. | Batch 273 group15 |
| @margoengine/html | inlineResources/resourceInliner, texture prepare hook, same-origin/CORS images/fonts, imported sheets, cancellation, deadlines and explicit fontCSS for script-created faces. | Batch 260 job 3 |
| margoengine | Generated html/inline alias and synchronised upstream audio/voices export. | Batch 260 job 3 |


| margoengine | Review the generated save/scene-state alias with its owning feature in the README phase. | Batch 171 metadata repair |
- @margoengine/wfc: document /assemble loaded glTF templates, variants, default placement, template visibility, shared-resource ownership, cleanup and limits (batch 237 job 1).
- margoengine: document generated wfc/assemble alias and pre-existing audio/voices and xr/hands aliases (batch 237 job 1).
- @margoengine/xr: document xr/performance negotiation, per-session framebufferScale, fixedFoveation, runtime capability checks, frame-owned camera textures and disposal.
- @margoengine/webgl2-compat: document xr createProjectionLayer scaleFactor overriding installXR framebufferScale for one session, with defaults and float validation.

| @margoengine/core | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/math | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/bvh | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/controls | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/creative | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/decoders | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/environment | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/exporters | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/geometry | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/labels | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/lines | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/loaders | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/physics | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/points | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/text | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/usdz | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/react | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/shader | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/viewcube | Core version guard build declarations, attachment rejection and linked version errors. | version-guard |
| @margoengine/stage | Core version guard at stage attachment boundaries and matching core imports. | version-guard |
| margoengine | CORE_VERSION re-export and version-skew errors across umbrella and scoped imports. | version-guard |

| @margoengine/xr | Core version guard declarations at XR attachment boundaries. | version-guard |

- @margoengine/stats: document /panels attach and custom samples, four metric sources, defaults, units/averages/peaks, GPU pass names and async cadence, memory scope, null gaps, borrowed versus owned Stats and disposal.
- margoengine: document /stats/panels alias.
| @margoengine/water | Optional caustics entry, source-ready scheduling, receiver projection, shadows, limits and lifecycle | Batch 234 caustics |
| margoengine | water/caustics optional facade | Batch 234 caustics |

- @margoengine/worker (batch 257 job 4): document Firefox WebGL2 worker evidence, browser-matrix and strict browser selection, default-profile WebGPU gaps and the distinction between Windows WebKit fallback and unproved native Safari.
| @margoengine/inspector | animation: AnimationPanel.attach, per-clip set/state, play/pause/scrub/weights, skeleton, ownership and disposal | batch-263 job 1 |
| margoengine | Generated inspector/animation alias | batch-263 job 1 |

- @margoengine/wfc: document /tileset buildTileset/parseTilesetXML, six symmetry classes, orientation actions, subset selection, frequency weights, XML vocabulary and source-index assembly integration (batch 237 job 2).
- margoengine: document generated wfc/tileset alias (batch 237 job 2).
| @margoengine/sprites | BlendLayer/addBlend, mutable per-sprite modes, ordered batches, transparent multiply targets and smooth filtering | batch-245 job 5 |

| margoengine | Generated /sprites/blend alias and the missing /xr/performance alias already exported by XR on main | batch-245 job 5 |
- @margoengine/rigging (batch 213 job 1): VRM 0.x loading, coordinate conversion, metadata retention, expression/spring mapping, migration differences and cancellation.
- margoengine (batch 213 job 1): rigging/vrm0 optional alias.

| @margoengine/webgl2-compat | Native signed-byte SNORM compute storage, exact conversion, masked mip/layer uploads and regression command. | snorm-storage |
| margoengine | Generated xr/performance alias for the existing XR performance API. | snorm-storage landing repair |

- @margoengine/splines (batch 225 query): analytic bounds/extrema, plane equation and ray units, isolated/overlap results, precision, maxWork and all cubic kinds; margoengine/splines/query mirrors the entry.


- @margoengine/ecs (batch 249 job 3): ReactiveQuery cache, rows, subscribe/flush boundaries, initial replay, disposal, and World.destroying teardown semantics.
- margoengine (batch 249 job 3): generated ecs/reactive alias.

| @margoengine/webgl2-compat | Shipped Firefox BiDi matrix, environment-only executable, cross-browser oracle scope and native-adapter refusals. | Batch273 job2 |
| margoengine | Retained XR AR extras alias after concurrent manifest integration. | Batch273 landing blocker |
- @margoengine/wfc: document /overlapping3d sample layout, N, input/output wrapping, rotations/reflections, pins, default budgets, stats, limits and synchronous cancellation (batch 237 job 3).
- margoengine: document generated wfc/overlapping3d alias (batch 237 job 3).


| @margoengine/ui | forms entry: Select, RadioGroup, Tabs content ownership, Checkbox, ColorPicker, normalized channels, mirror/input attachment and disposal. | batch-258 job 3 |
| margoengine | ui/forms alias and accessible form setup. | batch-258 job 3 |
| @margoengine/inspector | gl: GLInspector attach/setDebug/capture, native preview backend, state restoration, timing limits and cancellation | batch-263 job 2 |
| margoengine | Generated inspector/gl alias | batch-263 job 2 |

- @margoengine/math (batch 220 job 1): document math/compat import migration, 17 methods, radians/shear layout, native and separate cameras, axis-angle output, degenerate/closed geometry, color spaces, cloning and original-entry size preservation.
- margoengine (batch 220 job 1): document generated math/compat alias.
# Batch 204 exporters

- `@margoengine/exporters/sparse`: document direct sparse scene export, existing-GLB layout conversion, independent sparse/interleave defaults, exact-value guarantees and stride/size limits.

- `@margoengine/exporters/splats`: document GLB ellipse-kernel/linear SH retention, optional splats peer, .splat quantization, cancellation and output limits.

- `@margoengine/exporters/optimize-extra`: document independent resample, prune and static sibling instancing passes, defaults, conservative extension retention and abort handling.


- @margoengine/wfc: document /assemble loaded glTF templates, variants, default placement, template visibility, shared-resource ownership, cleanup and limits (batch 237 job 1).
- margoengine: document generated wfc/assemble alias and pre-existing audio/voices and xr/hands aliases (batch 237 job 1).

- @margoengine/mcp: document assets library/search/variant/download/wire tools, manifests, provider limits, assets-page installer, public URL/material targets and disposal (batch 267 job 2).
- margoengine: document generated mcp/assets and mcp/assets-page aliases (batch 267 job 2).

- @margoengine/wfc: document /hex layouts, side directions, prism faces, masks/sentinel, periodic parity, pins, budgets, hexCellCenter, socket rotation/reflection metadata and weight splitting (batch 237 job 4).
- margoengine: document generated wfc/hex alias (batch 237 job 4).

| @margoengine/scenery | Native task-local and compatibility queue-complete displayed capture, preset parity and evidence scope. | Batch273 group16 |
| @margoengine/tiles | tiles/properties loaded-asset attribute/texture queries, raw images/codec callbacks, source barycentric UVs, limits and abortable resource loading | batch 239 job 5 |
| margoengine | Generated tiles/properties optional alias | batch 239 job 5 |

- @margoengine/splines (batch 225 offset): signed exact point offsets, bounded cubic approximation, source ranges and bevel joins, explicit singular/limit errors, closure and exact reverse; margoengine/splines/offset mirrors the entry.
- margoengine (batch 225 query/offset): generated splines/query and splines/offset imports and result contracts, with examples deferred until the README phase.
- `@margoengine/exporters/materials`: document glTF-shaped KHR material payloads, TextureData-backed extension maps and per-primitive named variants, with defaults and UV requirements.

| @margoengine/bvh | buildParallel options/defaults, nested worker assets, shared/cloned memory costs, cancellation/deadline, serial-byte parity and existing index-preserving default. | Batch 221 |
| margoengine | Generated bvh/parallel alias, reviewed with the owning bvh example in the README phase. | Batch 221 |

- @margoengine/ecs (batch 249 job 4): WorldSerializer snapshots/restores, remote id maps, chosen component semantics, createDelta/applyDelta/undo, limits/cancellation/native API requirements, codecs and World reserve/entities.
- margoengine (batch 249 job 4): generated ecs/serialize alias.



- @margoengine/mcp: document assets library/search/variant/download/wire tools, manifests, provider limits, assets-page installer, public URL/material targets and disposal (batch 267 job 2).
- margoengine: document generated mcp/assets and mcp/assets-page aliases (batch 267 job 2).

- @margoengine/mcp: document optional http createHttpTransport/serveHttp, server factory, JSON response mode, session/version headers, tokens, authorizer/TLS mounting and all default limits (batch 267 job 3).
- margoengine: document generated mcp/http alias (batch 267 job 3).

- @margoengine/mcp: cover both HTTP protocol eras, modern per-request metadata, discovery, encoded/custom headers and distinct disconnect cancellation semantics.
- @margoengine/cache: document cache/stream StreamingAssetCache, pull-driven bodies, consume/cancel before flush, EOF commit, failure behavior, budgets and service worker waitUntil.
- margoengine: document the generated cache/stream alias and StreamingAssetCache lifecycle in the README phase.
- @margoengine/sciviz: document optional pipeline registry, lazy demand, dirty/time propagation, AbortSignal, JSON restoration, resource ownership and NASA FUN3D demo after the build phase.

- margoengine: document the optional sciviz/pipeline facade and its equivalence to @margoengine/sciviz/pipeline after the build phase.

| @margoengine/inspector | tools: CameraTools placement, camera registration/loaded discovery, screenshot, recording start/stop, model/scene GLB and glTF, lazy dependencies and disposal | batch-263 job 3 |
| margoengine | Generated inspector/tools alias | batch-263 job 3 |
- @margoengine/animation: document registered-scene disposal, terminal controller lifetime and asynchronous geometry-cache scene/signal ownership.
- @margoengine/react: document browser script repository-root invocation.

- @margoengine/math (batch 220 job 2): document /curve scalar/keyed APIs, four modes and string constants, tension and boundary policies, copied/normalized keys, channel editing, reusable packed interpolants, sampling, limits and a tuning-table example.
- margoengine (batch 220 job 2): document generated math/curve alias and regenerated bridges to the already-built exporters/optimize-extra and exporters/splats entries.

- @margoengine/inspector (batch 220 landing repair): document native-context capture/overlay ownership, removal of the compatibility-package peer dependency and coded shader failure cleanup.
- @margoengine/procedural (batch 230 tree-mesh): meshTree, generateParametricTree, meshTreeLODs, parameter defaults, material atlases and integration with /trees and /lod; examples deferred.
- margoengine (batch 230 tree-mesh): generated procedural/tree-mesh alias; examples deferred.



| @margoengine/ui | world-gl entry, backend fallback setup, WorldPanels alias, inherited options/rays, resource lifetime and preview differences. | batch-258 job 4 |
| margoengine | ui/world-gl alias and world-panel setup. | batch-258 job 4 |
- @margoengine/scene (batch 226 graph): document /graph search, atomic attach and shear limits, coordinate outputs, axis units and traversal, with examples in the README phase.
- margoengine (batch 226 graph): document generated scene/graph alias in the README phase.
- @margoengine/cache: document cache/decoded keys, typed result persistence, device format/revision/options identity, getOrDecode cancellation, budgets and storage-failure semantics.
- margoengine: document the generated cache/decoded alias in the README phase.

- @margoengine/mesh-edit: document section split/trim/slice, arbitrary plane basis, ownership, source face maps, caps, UVs, empty/tangent results, float64 limits and cancellation (batch 224 job 1).
- margoengine: document the generated mesh-edit/section alias in the README phase (batch 224 job 1).
- @margoengine/scene (batch 226 clone): document cloneSubtree defaults, resource sharing/lifetimes, exact local transforms, structured metadata, ownership and rollback with examples in the README phase.
- margoengine (batch 226 clone): document scene/clone generated alias in the README phase.
