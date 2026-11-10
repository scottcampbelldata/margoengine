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

- @margoengine/tiles: cover tiles/features decoration, ray-hit resolution, legacy/structural IDs, exact decoded accessor bytes, UV transforms, reversible highlight and live budgets.
- @margoengine/gltf-pro: cover convex interpolatedDirections prepared geometry and adding later UV buffers with writeGeometry.

- margoengine: cover the generated tiles/features alias.
- @margoengine/procedural (batch 230 textures-pbr): createPBRTextureBaker, four-map formats, palettes, controls, explicit animation time, mipmaps, compatibility-layer setup and lifecycle; examples deferred.
- margoengine (batch 230 textures-pbr): generated procedural/textures-pbr alias; examples deferred.

| @margoengine/webgl2-compat | Bitmap source crop/orientation/alpha semantics, temporary canvas cost, destination types and normal-map proof. | Batch273 group12 |
| margoengine | Generated exporters/sparse alias and its import-equivalence proof. | Batch273 group12 landing blocker |

- @margoengine/ecs (batch 249 job 5): SharedWorld/SharedComponent storage, sharedIndex, ParallelSchedule read/write declarations, module worker assets, dependencies, isolation, update/abort/deadline/disposal, endpoint adapters, partial-write and failed-host semantics.
- margoengine (batch 249 job 5): generated ecs/parallel alias.
- @margoengine/selection: document hit-details HitDetails replacement for Picking, fields/defaults, batch staging, core zero UV, overlay/proxy contracts, AbortSignal and disposal (batch 199 job 1).
- @margoengine/cache: replace stale Node-only prefetch/throttle and RangeCache browser/service worker limitations with batch-208 browser evidence; document worker flush lifetime and offline range behavior.
- @margoengine/ui (batch 259 job 1): document /curved CurvedPanel arc dimensions, ray mapping, segment limits, layoutPanels arrangements and /world-gl renderer setup in the README phase.
- margoengine (batch 259 job 1): document ui/curved alias in the README phase.

- @margoengine/animation: document /mixer construction, clipAction weights/rates, fades, warped crossfade, loops, additive delta conventions, ownership and disposal (batch 210 job 1).
- margoengine: document animation/mixer alias and regenerated exporters/splats alias (batch 210 job 1).

- @margoengine/mesh-edit: cover boolean-batch n-ary union/intersection, first-minus-union, empties, duplicate IDs and per-input provenance, work counters, exact-space rounding, limits and cancellation (batch 224 job 2).
- margoengine: document the generated mesh-edit/boolean-batch alias and upstream exporters/sparse alias in the README phase (batch 224 job 2).
- @margoengine/scene (batch 226 tags): document TagSet and DOM events, OR/AND arrays, boolean query grammar/limits, cloned tags, explicit SceneEvents installation/restoration, event ordering, transactional compound operations, errors and abortable subscriptions, with examples in the README phase.
- margoengine (batch 226 tags): document generated scene/tags alias in the README phase.
- @margoengine/loaders (batch 202 job 1): document /ply and /off, face RGBA and scalar/list group properties, binary OFF and external colormap indices; correct stale Limits claims for VTK XML and 3MF textures (batch job 5).
- margoengine (batch 202 job 1): document loaders/ply and loaders/off aliases.
- margoengine (batch 202 rebase): document the generated exporters/sparse alias for the already-landed optional exporter.

| @margoengine/sprites | /spine JSON parse/load/serialize, whole-format rig mapping, regions, skins, constraints/events/curves, named deferred physics warnings; skeletal jointPositions, dark tint and blend runs | batch-245 job 4 |
| margoengine | Generated /sprites/spine alias | batch-245 job 4 |
| margoengine | Restore the exporters/sparse alias for the export already on main | batch-245 landing mirror repair |

- @margoengine/selection: document xray XRaySelection styling, default cosine pulse, manual time/play, multiview advancement, ownership and disposal (batch 199 job 2).


| @margoengine/react | useFrame numeric priorities, positive takeover, demand restoration and XR manual draws | batch 265 job 4 |
| @margoengine/xr | onFrame returning false and frame-local renderFrame for both eyes | batch 265 job 4 |
| margoengine | React frame priorities through the umbrella alias | batch 265 job 4 |

- margoengine (batch 265 landing): generated exporters/sparse alias, owed with its owning package examples.
- `@margoengine/exporters/textures`: document resize/encode/format-probe/GLB APIs, defaults, colour/data roles, native encoder detection, cancellation, PNG/JPEG fallbacks and runtime/size limits, with runnable examples during the README phase.
- @margoengine/ui (batch 259 job 2): document /keyboard VirtualKeyboard, custom rows, field connection, shift/caps, editing controls and XR/gamepad setup in the README phase.
- margoengine (batch 259 job 2): document generated ui/keyboard alias in the README phase.





- @margoengine/voxel-pathtracer: shared affine mesh instances, BLAS cache statistics, SAH and degenerate-face handling, vertex normals and UV textures.
- margoengine: generated controls/globe export ordering refreshed while landing voxel-pathtracer BLAS dependencies.
- @margoengine/headless: deferred README-only node-check.mjs bundled in test:gpu; ffmpeg is absent from PATH. Rendering correctness in browser-check.mjs passed during the BLAS dependent gate.
- @margoengine/react: browser binding and instance checks now launch from the repository root; README runtime work stays deferred.
- @margoengine/sciviz: document /contour CPU/GPU multi-level isosurfaces and isolines, contourOperator, pulling cell assumptions, precision bound, cancellation and NASA demo.
- margoengine: document generated sciviz/contour alias with the owning sciviz contour entry.


| @margoengine/react | performance: PerformanceMonitor defaults, measured samples, callbacks/hook/controller, AdaptiveDpr decline/restoration, per-Canvas targets, picking, demand/XR and lifecycle limits | batch 265 job 5 |
| margoengine | react/performance optional alias | batch 265 job 5 |
- @margoengine/geometry (batch 219 job 1): nurbs-edit insertion/elevation for curves and both surface axes, UV trimming with holes/islands, defaults and numerical/resolution limits; generated margoengine/geometry/nurbs-edit alias.
- margoengine (batch 219 job 1): generated geometry/nurbs-edit alias and current umbrella alias completeness; examples remain deferred.

- @margoengine/mesh-edit: document repairMesh soup input, exact/distance welding, reported removals, winding/fan policy, hole limits, cavity orientation, corner UV reset, provenance, readyForBoolean meaning and cancellation (batch 224 job 3).
- margoengine: document mesh-edit/repair alias in the README phase (batch 224 job 3).
- @margoengine/loaders (batch 202 job 2): document /vtk-legacy, all five datasets, preserved topology, line/vertex/triangle source cells, point/cell/global data, bounds and outer/all surface policy; examples deferred.
- margoengine (batch 202 job 2): document loaders/vtk-legacy and the regenerated selection/hit-details alias for the already-landed picking entry.
- @margoengine/selection: document area AreaPicking, rect/polygon CSS pixel-centre rules, even-odd lassos, view/scissor/layers, identity/order, source/overlay limits, pixel/memory budget, cancellation and shared pick queue (batch 199 job 3).

- @margoengine/animation: document /playback import, loop modes/counts, events, finished/waitForFinished, negative rates, seek/restart and cancellation defaults (batch 210 job 2).
- margoengine: document animation/playback and regenerated selection/hit-details aliases (batch 210 job 2).



- @margoengine/blender (batch 207 job 1): document object_animation export option (default false), objects entry, local hierarchy, empty pivots, action/NLA-slot sampling, constraints, signed scale, scene restoration and generated-instance limits.
- margoengine (batch 207 job 1): document blender/objects alias and regenerated upstream selection/hit-details alias.

- @margoengine/headless: document /tiles renderTiles streaming, renderTiled assembly, sample-count AA, padding, cancellation, WebGPU-only readback and temporal-filter limits.
- margoengine: document headless/tiles as the one-install alias of @margoengine/headless/tiles.
- @margoengine/ui (batch 259 job 3): document /i18n Localization tables, fallback/plurals/parameters, live bindings, relayout and text-direction switching in the README phase.
- margoengine (batch 259 job 3): document ui/i18n alias in the README phase.


- @margoengine/voxel-pathtracer: mesh-pbr factory, material channels and samplers, independent mesh material ids, loaded glTF snapshot ownership and compressed-image callback.
- margoengine: optional voxel-pathtracer/mesh-pbr re-export and typed loaded-glTF interop.
- @margoengine/road (batch 233 job 1): intersections joins/caps, curb returns, height field, curb/sidewalk layers, defaults, bounds, ownership and runnable example after build phase.
- margoengine (batch 233 job 1): optional road/intersections forwarding entry after build phase.
- @margoengine/geometry (batch 219 job 2): extras geodesic/Goldberg classes, face topology/groups, capped hemisphere, cropped tiling patterns/alignments/sides and per-face box options; examples deferred.

- @margoengine/culling: document /webgl2 WebGL2Culling and SoftwareDepthBuffer, resolution, conservative coverage, per-view buffers, toggling and disposal (batch 223 job 1).

- margoengine: document the generated culling/webgl2 alias (batch 223 job 1); no README examples were written during the build phase.
- @margoengine/fbx (batch 205 textures): document textures extension, decoder formats, PBR composition, worker support and limits; examples deferred.
- @margoengine/decoders (batch 205 BMP): document parseBMP formats, maxPixels, alpha and unsupported compression; examples deferred.
- @margoengine/decoders (batch 205 texture-rgba): document the raw texture conversion entry; examples deferred.
- margoengine (batch 205): document generated fbx/textures, decoders/bmp and decoders/texture-rgba aliases; examples deferred.





- @margoengine/voxel-pathtracer (batch 243 job 4): document DenoiseML creation, required renderImage AOVs, cancellation/disposal, device replacement, numeric limits and clean-room training/holdout evidence; examples deferred by rule 20.
- margoengine (batch 243 job 4): generated voxel-pathtracer/denoise-ml alias; README work deferred by rule 20.


- @margoengine/headless and margoengine: document /null createNullStage, scene/plugin and animation ticks, fixed delta/time, disposal, cancellation, and GPU-only operation refusals.
- @margoengine/sciviz: document /clip, named tuple arrays, sourceCells, all cut shapes and inversions, crinkle, threshold modes, image/curvilinear subsets, cancellation, sampled implicit limits and TCIA/NASA demos.
- margoengine: document the generated sciviz/clip alias with its owning optional entry.
- @margoengine/usdz: pointInstancers() optional /instancer entry, timeCode/maxNodes, prototype sharing, masks, nesting and worker usage; sampled layers need composition().
- margoengine: generated usdz/instancer alias; generated selection/hit-details alias restores the export map checked by the existing umbrella test.
- @margoengine/selection: document highlight Highlight glow/fill, independent colours/opacities, inner/outer toggles, radius/sigma, current-pose visible masks, multiview/lifecycle, memory/defaults and separate named groups (batch 199 job 4).
- @margoengine/loaders (batch 202 job 3): document /geo readers, mixed primitives, feature addressing, source CRS/precision, holed polygon mesh, Shapefile sidecars/Z/M, GPX/KML metadata, MVT tile conversion, limits and cancellation; examples deferred.
- margoengine (batch 202 job 3): document loaders/geo and the regenerated selection/area alias for the already-landed entry.
- @margoengine/road (batch 233 job 2): lanes widths, boundary styles/dashes/phase, curved arrows, reverse direction, junction connector curves/exclusions, height, defaults and runnable example after build phase.
- margoengine (batch 233 job 2): road/lanes alias after build phase.
- @margoengine/ui (batch 259 job 4): document /editor LayoutDocument/LayoutEditor, app-owned preview renderer, source/property/tree edits, history, validation, save/open and disposal in the README phase.
- margoengine (batch 259 job 4): document ui/editor alias and browser editor entry page in the README phase.

- @margoengine/animation: document /discrete-tracks typed constructors, hold-left sampling, buffers/edits/JSON, safe binding, createDiscreteClip, plain roots, winner semantics, constant clips and disposal; refresh mixer bytes (batch 210 job 3).
- margoengine: document animation/discrete-tracks alias (batch 210 job 3).
- @margoengine/tiles: cover tiles/fade construction, decorate then attach, monotonic simulation clock, hierarchy reversals, ADD, live retention budgets and composing feature/style decoration.
- @margoengine/points: cover optional live PointsMaterial.ditherFade coverage intervals and unchanged alpha/depth defaults.
- @margoengine/splats: cover setDitherFade original-order content ranges, lazy four-byte masks, global sorting, quantization and device restoration.
- margoengine: cover the generated tiles/fade alias.





- @margoengine/voxel-pathtracer (batch 243 job 2): document emissive-triangle NEE/MIS and MeshTraceScene.spotLights, candela units, cone/range defaults, Type C IES parsing, external tilt ownership and PBR texture/alpha sampling; examples deferred by rule 20.

- margoengine (batch 243 job 2 dependent gate): generated audio/sprites and xr/hands aliases now match current package exports; README work remains deferred by rule 20.

- @margoengine/blender (batch 207 job 2): document lightmap_size (0 off, 16..4096), UV1 generation/preservation, Cycles diffuse passes, HDR scale, scene restoration and lightmap decoder/loaders.
- @margoengine/lightmap (batch 207 job 2): document imported readLightmap/applyLightmap, physical irradiance, UV1, plugin lifetime/device restore, replace-lighting semantics and material-extension ownership.
- margoengine (batch 207 job 2): document blender/lightmap and lightmap/imported aliases.
- @margoengine/geometry (batch 219 job 3): teapot size/resolution, part and proportion options, patch UVs/material groups, model attribution and geometric/numerical limits; examples deferred.
- margoengine (batch 219 job 3): generated geometry/teapot optional alias; examples deferred.



| @margoengine/tilemap | objects: ObjectTileMap, images keyed by source, ordered tile/object/image layers, buildMapQuads, anchors, flips, repeat, runtime edits and lifecycle | batch-246 job 1 |
| margoengine | Generated tilemap/objects alias | batch-246 job 1 |


- @margoengine/headless: document /gif encodeGIF over renderFrames and async pixel streams, optional exporters peer, repeat/duration/alpha options, cancellation and result bytes.

- @margoengine/exporters and margoengine: document /palette quantizePalette plus paletteTexture, and /capture encodeGIFFrames stream, repeat/duration/cancellation options and delay rounding.

- @margoengine/geometry: document geometry/hull convexHullTriangles source-index/double-precision contract, empty lower dimensions, normalized tolerance and cancellation; retain legacy convexGeometry behavior (batch 224 job 4).
- @margoengine/mesh-edit: document convexMeshHull and general minkowskiSumMeshes, concavity/cavities, new face IDs/UVs, work counters/budgets, floating limits and cancellation (batch 224 job 4).
- margoengine: document geometry/hull and mesh-edit/hull aliases and restored mesh-edit/repair manifest alias in the README phase (batch 224 job 4).


| @margoengine/react | Texture hooks, TextureProvider for root map props, TextureMaterial for every native material, Scene ownership, media lifetime and both backends | batch 265 job 3 |
| @margoengine/materials | Material queues are per Scene, including named Scene disposal | batch 265 job 3 |
| @margoengine/gltf-pro | Model disposal removes its owning Scene plugin | batch 265 job 3 |
| margoengine | New react/textures alias and separate decoder-bearing import | batch 265 job 3 |

| @margoengine/shader | sceneColor shares the owning Scene capture; keep recorder fixtures aligned with Engine frameGraph and sceneOf | batch 265 job 3 |
- @margoengine/usdz and margoengine: implicitShapes() optional /shapes entry, schema defaults, axes, radialSegments/latitudeSegments, budgets, worker and instancer combination.
