# README work owed

- @margoengine/sciviz (review 3 dependency gate): retain the package browser-root bootstrap for fallback and table test commands; examples deferred.

- @margoengine/splats (review 3): cover progressive cancellation during pending async iteration and between buffered batches, including producer cleanup ownership; examples deferred.

- @margoengine/rigging (review 3): cover mixed MToon and standard PBR/unlit materials, alpha queues and restored records; examples deferred.


- @margoengine/materials and @margoengine/gltf-pro (fixes K2 job 1): document automatic per-surface native display glass snapshots, linear addition, capture cost and HDR behavior; examples deferred.
- @margoengine/oit (fixes K2 job 1): test fixtures account for native glass capture; no OIT runtime API or README example changes.

- @margoengine/react (fixes K2 job 2): document packed-consumer test dependencies and the repository-root override for contributor-script tests; README examples remain deferred.
- @margoengine/react (K2 packed follow-up): cover portal/decal ownership across React 18 and 19 StrictMode replay; examples deferred.

- @margoengine/creative (K2 job 3): the meadow test audit now follows the active device classes on native and compatibility; no feature or README example changes.

- @margoengine/clustered (batch 186 job 1): document /area-shapes AreaShapes, disk/sphere LTC and castShadow settings, shared LocalShadows casters, four shaped plus four rectangular shadow slots, radius-scaled PCSS and defaults; examples deferred.
- margoengine (batch 186 job 1): document clustered/area-shapes forwarding entry; examples deferred.

- @margoengine/oit (batch 190 job 2): document /precise PreciseOIT, float32-blendable request, EXT_float_blend/five-target requirements, 1x/4x behavior, depthScale/order defaults, 18/72 B per pixel and finite radiance/sorted-path limits; examples deferred.
- margoengine (batch 190 job 2): document the oit/precise forwarding entry; examples deferred.

- @margoengine/oit (batch 190 job 1): document /peel PeelOIT, ten-layer default, adjustable layers/order, full WebGL2 support, resource costs and single-sample/coplanar/model-only limits; examples deferred.
- margoengine (batch 190 job 1): document the oit/peel forwarding entry; examples deferred.

Scott (2026-11-09): README examples and `check:readme-run` wait until the features are built. Each job that changes a package adds one line here. The README phase before release clears this list; it must be empty at release.

| Package | What its README must cover | Added by |
|---|---|---|
| @margoengine/lightmap | global: bounceMode 'path' with bounces up to 8 and a furnace example | batch-54 job 5 |
| @margoengine/lightmap | refracted: rough glass, dispersion and bounces (roughness, dispersion, bounces, diagnostics.masked and reflected) | batch 54 job 8 |
| @margoengine/lightmap | probes: bakeLightProbes over a baked room and probeIrradiance | batch 54 job 7 |
| @margoengine/lightmap | denoise: denoiseLightmap, denoiseMeshLightmap, denoiseTexels with options and defaults | batch-54 job 4 |
| margoengine | Generated lightmap/denoise alias | batch-54 job 4 |
| @margoengine/lightmap | directional: bakeDirectionalLightmap and directionalIrradiance (direction and directional maps, evaluating with a mapped normal) | batch 54 job 6 |
| `@margoengine/webgl2-compat` | Compute binding limits across automatic/explicit layouts, validation scopes, async `GPUPipelineError` and recovery example. | Batch 273 failure 18 |
| @margoengine/fsm | events: EventMachine send/plan data, EventState/Transition hooks and guards, EventTrace capacity and disposal; payloads are references | batch-250 job 1 |
| margoengine | Generated fsm/events alias and payload entry availability | batch-250 job 1 |
| @margoengine/fsm | final: FinalMachine, final leaf constraints, done.state.parent, always guards, macrostep bound, stopped top-level final and goto restart | batch-250 job 2 |
| @margoengine/netcode | lobby: LobbyRoom metadata/privacy, RoomLobby filters, reservation lifetime/cancel, one-time joinById seatToken and server-held join identity; correct stale limits | batch-256 job 1 |
| margoengine | Generated netcode/lobby alias | batch-256 job 1 |
| @margoengine/clustered | area-texture: AreaLightTextures.attach({ area }), setTextures per area light, sRGB/linear, alpha, limits and what the filtered lookup approximates | batch-52 job 5 |
| margoengine | Generated clustered/area-texture alias | batch-52 job 5 |
| @margoengine/clustered | layers: LightLayers.attach({ lights }), setLayers per light, add(receiver, { layers }); core meshes on layer 0 | batch-52 job 7 |
| margoengine | Generated clustered/layers alias | batch-52 job 7 |
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
- @margoengine/lightmap (batch 187): document opaque back-face blocking for area shadows and diffuse bounces, front-only outgoing radiance, existing mesh/gpu/directional entry parity, and the remaining Cornell accuracy difference; examples deferred.

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
- @margoengine/fbx (batch 205 large): document largeFBX, all per-import defaults, conservative allocation accounting and worker caps; examples deferred.
- margoengine (batch 205 large): document generated fbx/large alias; examples deferred.

- @margoengine/road (batch 233 job 3): GeoJSON/OSM imports, tags/width/lane defaults, source identity, grade-separated network topology, coordinate projection, bounds and runnable render/graph example after build phase.
- margoengine (batch 233 job 3): road/geojson alias after build phase.
- @margoengine/sciviz: document /probe locator ownership, barycentric/trilinear cell models, integration dimensions, masks/resampling, profile/chart linkage, pipeline params, precision/conditioning limits and NASA/OpenNeuro demo.
- margoengine: document generated sciviz/probe alias alongside the owning optional entry.

- @margoengine/culling: document /bounds BoxCulledMeshes, BoxCulledModels and BoxDynamicInstances, inherited methods, padding and compatibility behaviour (batch 223 job 2).
- margoengine: document the generated culling/bounds alias (batch 223 job 2).


- @margoengine/blender (batch 207 job 3): document meshopt compression/expansion and loaders, lossless index order, no-growth fallback, flags/section bounds, AbortSignal and options.parse for other entries.
- margoengine (batch 207 job 3): document blender/meshopt alias.

| @margoengine/tilemap | tiled: XML/JSON templates/maps/tilesets, baseUrl/resolve/cancellation, gid remapping, image and text layers, inherited tint, sparse collections; autotile: WangGrid, WangRuleSet and resolveWang | batch-246 job 2 |
- @margoengine/animator (batch 211 job 1): document /layers addStateLayer, independent graph controls, masks/live weight, override/additive order, pause/speed, loaded references and lifetime; examples deferred.
- margoengine (batch 211 job 1): document generated animator/layers alias.

- @margoengine/road (batch 233 job 4): structures automatic/authored spans, bridge supports, tunnel profiles/open portals, terrain entrance integration, crossing clearance, bounds and runnable example after build phase.
- margoengine (batch 233 job 4): road/structures forwarding entry after build phase.

- @margoengine/labels (batch 261 job 1): document optional GPU layer creation, collections, CSS sizing, grid priorities, atlas limits, cancellation and disposal; README examples deferred.
- margoengine (batch 261 job 1): document labels/gpu alias; README examples deferred.



- @margoengine/scenery (batch 232): document /moon, lunar map loading and AbortSignal, world north, phase-dependent earthshine, map replacement and disposal.

- @margoengine/loaders (batch 202 job 4): document /threemf-lattice, native construction versus source preview, object/build transforms and units, balls/sets/clipping references, inline/external slice data and precedence, material row defaults/linear blend/opacity, limits and cancellation; examples deferred.
- margoengine (batch 202 job 4): document loaders/threemf-lattice and regenerated selection/highlight alias.
- @margoengine/loaders (batch 202 job 5): correct stale Limits statements about VTK XML, 3MF textures and newly built optional readers when README work resumes; deferred under lane rule 20, with no README edits or execution in this batch.

- @margoengine/rigging (batch 213 job 2): MToon attachment, VRM 0.x migration, authored lighting/UV/outline controls, expressions, lifecycle and accepted integration limits.
- @margoengine/gltf-pro (batch 213 job 2): /material-draw synchronous source/replica adapters and optional decoded-image lookup.
- margoengine (batch 213 job 2): rigging/mtoon and gltf-pro/material-draw aliases.
- @margoengine/animator (batch 211 job 2): document /blend-trees RichBlendTree schemas, createBlendTree, gradient modes, direct zero/negative weights, nesting, graph/layer/sync/root-motion integration and limits; examples deferred.
- margoengine (batch 211 job 2): document generated animator/blend-trees alias.


| @margoengine/tilemap | plane: PlaneTileMap transforms, world units, active core/view camera, depth writes/testing, cutouts, transparent order, finite-map repeat, runtime edits and disposal | batch-246 job 3 |
| margoengine | Generated tilemap/plane alias | batch-246 job 3 |

- @margoengine/labels (batch 261 job 2): document DistanceLabels per-label policies, clamped opacity/scale, inclusive ranges, composition, original-opacity restoration and evaluateLabelDistance for GPU consumers.
- margoengine (batch 261 job 2): document labels/distance alias.

- @margoengine/splats: document /progressive readSplatsProgressive and loadProgressiveSplats, early frames with engine.start(), count and batchSize, cancellation, SPZ base preview/final SH, retained bytes and available-record coarse ordering.

- @margoengine/webgl2-compat: document direct full-image straight-alpha bitmap copies and the existing Canvas2D path for crop, flip and requested premultiplication.
- margoengine: document the generated /splats/progressive alias alongside the scoped entry.
- @margoengine/sciviz: document /calc grammar, derived operation contracts, bounds, pipeline adapter and NASA calculator demo; README examples deferred during build phase.

- margoengine: document the sciviz/calc optional alias after build phase.


- @margoengine/culling: document /sort FrontToBack, InstanceSorter, SortedInstances, stable equal-depth keys, registration/removal, toggles, opaque-only input and buffer flags (batch 223 job 3).
- margoengine: document the generated culling/sort alias (batch 223 job 3).
- @margoengine/react: controls-extra KeyboardControls/useKeyboardControls, ScrollControls/useScroll/Scroll (mesh and HTML), PresentationControls, optional controls peer and cleanup.
- margoengine: react/controls-extra umbrella alias and native SpringOptions naming.
- @margoengine/controls: PresentationControls accepts geometry-free product roots and picks their live nested descendants.
- @margoengine/fbx (batch 205 job 3): document legacyFBX opt-in 6.x ASCII/binary, legacy Takes/skin/morph/material semantics, worker composition and supported interpolation/budgets.
- @margoengine/scatter and margoengine: document /textured TexturedScatter whole-model placements, glTF normal/base MASK materials, shadows.add(scatter.model), embedded instances, node-pose capture, updates, limits and disposal.

- @margoengine/lines (batch 227 job 1): document /stroke, width multipliers, progress in world arc length, defaults, point replacement, dashes/depth/fog/picking and disposal; README examples deferred.



| @margoengine/terrain | imagery: XYZ/WMTS/GPU sources, ordered alpha/brightness/bounds, cancellation, residency, credits and planet surface hooks | batch-229 job 1 |
| margoengine | Generated terrain/imagery facade and lazy optional entry usage | batch-229 job 1 |
- @margoengine/animator (batch 211 job 3): document graph offset, interruptionSource including both precedence orders, legacy interruptible defaults, event entry boundaries and independent fade/source clocks; examples deferred.

- margoengine (batch 211 job 3): regenerated alias ordering after rebase; no example work during build phase.

- @margoengine/labels (batch 261 job 3): document ClusterLabels radius components, minCount, camera/logical zoom, bubble styling and member handles, nested layouts and disposal.
- margoengine (batch 261 job 3): document labels/cluster alias.

| @margoengine/clustered | shapes: ShapeLights (sphere, disc, tube), setLights validation, MAX_SHAPE_LIGHTS, radianceFromPower and shapeLightArea, Clustered.shapes hook, no shadows | batch-52 job 3 |
- @margoengine/react and margoengine: portals RenderTexture output/ref/onTexture, isolated Hud cameras, view ordering, physical target sizes and compatibility-device requirement.


- @margoengine/lines (batch 227 job 2): document /texture image pixels/loading/cancellation, UV units, alpha, mipmaps, stroke composition and restoration; examples deferred.
- margoengine (batch 227 job 2): document lines/stroke and lines/texture forwarding entries; examples deferred.
- @margoengine/scatter: document /surface scatterSurface GeometryData inputs, exact area/paint density, normal alignment, world matrix/offset/scale/yaw defaults, returned arrays, limits, source updates and AbortSignal.
- margoengine: document the /scatter/surface forwarding entry and its surface placement arrays.
- @margoengine/sciviz: document /glyph input/selection, defaults, six sources, ownership, warp contracts and NOAA/SEACAS demo; examples deferred during build phase.

- margoengine: document sciviz/glyph optional alias after build phase.

- @margoengine/fbx (batch 205 job 4): document surfaces extension, loaders/nurbs dependency, NURBS forms/weights/orders, patch bases, closure/caps, Step/budgets, page/worker and legacy composition, polygon-bake remedy for control-net deformation.
- @margoengine/usdz (batch 206 job 3): document curves(), pose/timeCode, interpolation, automatic Lines/Points attachment, optional peers, worker lifetime and tessellation limits.
- @margoengine/animator (batch 211 job 4): document /masks createBoneMask and addWeightedLayer clip/graph forms, live dense node weights, effective strength, override/additive/morph behaviour, default zero entries and lifetime; examples deferred.
- margoengine (batch 211 job 4): document generated animator/masks alias.
- @margoengine/lighting2d (batch 247 job 1): document sdf SDFScene2D source/emission layer getters, camera, alpha threshold, linear color/HDR, borrowed lifetime, resize/restore and GILighting2D painted input.
- margoengine (batch 247 job 1): document generated lighting2d/sdf alias.


- @margoengine/transitions (batch 218 job 1): document live built-in selection, mask image ownership and softness, LiveTransitions.custom with AbortSignal, exact endpoints and compatibility layer support; examples deferred.

- @margoengine/webgl2-compat (batch 218 job 1): document explicit render layout static-resource/visibility validation and async pipeline error delivery; examples deferred.
- @margoengine/rigging (batch 213 job 3): vrm-constraints reader, evaluator, Animator/scene attachment, live weights, dependency rules and disposal.
- @margoengine/gltf-pro (batch 213 job 3): retained required VRMC_node_constraint data and explicit optional runtime.
- margoengine (batch 213 job 3): rigging/vrm-constraints alias.
- @margoengine/lod (batch 222 job 1): document /clusters builder, hierarchy/error model, anchor renderer, meshlet limits, dither band, compatibility support and cancellation.
- @margoengine/mesh-edit (batch 222 job 1): document simplifyMesh lockedVertices and maxDeviation; chain indices remain local to each invocation.
- @margoengine/webgl2-compat (batch 222 LOD blocker): explain task-based fence/map readiness and retained async/loss semantics.



- cinematic: document physical-lens millimetres, fitted sensor, f-stop, stage order and post-brain apply to DOF (batch 216 job 1).
- margoengine: document cinematic/physical-lens alias (batch 216 job 1).



- @margoengine/blender (batch 207 job 4): document nodes export toggle, parse/loadMargoNodes, controller parameters/get/set/reset/seek, disposal, node coverage, bounds, cancellation and accepted noise/subframe differences.
- margoengine (batch 207 job 4): document blender/nodes alias.

- @margoengine/labels (batch 261 job 4): document RoutedCallouts, angled elbow/port reordering, side and overflow settings, pure routeCalloutLeaders preconditions, exact predicates, complexity and disposal.
- margoengine (batch 261 job 4): document labels/callouts-route alias.

- @margoengine/lines (batch 227 job 3): document /debug immediate lifetime, depth/width/colour grouping, limits, persistent ArcLine, planar tilt and spherical arc defaults and degeneracies; examples deferred.
- margoengine (batch 227 job 3): document lines/debug forwarding; generator also restores the missing clustered/shapes forwarding file required by umbrella consistency tests.

- @margoengine/splats and margoengine: document /formats parseKsplat, parseCompressedPly and encodePly, supported revisions, SH, colour conversion, binary/ASCII export, opacity endpoints, synchronous decoding and existing covariance regularization.


- @margoengine/transitions (batch 218 job 2): document /presets, all eight names, pure WGSL generation, frozen/live factories, polynomial easing, parameter defaults and geometric treatment limits; examples deferred.
- margoengine (batch 218 job 2): document transitions/presets forwarding entry; examples deferred.

| @margoengine/terrain | overlays: metre-width strokes, polygon holes, all GeoJSON families, projection/style callbacks and atomic live edits; RVT addSurface/refreshSurfaces and imagery virtualTexture ordering/ownership | batch-229 job 2 |
| margoengine | Generated terrain/overlays facade | batch-229 job 2 |
- @margoengine/lighting2d (batch 247 job 2): document painted diffuse faces/albedo, exact temporal reuse default true, resetHistory(), source/scene edit invalidation, per-encoder snapshot sharing, memory/lifetime, and replace stale no-history/GI correctness-exception language with the documented fixture bounds.

- cinematic: document ortho camera height, existing rigStage follow, framing/group stages, projection output, size blends, zones and mixed-mode endpoints (batch 216 job 2).
- margoengine: document cinematic/ortho alias (batch 216 job 2).
- @margoengine/react and margoengine: effects-extra Stars/Sparkles attributes and seed, native Trail options and explicit target=null manual mode, Edges threshold, Decal projector/material maps and parent-space coordinates.

- @margoengine/mixer (batch 212 stereo): document Bus.insert ownership and createStereo/createBusStereo, normalized width, automation, post-send placement and disposal.

- margoengine (batch 212 stereo): document the generated mixer/stereo alias.



- @margoengine/cutscene (batch 217 job 1): document curve-editor CurveEditor/CurveModel, scalar/vector channels, normalized handles, graph dragging, clip trims, shared undo, keyboard and disposal; examples deferred.
- margoengine (batch 217 job 1): document generated cutscene/curve-editor alias.

- @margoengine/gltf (batch 200): scene-data accepts meshless camera/light and empty scenes; allowEmptyScene defaults false; clarify textured WebGL2 compatibility support and preview escalation. Add examples only in the README phase.
- @margoengine/text (batch 248 job 1): document /fit FittedText and fitText, defaults, source offsets, overflow marker, bounded auto fit and local clip including shadow.
- margoengine (batch 248 job 1): document text/fit forwarding.
- @margoengine/mixer (batch 212 stereo): document Bus.insert ownership and createStereo/createBusStereo, normalized width, automation, post-send placement and disposal.

- margoengine (batch 212 stereo): document the generated mixer/stereo alias.

- @margoengine/culling (batch 231 job 3): document depth entry, DepthPyramid lifetime/source registration, WGSL bindings and conservative same-frame sphere tests.
- @margoengine/scatter (batch 231 job 3): document OccludedScatter, live enabled, terrain/building occluders, colour/shadow separation and memory.
- margoengine (batch 231 job 3): document scatter/occlusion and culling/depth aliases.

- @margoengine/pixel (batch 244 job 1): document /follow, PixelFollow manual/attach, target/getter, per-axis lerp/dead-zone/offset/world units, bounds/undersized worlds, seeded shake, flash/fade/reset, overlay RGBA, timing, defaults and disposal.
- margoengine (batch 244 job 1): document generated pixel/follow forwarding entry.
- @margoengine/weather (batch 236 job 1): document /gltf GLTFWeather attach/add/removal, shared puddle/snow options, texture/extension composition, backend support, shader and vertex-density limits; examples deferred.
- margoengine (batch 236 job 1): document weather/gltf forwarding entry; examples deferred.
- @margoengine/mixer (batch 212 analyser): document createAnalyser/createBusAnalyser, per-channel FFT/waveform buffer reuse, live audio-clock RMS/peak/LUFS windows and reset/disposal.

- margoengine (batch 212 analyser): document generated mixer/analyser alias.
- @margoengine/compute: document /shape concatenate, stack, five pad modes, tile, flip, repeat, axes/dtypes, output ownership and empty-array behavior (batch 274 job 1).
- margoengine: document the generated compute/shape alias (batch 274 job 1).

- @margoengine/headless: document registered GIF and tile GPU correctness scripts (batch 274 landing-gate repair).
- @margoengine/rigging: document explicit bounded MToon browser case registration (batch 274 landing-gate repair).
- @margoengine/worker: document registered browser matrix correctness script (batch 274 landing-gate repair).

- @margoengine/sprites: note dynamic-port picking browser correctness check (batch 274 gate repair).

- margoengine: include the pre-existing clustered/shapes alias found missing by umbrella regeneration after the batch 274 rebase.

- @margoengine/splats: document the existing formats-check GPU script on native and compatibility backends, registered by batch 274 to repair the global plan gate.

- @margoengine/points (batch 228 job 1): document /clip volumes, renderable extraction, explicit world matrices, centre clipping, snapshot updates and polyline profile records.

- margoengine (batch 228 job 1): cover generated points/clip alias alongside the scoped optional entry.



- @margoengine/cutscene (batch 217 job 2): document viewport keyTransform/ViewportKeying, Inspector picking/gizmo setup, saved bindings, manual/auto keying, quaternion/local coordinates, undo and borrowed/owned lifetime; examples deferred.
- margoengine (batch 217 job 2): document generated cutscene/viewport alias.
- @margoengine/lod (batch 222 job 2): document /msft metadata, per-primitive coverage, defaults, hysteresis, lifecycle, node-level composition and variant-selection ownership.
- @margoengine/gltf-pro (batch 222 job 2): document setPrimitiveMaterials validation, texture refresh, later UV preparation, geometry retention, restore and progressive completion requirement.
- `@margoengine/rigging` (batch 213 job 4): document vrma read/load/play, clip selection, limits/cancellation, retarget/rest frames, playback controls, native pose-source and explicit gaze inputs, lifecycle; add runnable README examples in README phase.
- `margoengine` (batch 213 job 4): document generated rigging/vrma alias in README phase.
- @margoengine/text (batch 248 job 2): document /selection getSelectionRects, UTF-16 ranges, bidi holes, shaped carets, clipping and newline semantics.
- margoengine (batch 248 job 2): document text/selection forwarding.

- @margoengine/pixel (batch 244 job 2): document scale xbr3/xbr4 filters, edge-directed 3x/4x reconstruction, shallow/steep slopes, single-pixel and alpha preservation, fractional coverage, native-factor fallback and unchanged defaults.

- margoengine (batch 244 job 2): generated culling/depth and scatter/occlusion facades restored to generator output; existing exports retained, no new example work.

| @margoengine/cameras | panorama: capturePanorama, borrowed cubes, RGBA8/linear output, panoramaPNG, orientation, limits and AbortSignal | batch-196 job 1 |
| margoengine | cameras/panorama alias | batch-196 job 1 |

- @margoengine/scatter (batch 231 job 4): document AttributedScatter, initial batch arrays, set/getColorAt, set/getAttributeAt, attributeIndex, custom WGSL appearance contract and restoration/memory limits.
- margoengine (batch 231 job 4): document scatter/attributes alias.
- @margoengine/usdz (batch 206 job 4): previewSurface(), separate opacity textures, arbitrary numeric readers, fallbacks/interpolation, resource limits, worker and device lifetime.
- @margoengine/gltf-pro (batch 206 job 4): uploadImage external-image texture usages and caller-owned texture lifetime.
- @margoengine/text (batch 248 job 3): replace old median-reduction wording, document raw MSDF sampling, scalar fallback, MTSDF alpha, RGBA atlas/memory and lazy PNG decoder dependency; no examples written in build phase.
- @margoengine/mixer (batch 212 fx): document JSON FXSpec variants, defaults, createFX/createFXChain/createBusFX, automation, ownership, wet endpoints, delay interpolation, sample/bit reduction and native oversampling.

- margoengine (batch 212 fx): document the generated mixer/fx alias.


- @margoengine/transitions (batch 218 job 3): document /glsl, translation/frozen/live factories, GLSL ES 1.00 signature, uniform defaults/shapes, UV convention, parser limits, diagnostics, cancellation and trusted shader execution; examples deferred.
- margoengine (batch 218 job 3): document transitions/glsl forwarding entry; examples deferred.

- @margoengine/pixel (batch 244 job 3): document CRT colorBleed, chromaticOffset and independent red/green/blue offsets, scalar/tuple source-pixel units and signs, fractional sampling, alpha/gamut behavior, defaults and stylized baseband limits; README examples deferred.



- @margoengine/splats and margoengine (batch 238 job 3): document /lod-sog loadStreamedSog/StreamedSogSource, lazy ranges, metadata/cache/abort/disposal defaults, environment, structural-node budget and SOG v3 degree-4/extended-opacity read/write limits.

| @margoengine/lightmap | apply: applyLightmap on a materials mesh, a glTF-pro model, a core mesh (uv1) and a live GPULightmapBaker; lightmapTexture; dispose | batch-54 job 3 |

| @margoengine/cameras | stereo: StereoRig, StereoOutput.render in an app loop, four modes, geometry, layers, swap, stripe parity, disposal and resize behaviour | batch-196 job 2 |
| margoengine | cameras/stereo alias | batch-196 job 2 |

- @margoengine/text (batch 248 job 4): document /curve CurvedText, signed radius, subdivisions, unwrapped caret coordinates, PathText frames/offset/closure, update and lifecycle.
- margoengine (batch 248 job 4): document text/curve forwarding.
- @margoengine/mixer (batch 212 dynamics): document gate hysteresis/hold/floor, expanderCurve/range, LR4 phase compensation, per-band settings, envelope direction, createBusDynamics ownership and peak safety.

- margoengine (batch 212 dynamics): document generated mixer/dynamics alias.
- @margoengine/sciviz (batch 173 job 1): document /transfer physical units, rectangle/triangle/Gaussian widgets, modality presets, histogram, editor/binding lifetimes, existing-volume LUT updates, preintegration and its step/density assumptions; examples deferred.
- margoengine (batch 173 job 1): document optional sciviz/transfer alias after build phase.



- @margoengine/voxel-pathtracer (batch 243 job 3): document clearcoat, sheen, iridescence and specular factors/maps, independent coat normal, energy layering and loaded glTF snapshots; defer examples by rule 20.
- @margoengine/gltf-pro (batch 243 job 3): thin-film text now shares the same internal implementation with mesh-pbr; public raster behavior is unchanged and README work is deferred by rule 20.

- @margoengine/materials (batch 243 job 3): thin-film verification now reads the actual unchanged shared shader export; README review remains deferred by rule 20.

- @margoengine/weather (batch 236 job 3): document /lens LensDrops in PostStack, refraction/streaks, wetness source, time/seed determinism, defaults and optical/half-float tier limits; examples deferred.
- margoengine (batch 236 job 3): document weather/lens forwarding entry; examples deferred.
- @margoengine/mixer (batch 212 pitch): document createPitchShift/createBusPitchShift, semitones/audio-clock automation, window/delay/feedback/wet defaults, bounded wet delay/tail, unison identity and alias/formant limits.

- margoengine (batch 212 pitch): document generated mixer/pitch alias.


- @margoengine/voxel-edit (batch 241 job 1): document /generate image channels, rounding, palette reduction and image axes, and font loading, text extrusion, Canvas context ownership, budgets, abort and platform rasterization differences; README examples deferred.
- margoengine (batch 241 job 1): document the generated voxel-edit/generate alias alongside the optional package entry; README examples deferred.

| @margoengine/clustered | stochastic: StochasticLights (samples, temporal, quad), MAX_STOCHASTIC_SAMPLES, Clustered.stochastic hook, needs LocalShadows or integrated shadows | batch-52 job 8 |
| margoengine | clustered/stochastic alias | batch-52 job 8 |


- @margoengine/react (batch 266 job 3): document /test createTestRenderer, DOM/jsdom setup, null-stage ownership, frame/query/pointer helpers, and /offscreen main-thread React plus shared-scene URL, worker/page fallback, startup props and cleanup; examples deferred.
- margoengine (batch 266 job 3): document generated react/test and react/offscreen aliases; examples deferred.

- @margoengine/kinematics-constraints (batch 214 job 1): document /chain, CCD/FABRIK settings, failure ownership, query protocol, static-only guarantee and createLimbAvoidance.
- @margoengine/animator (batch 214 job 1): document FullBodyLimb.avoidance, clear result and atomic whole-body rollback.
- margoengine (batch 214 job 1): document kinematics-constraints/chain alias.

- @margoengine/splats and margoengine (batch 238 job 4): document /modify async create/attach, position/opacity/color WGSL bodies, helper declarations, 64 live floats, seek/clock defaults, canonical setRest, abort, single ownership, SH/fog/relighting order and restore/disposal semantics; examples remain owed.



- @margoengine/cutscene (batch 217 job 4): document nested-editor registration, discrete step state/extras, inline local/global playheads, shared definitions/history, TimelineModel.nested/setTimeline, passing a model to TimelineEditor, key forms and cleanup; examples deferred.
- margoengine (batch 217 job 4): document generated cutscene/nested-editor alias.

- @margoengine/voxel-edit and margoengine (batch 241 job 2): document /select NDC conversion, cell-centre boundary rules, lasso parity, select-through/visibleOnly, model placement, normalized RGBA similarity, sparse indexes and budgets; README examples deferred.

- @margoengine/text (batch 248 job 5): replace old CFF2/variation/shaping exclusion; document variations, axes, withVariations, shapedRuns em normalization/UTF-16 clusters/line order, FontLike providers, parser limits and dependency-free frozen oracle tests. No README examples written in build phase.
- @margoengine/voxel (batch 240 job 1): document /models definition, 24 orientations, face UVs/textures, renderer ordering and optional materials peer, exact queries/physics and lighting coverage; runnable examples owed in the README phase.
- margoengine (batch 240 job 1): document the voxel/models umbrella entry alongside the optional package in the README phase.
- `@margoengine/rigging` (batch 213 job 5): document pose-tracking body/hand solvers, Tasks/Holistic frames, coordinate/mirror/aspect conventions, confidence/calibration/smoothing/loss, native VRM binding/cancellation/disposal and root-motion limits; runnable README examples wait for README phase.
- `margoengine` (batch 213 job 5): document the generated rigging/pose-tracking alias in README phase.
- @margoengine/water and margoengine (batch 235 job 1): cover /ripples attachment, drops, swept boat/character wakes, camera following, query/capture composition, defaults, limits, cancellation and disposal; examples deferred.
- @margoengine/lod (batch 222 job 3): document static/animated imposter LODFade, native/full compatibility, reverse/null/interrupted transitions, sequence ownership and target-only shadows/masks; examples deferred.



- @margoengine/viewcube (batch 198 job 1): document /up UpViewCube, up/front defaults, widget tuple directions, world home poses, frame conversion, pole and control conventions.
- margoengine (batch 198 job 1): document viewcube/up forwarding.
- @margoengine/cameras (batch 198 job 1): document that pole detection follows camera world up and that projection.up must be nonparallel to the view axis.
- @margoengine/gltf-pro (batch 201 job 1): document automatic async spec/gloss loading, explicit synchronous specGlossMaterials, the linear CPU conversion helper, independent texture UVs/transforms and the metal/rough approximation limits; add runnable examples in the README phase.
- margoengine (batch 201 job 1): include the generated gltf-pro/spec-gloss alias in import guidance during the README phase.


- @margoengine/voxel-net: document /rooms VoxelLobby creation, room lists and join codes, reserved capacity, signed shard ticket URLs, authentication identities, joinOrCreate and async disposal.

- margoengine: document generated voxel-net/rooms alias alongside the owning optional entry.

- @margoengine/kinematics-constraints (batch 214 job 2): document /joint-limits, JointLimitSet, local/rest-relative rotations, Euler order, hinge/cone bounds, jointLimitPredicate and SolveOptions.acceptPose.
- margoengine (batch 214 job 2): document kinematics-constraints/joint-limits alias.
- @margoengine/video (batch 269 job 2): document /dome videoDomeMaterial, mono/side-by-side/top-bottom, eye, 180/360 angles, sphere orientation, black rear, half-texel borders, source ownership and compat; point ordinary map/repeat/mips users to materials.Texture. Examples deferred.
- margoengine (batch 269 job 2): document generated video/dome alias; examples deferred.

- @margoengine/sciviz (batch 173 job 2): document labels entry, fusionVolume registered sources, exact category palettes/outlines and legend, RGB/RGBA scale, component functions/weights, three mixing rules, snapshot/rebuild semantics and texture/step limits; add copy-paste examples in the README phase.
- margoengine (batch 173 job 2): document sciviz/labels alias in the README phase.


- @margoengine/decoders: document /jpeg baseline and progressive RGBA8 decoding, /image JPEG dispatch, maxPixels and worker use.
- @margoengine/exporters: document jpeg-read sharing the decoder implementation with unchanged API.
- margoengine: expose the generated decoders/jpeg optional facade in the decoder index.

- @margoengine/voxel (batch 240 job 2): document /objects, core/glTF graph sources, cell-centre origin, quarter turns, shared ownership, retained handles and streaming; runnable README examples owed in the README phase.

- @margoengine/voxel-net: document /replay VoxelRecorder, recordVoxelFile/readVoxelRecording, recipient selection, forward tick stepping, cancellable play, file bounds/ownership and server.onSend observation.

- margoengine: document the generated voxel-net/replay alias.
- @margoengine/usdz (batch 206 job 5): valueClips(), composition provenance, manifests/retiming/templates, async frame iteration/player, topology replacement, serial requests, cancellation and byte-bounded encoded cache.
- @margoengine/vfx (batch 270 job 1): document /space, local/world rigid transforms, position frame, inherited velocity, distance births and reset/restoration; examples deferred.
- margoengine (batch 270 job 1): document generated vfx/space alias; examples deferred.

- @margoengine/water and margoengine (batch 235 job 2): cover /flow painted/generated providers, encoded versus signed RG, two normal maps or procedural detail, world region, speed/period/scale/defaults, setTime, borrowed lifetimes and restoration; examples deferred.



- @margoengine/toon (batch 194 job 2): document /screen-outline pixel Toon and ModelOutlines, physical pixel units, defaults/ranges, live model styles, per-view projection and hull limits; README examples deferred.
- margoengine (batch 194 job 2): document generated toon/screen-outline alias; README examples deferred.
- @margoengine/shader (batch 185 job 2): compute-volume 3D/array load/store, coordinates, formats, ping-pong, device limits and lifecycle; document existing full WebGL2 graph support.
- margoengine (batch 185 job 2): generated shader/compute-volume alias.


- @margoengine/voxel-net: document /webrtc accept/connect, two-channel configuration, setup before SDP/ICE, server RTC provider, timeout/abort, reliable/datagram routing and peer disposal.

- margoengine: document generated voxel-net/webrtc alias.
- @margoengine/vfx (batch 270 job 2): document /over-life, sampled spin/speed/growth/limit defaults, force composition, zero recovery, local-frame interaction, memory and replay; examples deferred.
- margoengine (batch 270 job 2): document generated vfx/over-life alias; examples deferred.

- @margoengine/tonemap: document optional HueGrade, degree units, circular hueHue points, live Grade controls and display-linear/HDR limits (batch 193 job 1).
- margoengine: expose tonemap/hue in the optional entry index (batch 193 job 1).

- @margoengine/creative and margoengine (batch 271 job 2): document /planet-atmosphere OrbitAtmosphere defaults, world/km conversion, sky peer, physical background vs textured Planet surface, depth, restoration, observer/medium limits and both GPU backends; examples deferred.
- @margoengine/video (batch 269 job 3): document /demux openDemuxedVideo, complete fragment+init input, AVC fragments, WebM VP8/VP9/AV1, buffered index/GOP memory, exact seek/step, signals, frame closure and unsupported encryption/transforms; examples deferred.
- margoengine (batch 269 job 3): document video/demux alias; examples deferred.


- @margoengine/decoders: document /zstd decompressZstd and /lz4 decodeLZ4/decodeLZ4Block, byte-buffer stream input, limits, cancellation, checksums and external dictionaries.
- margoengine: document generated decoders/zstd and decoders/lz4 optional facades.



- @margoengine/viewcube (batch 198 job 2): document /fit FitViewCube, live world AABBs, padding/aspect defaults, transition envelopes, ortho zoom, Home and projection semantics, clipping and manual drag behavior.
- margoengine (batch 198 job 2): document viewcube/fit forwarding.
- @margoengine/vfx (batch 270 job 3): document /shapes as an emitter superset, all five shape defaults, shell/volume semantics, normals, grid replacement, torus restrictions and birth statistics; examples deferred.
- margoengine (batch 270 job 3): document generated vfx/shapes alias; examples deferred.
- @margoengine/shader (batch 185 job 3): PassNodeEditor post/compute modes, named resources, save/load, input labels, caller-owned hot reload and bounded expression limits; graph input/presentation hooks.
- margoengine (batch 185 job 3): generated shader/editor-pass alias.
- @margoengine/post: document selective-bloom mask ownership, ordering, inverted/background selection, HDR stack composition and disposal.



- @margoengine/tonemap: document exportCube, saving .cube text, size/title defaults, display-linear domain, HueGrade coverage, avoiding double grading and finite-grid error (batch 193 job 2).
- margoengine: expose tonemap/export-cube in the optional entry index (batch 193 job 2).


- @margoengine/toon (batch 194 job 3): document /hatch-models ModelHatching, shared live controls, material/glTF attachment, linear ink, primary-sun tone, adapter ownership, disposal, tiers and display-hook limits; examples deferred.
- @margoengine/gltf-pro (batch 194 job 3): document synchronous material-draw layer encoding under PBRDrawRun and the per-layer batch boundary; examples deferred.
- margoengine (batch 194 job 3): document generated toon/hatch-models alias; examples deferred.



- @margoengine/sciviz (batch 173 job 3): document cinematicVolume, independent default-off lighting modes, HG/radiance/step/sample defaults, camera-rest resets, scene metric, exact cost readback, disposal/source sharing, limits and real EMDB/TCIA demo; examples in README phase.
- margoengine (batch 173 job 3): document optional sciviz/cinematic alias in README phase.

- @margoengine/voxel-net: document /server-runtimes Bun/Deno factories, native listener ownership, AbortSignal/await using, authentication facade, TLS types, shared test:runtimes command and Deno idle input requirement.

- margoengine: document generated voxel-net/server-runtimes alias.


- @margoengine/creative and margoengine (batch 271 job 3): document /grass-terrain async factory, scatter peer, segmented default blade, height/density and world colour rasters, seed/LOD/wind defaults, sphere interaction/recovery, abort and restoration; examples deferred.
- @margoengine/video (batch 269 job 4): document /playback prepareVideo, muted inline/autoplay defaults, native poster, ready vs started, owned/custom fallback, play gesture, timeout, errors, abort and source/stream ownership; examples deferred.
- margoengine (batch 269 job 4): document video/playback alias; examples deferred.


- @margoengine/viewcube (batch 198 job 3): document /compass ViewCompass attachment, north/radian defaults, cardinal clicks/drag, keyboard menu actions, fit callback and adapter fallback, visibility/themes, reserved margins, cleanup and pole limitation.
- margoengine (batch 198 job 3): document viewcube/compass forwarding.
- @margoengine/water, @margoengine/environment and margoengine (batch 235 job 3): cover water/reflector capture binding, horizontal alignment, environment captureOnly/textureMatrix, source filtering, manual update versus engine.start, fallback/SSR/defaults/limits and borrowed-resource disposal; examples deferred.
- @margoengine/vfx (batch 270 job 4): document /schedule, prewarm step/tail/submission semantics, time-zero/cycle/probability bursts, seed, immutable attachment settings and reset/restoration; examples deferred.
- margoengine (batch 270 job 4): document generated vfx/schedule alias; examples deferred.

- @margoengine/voxel-edit (batch 241 job 3): document formats-extra KV6/CUB/VMAX readers, basis/pivots, VMAX hierarchy/gridToWorld, palette/material preservation, all defaults and bounded loading; add examples in the README phase.
- @margoengine/decoders (batch 241 job 3): document optional lzfse decodeLZFSE, all block kinds, maxBytes and AbortSignal; add examples in the README phase.
- margoengine (batch 241 job 3): document generated voxel-edit/formats-extra and decoders/lzfse aliases during the README phase.
- @margoengine/shader (batch 185 job 4): textureArray source/layer/UV/level, all hosts, one binding pair, native/compatibility paths and codec restoration.
- margoengine (batch 185 job 4): generated shader/texture-array alias.
- @margoengine/post: document EffectMask ownership, external object-mask callbacks and ordering, coverage/id/inversion/opacity, output masking versus SelectiveBloom source masking, and custom effects.
- materials: document transmission-layers explicit background list, sorted/weighted modes, caller-owned OIT at order 2.95, HDR requirement, disposal and model grouping limits.
- margoengine: document the generated materials/transmission-layers optional alias.

- materials: explain that compressed KTX2 used as both colour and data needs two cached direct uploads on WebGL2 compatibility, with native one-copy behaviour retained.

- @margoengine/kinematics-constraints (batch 214 job 3): document /multi-goal MultiGoalIKSolver, joint forests and rest frames, simultaneous weighted/masked goals, point/full-pose closures, scalar bounds and DOF composition, warm starts, physical error/status outputs, cancellation and bounded-search limits.
- margoengine (batch 214 job 3): document generated kinematics-constraints/multi-goal forwarding.

- @margoengine/creative and margoengine (batch 271 job 4): document /paint-aniso AnisotropicPainterly defaults, LDR ordering, tensor/elliptical sector controls, smooth radial support, 32 B/pixel intermediate budget, exact bypass/alpha, views and both GPU backends; examples deferred.

- @margoengine/voxel (batch 240 job 3): document /wind per-block definitions, direction/clock controls, rooting, liquid seams, bounds, mesher/shadow integration and ownership; runnable README examples owed in the README phase.

- margoengine (batch 240 job 2): document the voxel/objects alias in the README phase.
- margoengine (batch 240 job 3): document the voxel/wind alias in the README phase.
- @margoengine/taa (batch 192): document /upscale-velocity, TAAUpscaleVelocity options/defaults, per-view targets and scissor, custom sources, reset/disposal/restoration, transparent limits, velocity.expectedDepth and TAA.reset(viewId); examples deferred.
- margoengine (batch 192): document generated taa/upscale-velocity alias; examples deferred.

- @margoengine/post: document Pixelate defaults, LDR stack order, pixel-size/edge controls, optional model normal capture, supplied normal textures and disposal.
- @margoengine/vfx (batch 270 job 5): document /json format/version, serialize/parse/create/load, typed assets and signed zero, explicit resource binding ownership, fog, validation budgets, AbortSignal and authoring-state scope; examples deferred.
- margoengine (batch 270 job 5): document generated vfx/json alias; examples deferred.

- @margoengine/staging (batch 272 job 1): document pathtrace-materials TexturedStill, glTF snapshots, maps/cutouts, idle lifecycle, captures, compatibility and static-scene limits; examples deferred.
- margoengine (batch 272 job 1): document generated staging/pathtrace-materials alias; examples deferred.


- @margoengine/sky (batch 189): document /compat-clouds shared plugin/type exports, explicit full-layer installation before Engine.create, native/compat behaviour, preview refusal, unchanged defaults and ownership; README examples deferred.
- margoengine (batch 189): document generated sky/compat-clouds alias and the incoming post/pixelate alias; README examples deferred.
- @margoengine/compute/decomp: document solve, inv, det, cholesky, reduced/full qr/svd, eigh/eigvalsh, batches/broadcast RHS, async signal, owned f32 factors, lazy SIMD Wasm limits and GPU readback route; add runnable examples after the build phase.
- margoengine/compute/decomp: document the generated optional decomposition alias after the build phase.
- @margoengine/cameras and @margoengine/weather: document the panorama/parity browser-suite commands after the build phase (batch 274 landing registration repair).
- @margoengine/splats and @margoengine/voxel-edit: document lod-sog and font-mask browser suite commands after the build phase (batch 274 registration repair).
- @margoengine/water: retain the GPU command with its build first when documenting test commands after the build phase.
- @margoengine/vfx: document the existing parity GPU suite command after the build phase (batch 274 registration repair).
- @margoengine/creative: document grass-terrain, orbit-atmosphere and paint-aniso GPU suite commands after the build phase (batch 274 registration repair).
- @margoengine/kinematics-constraints: document the existing multi-goal GPU suite after the build phase (batch 274 registration repair).
- @margoengine/vfx (batch 270 GPU registration): document the recurring --all parity coverage within test:gpu; examples remain deferred.



- @margoengine/environment (batch 188 job 2): document /prefiltered save/load, KTX2 metadata, upload-only restore, cancellation, cube background mode and paused dynamic capture; correct the stale multiple-scattering limit when README work resumes.
- materials: document fur/FurMaterial/createFur controls and defaults, shared textures, explicit setTime, atomic setOptions, shell-root parenting, caster support, two-shell sampling and integration limits.
- margoengine: document the generated materials/fur alias and post/mask mapping repair.
- @margoengine/post: document Halftone and DotScreen, four shapes, degree angles, pixel origin, frequency, RGB/grayscale, scatter/blend/intensity and LDR ordering.

- @margoengine/staging (batch 272 job 2): cover accumulate-ambient weighted disk lights, ambient sky share, normalized visibility, slab/footprint limits, live edits and convergence; examples deferred.
- margoengine (batch 272 job 2): cover staging/accumulate-ambient and regenerated post/pixelate forwarding; examples deferred.


- @margoengine/sciviz (batch 173 job 4): document volume-quality defaults, block/opacity bounds, blue-noise provenance, adaptive/isosurface limits, invalidate(), exact scene-depth termination, source sharing, 56 B cinematic depth/count history and saturated-frame cost semantics; replace the old opaque-interior limitation during the README phase.
- margoengine (batch 173 job 4): document optional sciviz/volume-quality alias in the README phase.

- @margoengine/quality and margoengine (batch 195 job 1): document /demand renderOnDemand, source events, update replacing onFrame, invalidate coalescing/counts, animation holds, loaded, idle clock, restore and disposal defaults; examples deferred.

- @margoengine/vfx (batch 195 blocking manifest repair): recurring GPU command retains all parity cases; no public API/example change, README examples remain deferred.
- @margoengine/vfx (batch 270 manifest correction): document separate test:gpu and test:gpu:parity commands and automatic CI discovery without duplicate execution; examples deferred.
- @margoengine/post: document Stylize controls, explode and world/screen epicentres, explicit clocks, RGB bit counts, deterministic noise, scanline scrolling and LDR order.



- @margoengine/quality and margoengine (batch 195 job 3): document /events adaptiveEvents run/regress/setMoving/flush, finite and Infinity policies, defaults, coalesced promises, async nonoverlap, direct clicks, source events and owner AbortSignal; examples deferred.

- @margoengine/gltf-pro (batch 201 job 2): document automatic MSFT_texture_dds loading, ddsTextures/decodeDDSImage, mip retention, native and HDR/signed fallback, and 2D/float32 feature limits.
- @margoengine/decoders (batch 201 job 2): document decodeBCFloat and its signed/HDR-preserving RGBA output alongside decodeBC.

- @margoengine/gltf-pro (assigned batch-273 overflow): explain packed base-map arrays for full physical/large extended permutations, independent filters and mips, float storage cost and stream viewSize metadata.

- @margoengine/vfx (batch 201 landing blocker): manifest duplicate-script repair only; retained the complete existing GPU command, no README example change owed.

- margoengine (batch 201): expose DDS/audio aliases in the eventual loader coverage; regenerated existing main prefiltered/halftone aliases, no README examples edited.

- @margoengine/decoders: document /ktx2-hdr6, its clean-room assets, browser and Node workers, targets, limits, cancellation, transfer and GPU upload.


- margoengine: document the generated decoders/ktx2-hdr6 alias and retain the environment/prefiltered alias emitted by the umbrella generator.

- @margoengine/sciviz and margoengine/sciviz/contour2d (batch 177 job 1): grid and scattered contours, saddle ties, polygon bands/holes, inline labels, SVG options/defaults, cancellation, climate demo and limits.


- @margoengine/environment (batch 188 job 3): document /reflector-pbr, Fresnel/IOR/metalness/baseColor, roughness and world blurDistance, geometric-normal and constant-base limits, capture lifecycle and supported backends.
- @margoengine/vfx (batch 188 manifest repair): describe the complete recurring parity GPU gate and its native/full-compatibility cases; no API changed.
- @margoengine/weather and margoengine forwarding (batch 236 job 2): document /cover PrecipitationCover.attach with an unattached WeatherFX, GLTFWeather cover option, bias, map area and edge limits; examples deferred.

- @margoengine/staging (batch 272 job 3): cover ProductCaustics source snapshots, glass/water IOR, point/directional lights, floor/frame/photon controls, update/readMap/restore and transport limitations; examples deferred.
- margoengine (batch 272 job 3): document staging/caustics forwarding; examples deferred.

- margoengine: retain canonical package-group and entry order when maintaining generated aliases; this repair adds no API.
- @margoengine/sciviz (batch 174 job 1): document SelectionStore, bindSelection, row/group keys, resolve/empty semantics, modifier operations, events, history, mask ownership, disposal and the real-data linked stars demo in the README phase.
- margoengine (batch 174 job 1): document generated sciviz/link alias in the README phase.
- @margoengine/vfx (batch 174 landing repair): no API change; retain documentation of the recurring GPU parity command during the README phase.

- @margoengine/clustered (batch 186 job 2): document ShadowAtlas, camera-driven point/spot resolution, shared directional/area maps, square guarded tiles, budgets, defaults and full-atlas redraw policy; examples deferred.
- margoengine (batch 186 job 2): document clustered/shadow-atlas forwarding entry; examples deferred.


- @margoengine/exporters (batch 136): document the clean-room lazy Draco SIMD encoder, sequential and EdgeBreaker modes, speed budgets, quantization and prediction, preserved custom encoderPath compatibility, and input limits during the README phase.
- @margoengine/post: document Curvature ridge/valley controls, screen-space units, depth rejection, owned/model normals, world/view inputs, normal-provider setup and disposal.



- @margoengine/sciviz (batch 178 job 1): document /export-vector, scene/layer snapshots, BSP ordering, colour facets, explicit raster fallback, budgets and appearance limits; examples deferred.
- margoengine (batch 178 job 1): document generated sciviz/export-vector and post/curvature aliases; examples deferred.

- @margoengine/staging (batch 272 job 4): document Backdrop/backdropGeometry dimensions, mesh orientation/material/ownership and stagingLights/stagingLighting presets, forwarded environment options/cancellation and limitations; examples deferred.
- margoengine (batch 272 job 4): document staging/backdrop forwarding; examples deferred.
- @margoengine/sciviz (batch 176 job 1): document /datasets constructors, normalized DataSet filter contract, composites and common arrays, higher-order refinement, face-stream limits, VTK/PLOT3D readers, options, cancellation and the real NASA example; add runnable examples after the build phase.
- @margoengine/loaders (batch 176 job 1): document lazy VTKXMLPiece coordinates and topology metadata, RectilinearGrid support and unnamed coordinate axis order after the build phase.
- margoengine (batch 176 job 1): document generated sciviz/datasets forwarding after the build phase.
- @margoengine/cutscene (batch 217 job 3): document scroll RangePlayback/ScrollPlayback, ranges/directions/iteration counts, update ownership, event endpoints, cancellation, scrub defaults, source bounds and disposal; examples deferred.
- margoengine (batch 217 job 3): document generated cutscene/scroll alias.

- @margoengine/sciviz and margoengine/sciviz/stats (batch 177 job 2): all statistical charts, /maths exports, confidence/robustness assumptions, defaults, missing values and real GHCN/NASA vector demo.
- @margoengine/sciviz (batch 175 job 1): document /omezarr cloud stores, OME 0.4/0.5, N5/precomputed, stored-level sources, bounds/ranges, codec refusals, Range reads, cancellation and the three recorded scientific crops; examples deferred.
- margoengine (batch 175 job 1): document generated sciviz/omezarr alias; examples deferred.

- @margoengine/compute (batch 274 job 3): document compute/cpu-wasm creation, AbortSignal, disposal, work counters, supported built-ins, host Math semantics, chunk/memory bounds and the separate lazy SIMD asset; add its example in the README phase.

- @margoengine/decoders (batch 274 job 3 gate registration): list the existing HDR6 worker/GPU readback driver registered in test:browser:hdr6.

- margoengine (batch 274 job 3): document the generated compute/cpu-wasm subpath and main's environment/reflector-pbr subpath in the README phase.

- @margoengine/quality (batch 195 job 2): document /knobs live raster/target bindings, particle rate ladder, disposal/device restore and deferred MSAA prepare then Engine.create with no live hardware-change claim.
- margoengine (batch 195 job 2): document generated quality/knobs alias in the README phase.


- @margoengine/environment (batch 188 job 4): document /exr-codecs decodeEXR/loadEXR, supported codecs, Node/browser workers, data windows and layer selection, limits/cancellation, emitted assets/CSP and the standard prebuilt decoder provenance; root parseEXR remains the small loader.

- @margoengine/gltf-pro (batch 201 job 3): document applyGLTFAudio, both draft dialects, caller-owned listener, weighted/event sync controls, audio-only scenes, budgets, cancellation and optional audio peer.
- margoengine (batch 201 job 3): include the gltf-pro/audio alias in loader coverage after the build phase.
- @margoengine/audio (batch 201 inherited documentation): panningModel defaults to HRTF in code; reconcile the stale equalpower type comment during the documentation phase.


- @margoengine/exporters (batch 136 proof): document the four-setting corpus, prediction-degree and circular-normal candidate selection, bounded RAW alphabet and scoped no-worse ratio/error evidence during the README phase.
- @margoengine/sciviz: document /curvilinear, structured and spherical node order/units/seams, shared source classifiers, physical referenceStep, index slices/outlines, masking, lifecycle, NOAA demo and accuracy limits.

- margoengine: document generated /sciviz/curvilinear alias alongside the optional scientific volume entries.
- @margoengine/clustered (batch 186 job 3): document CubeProjectorLights, six-face order/orientation, setCubes plus inherited spot setProjectors, quaternion rotation, sRGB/linear/alpha filtering, limits, restoration and copied pixels; examples deferred.
- margoengine (batch 186 job 3): document clustered/cube-projector forwarding entry; examples deferred.




- @margoengine/sciviz (batch 180 job 1): document geo-lod, selection/cache/fades, terrain stream and quantized height adapters, cancellation, errors, provider attribution and real AWS demo; margoengine generated geo-lod alias.
- @margoengine/sciviz (batch 181 job 1): document createFallbackFigure from /fallback, page-wide explicit WebGL2 installation, full-tier requirements, same-case CPU isosurfaces, ownership/cancellation/restore and ?backend=webgl2 for the three real-data demos; examples deferred.

- @margoengine/ui (review 2): describe Select popup ownership when closing and reopening within one turn, including disposal of the current popup.

- @margoengine/exporters (batch 136 removal): remove obsolete bundled-Draco-encoder instructions and document the owned lazy artifact and external custom encoderPath compatibility during the README phase.
- Tooling (API lock Day 0): document report coverage, locked/watch rollout and one-shot approved breaks in the README phase; examples deferred.
- @margoengine/sciviz (batch 177 job 3): document /charts-extra families, own scales/layouts, SVG exports, data conventions, bounds and NOAA/EIA demo; copy-paste examples owed in README phase.
- margoengine (batch 177 job 3): document sciviz/charts-extra optional alias in README phase.

- @margoengine/compute (batch 274 job 4): document /nn-extra, all defaults/layouts, train/eval and nested normalization state, grouped transpose/output size, recurrent run states/lengths/gradients, upsampling modes/coordinates, and table/tape storage. Add examples only in the README phase.

- margoengine (batch 274 job 4): document the generated compute/nn-extra subpath in the README phase.
- @margoengine/webgl2-compat (batch 271 job 1 fix): note that a 3D texture slice drawn beside a depth or stencil attachment goes through a 2D stand-in (two blits per such pass; ANGLE Direct3D 11 drops those draws otherwise).
- @margoengine/creative and margoengine (batch 271 job 1): document /targets-depth DepthTextureRenderTarget depth options and defaults, reversed-Z clear, 4x resolve (volume scratch copy), depthTexture(), generateMipmaps after mip 0, 256 MiB cap, restore and both GPU backends; examples deferred.
- margoengine (batch 1 job 2): document the package-local npm test command and complete tests/*.test.js discovery; README examples deferred.


- @margoengine/sprites (review 2): clarify that remove removes individually added meshes; removeSkeleton owns slot attachment removal.



- @margoengine/sciviz (batch 174 job 2): table readers, physical types/nulls, indexed range/set filters, GPU/CPU aggregates, linked chart binding, TLC demo and format/numerical limits.
- @margoengine/decoders (batch 174 job 2): raw Snappy and bounded lazy columnar block codecs, cancellation and decoded-size limits.
- @margoengine/sciviz (batch 178 job 2): document /pdf and /math, caller-owned font coverage, metadata/physical sizing, TeX subset, native MathML and shared PNG/SVG/PDF formula overlays, disposal and accepted layout differences; examples deferred.
- margoengine (batch 178 job 2): document generated sciviz/math and sciviz/pdf aliases; examples deferred.

- @margoengine/tiles (review 2): document feature decorator cancellation/disposal during preceding decoration and asynchronous feature image decoding.

- @margoengine/sciviz (batch 176 job 2): document /hdf5 lazy lifetime/hyperslabs, /cgns and /xdmf resource and solution selection, /exodus time/results/entity sets, /openfoam mesh/field/patch loading, /ensight parts/times, source formats and explicit limits; runnable examples deferred to the README phase.
- margoengine (batch 176 job 2): document generated sciviz engineering entry forwarding; examples deferred.
- @margoengine/stage (batch 183 job 1): document the PBR addGLTF path, optional pbr/animation handles, paused clips, deformation, WebGL2 compatibility device, cleanup and bind-pose fitting; replace the basic-loader description in the README phase.
- @margoengine/shadows (batch 183 job 1): document automatic cascade distance for static PBR meshes and conservative bounds fallback for deformation, custom shading, displacement and instances.
- @margoengine/clustered (review 4): cover cube cookies combined with stochastic shadows and their shared lighting-group ownership; README examples deferred.
- @margoengine/clustered (review 4 LTC blocker): explain the owned edge-angle accuracy path and its unchanged shaped-light validation bounds during the README phase.


- @margoengine/cutscene (review 3 C1): document graph channel reconciliation on undo/redo and fallback after track removal.

- @margoengine/loaders (review 2): clarify the standard VTK type-13 wedge ordering and outward XML/legacy surface winding; examples deferred.

- @margoengine/selection (review 2): describe per-axis CSS/backing-size fallback for SpatialPicking.ray on headless, detached and worker canvases; examples deferred.

- @margoengine/exporters (review 2): describe optimize-extra pruning of off-scene animation targets, transform ancestors and their skin/joint dependencies; examples deferred.



- @margoengine/sciviz: pointcloud async factory/openPointCloud, source origins, global attribute maps, point/cache budgets, attribute hover, rectangle/lasso and open SelectionStore universes. Browser suites use browser-root from npm workspaces.
- @margoengine/points: OctreeNodeData typed attributes/rowIds, MemoryOctree column preservation and COPC attributes.
- margoengine: generated sciviz/pointcloud alias and synchronized environment/exr-codecs alias.
- @margoengine/tilemap (review 4): describe Wang weights as finite nonnegative relative values, zero exclusions and deterministic normalized selection; README examples deferred.
- @margoengine/sciviz (batch 177 job 4): document /format ChartPolish lifecycle, normalized vs original coordinates, supported existing traces, secondary/broken/inset axes, hover and controller SVG; /categorical bands/jitter/RGB/clustering and limits; Figure axis chrome/mappings/rectangle integration APIs. README examples owed.
- margoengine (batch 177 job 4): document optional sciviz/format and sciviz/categorical aliases in README phase.



- @margoengine/animation: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/cameras: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/cutscene: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/labels: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/lightmap: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/materials: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/mcp: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/scene: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/tiles: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/usdz: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/voxel: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/weather: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/worker: document the API conventions lifecycle repair, attachment ownership and disposal.

- @margoengine/sciviz: retain the common browser-root launcher for the engineering and pointcloud fixtures when documenting package test commands.
- @margoengine/sciviz: document /tetvolume, conforming VTK tetrahedra, opposite-vertex adjacency, point/cell scalars, referenceStep and unit scaling, shared source controls, clipping/depth, immutable masks, lifecycle, accuracy and the declared NASA 2D extension.
- margoengine: document the generated /sciviz/tetvolume alias in the scientific-volume section.

- @margoengine/sciviz (batch 174 job 3): parcoords/matrix creation, shared row keys/scales, reorder/flip/axis and cell brushes, exact pixel density and its CPU/compatibility route, limits, disposal and the 2d CustomLayer declaration.



- @margoengine/sciviz (batch 181 job 2): document /monitor, installFigureStats/fig.stats, live allocation semantics, custom/table adapters, cancellation, versioned JSON sweeps and deferred timings; README examples deferred.
- @margoengine/points (batch 181 job 2): explain the internal per-cloud inventory used by sciviz/monitor, lazy GPU allocation and release; README examples deferred.
- @margoengine/lines (batch 181 job 2): explain the internal per-line inventory used by sciviz/monitor, retained capacity and release; README examples deferred.
- @margoengine/sciviz and margoengine/sciviz/geo-vector: Batch 180 job 2: lazy GeoJSON/TopoJSON/MVT parsing, joins, labels, arcs, projected bins and flat/globe layers, budgets/cancellation and restore. Demo examples/sciviz-geo-vector.html. No README examples written in the build phase.
- @margoengine/stage (batch 183 job 2): cover stage/lights definitions, defaults/units, shared ownership, automatic and manual receivers, cancellation, disposal and the native/compatibility device requirement.
- @margoengine/clustered (batch 183 job 2): document hasReceiver and its false-after-removal/disposal contract.
- margoengine (batch 183 job 2): document the generated stage/lights alias during the README phase.

- @margoengine/gltf-pro (review 4): cover independent non-mip min/mag filtering on ordinary and packed physical textures and unchanged native interpolation differences; examples deferred.
- margoengine (batch 180 integration): cover the generated sciviz/monitor alias with its owning monitor entry in the README phase; no README example work now.

- @margoengine/sciviz: document /spec factories, async state saves, schema, hashes and URL arrays, /link brush/history JSON, timeline snapshots, pipeline registry, custom codecs and exact-size round trips (batch 179).
- margoengine: document the sciviz/spec optional alias after the build phase (batch 179).
- margoengine: retain the generated sciviz/monitor alias alongside sciviz/spec; both are optional subpaths (batch 179 integration repair).

- @margoengine/materials (review 3 M1): document Transmission and TransmissionLayers disposal in their owning scene, including nested captures.

- @margoengine/sciviz (review 3 material gate): use the common package browser launcher for the engineering reader route in the README phase.
- @margoengine/sciviz (batch 178 job 3): document /export-media sizing, alpha, tiled ownership, DPI, ZIP/video timeline restoration, provenance and limits; examples deferred.
- @margoengine/lines (batch 178 job 3): document /tiles full-image line construction, removable camera state and subpixel capture grid; examples deferred.
- @margoengine/headless (batch 178 job 3): document video provenance and maxBytes payload budget; examples deferred.
- margoengine (batch 178 job 3): document generated sciviz/export-media and lines/tiles aliases; examples deferred.


- @margoengine/lod (review 3 L1): document direct MSFTMaterialLOD/ClusterLOD disposal removing scene registrations and frame passes while retaining caller-owned inputs.

- @margoengine/viewcube (review 3 U1): document repeated quarter rolls at Top/Bottom for custom world-up frames, including returning to the original orientation.


- @margoengine/blender: document origin-anchored live Ping-Pong, signed scale and zero-scale behavior with the /nodes entry.
- @margoengine/blender: record the four package browser commands and their repository-root serving behavior during the README phase.
- @margoengine/stage (batch 183 job 3): document viewer-extras controller, explicit margo-viewer registration, attributes/defaults, annotations, animation/variants/picking/poster, WebXR requirements and cancellation/ownership; examples deferred.
- margoengine (batch 183 job 3): document the generated stage/viewer-extras alias; examples deferred.
- @margoengine/sciviz (batch 177 job 5): document /stream append/patch, original data/channels, rollover, cancellation/disposal, async WebSocket/SSE/polling sources, sliding/smooth date windows, Figure.updateData identity and transient allocations, and integration with /format. README examples owed.
- margoengine (batch 177 job 5): document the optional sciviz/stream alias in README phase.

- @margoengine/sciviz (lane L fix): createFallbackFigure now takes the layer as `compat: await import('@margoengine/webgl2-compat')`; README prose updated, example deferred.

| @margoengine/environment | exr-tiled: run the `parseTiledEXR` example (levels: all) under check:readme-run; fixture `/texture-mips.exr` still to provide. | Batch 51 job 2 |
| @margoengine/inspector | shaders: ShaderEditor.attach with a WgslMaterial mesh, recompileShader result and diagnostics, undo | batch-107 job 2 |

- @margoengine/clustered (batch 52 job 4): document ShadowAtlas per-face caching (stable tiles, which changes redraw which faces); examples deferred.

- @margoengine/scatter (batch 64 job 5): document /simplify scatterLODs ratios, deviation, ringDistance, nested rings, kept normals, optional lod and mesh-edit peers and limits; example deferred.
- margoengine (batch 64 job 5): document the scatter/simplify forwarding entry.

- @margoengine/water and margoengine (batch 67 job 1): /bodies WaterBodies with outline and river path bodies, levels, waves share, colours, setBodies, sample, bounds, rasterizeWaterBodies and sampleWaterBodies; examples deferred.

- @margoengine/water and margoengine (list 3 batch 66 job 5): document /underwater attach or PostStack stage, Water/FFTOcean surfaces, absorption/scattering/anisotropy/shafts/steps/distances/waterline defaults, exact pass-through above water and when disabled; examples deferred.


- @margoengine/transitions (review 3 T1): document scalar GLSL aggregate equality, single operand evaluation and ES 1.00 array/sampler exclusions; examples deferred.

- @margoengine/water and margoengine (batch 67 job 2): /scatter WaterScatter settings (color, strength, power, distortion), attach order after WaterBodies, set, settings, dispose; examples deferred.

- @margoengine/scatter (batch 64 job 6): document /grass GrassScatter, GrassShape defaults and ranges, ring segments, blade randomness, attach without meshes and limits; example deferred.
- margoengine (batch 64 job 6): document the scatter/grass forwarding entry.

| @margoengine/inspector | remote: createRemoteRelay with host 0.0.0.0, RemoteTarget.attach on the phone page, RemoteInspector.connect on the desktop page, set, undo, capture | batch-107 job 3 |

- @margoengine/environment (batch 51 job 3): volumetric, a runnable `multipleScattering` example (attach with a distance, switch back to 0 live).

| @margoengine/clustered | shadows: copy-paste example of `LocalShadows.add(terrain)` and the `drawLocalShadow({context, pass, matrix, layer})` hook (reversed depth, per-layer uniforms, every-frame redraw without `shadowVersion`) | batch-52 job 2 |
| @margoengine/terrain | Shadows: `drawLocalShadow` casting into clustered `LocalShadows` point, spot, directional and area maps | batch-52 job 2 |

- @margoengine/water and margoengine (list 3 batch 66 job 8): document /rivers attach on a Water with a terrain coast, sources/substeps/maxFroude, setSources without restart, dispose returns the coast to Water's solver; examples deferred.

- @margoengine/water and margoengine (batch 67 job 3): /rain WaterRain with weather (WeatherMachine state.rain), rain, cell, lifetime, strength, splashes into Ripples, setTime, dispose; examples deferred.

- @margoengine/sciviz (batch 176 job 3): document /fits images/cubes/binary cells/WCS and scaling, /mrc cell geometry/complex modes, /ometiff series/ZCT/multifile planes, bounds/cancellation, exact sample types and storage-grid rendering limits; examples deferred.
- @margoengine/decoders (batch 176 job 3): document openTIFF lazy classic/BigTIFF IFDs, descriptions, quantitative sample storage, predictors/limits/cancellation and unchanged parseTIFF display API; examples deferred.
- margoengine (batch 176 job 3): document generated sciviz/fits, /mrc and /ometiff aliases and additive decoders/tiff API; examples deferred.

- @margoengine/biomes (list 3 batch 63 job 2): document /view `water.flow` (true or { discharge, substeps }) with `rivers`, and /rivers `riverSources`; examples deferred.

| @margoengine/clustered | contact: copy-paste example of `ContactLights.attach(engine, {lights})`, `setStrengths`, and `depth: () => stack.depthTexture` beside SSAO | batch-53 job 1 |
| margoengine | Generated clustered/contact alias | batch-53 job 1 |
| @margoengine/clustered | Many lights: example of `Clustered.attach(engine, {maxLights: 20000})` and `AreaLights.attach(engine, {lights, maxLights: 256})` | batch-53 job 2 |

- @margoengine/pixel (review 3 P1): document zero-lerp stationary axes across the full finite nonnegative update delta domain; examples deferred.

- @margoengine/weather (review 2): document direct GLTFWeather/PrecipitationCover disposal in secondary scenes and retained caller models; examples deferred.
- @margoengine/sciviz (batch 174 job 4): document query predicates/reductions and f64/null policy, keyed extraction, sortable virtualised Spreadsheet/keyboard/AbortSignal, selected time-series snapshots and plot lifecycle, native scaled limits in data units and setLimits space: 'plot' for portable windows.
- margoengine (batch 174 job 4): cover the generated sciviz/query alias and refreshed sciviz/monitor alias.
- Batch 178 job 4, @margoengine/sciviz (and margoengine/sciviz/colormaps alias): construction names, Tol category domains, Machado diagnostics, colorScale domain/range and bins, exceptional colours, encodingLegend sizes/shapes and export/state parity. README examples deferred during the build phase.

- @margoengine/water (review 2): document live Caustics/Ripples composition across attachment and removal; examples deferred.

- @margoengine/sciviz (review 3 SV2): document pending SSE byte-read cancellation, exact abort reasons and caller-owned iterator cleanup; examples deferred.

- @margoengine/decoders: batch 203 job 4 AVIF still decoding, browser/Node workers, cancellation and resource limits, precision/color metadata and declared still-image limitations; write examples only after the feature is built.

- margoengine (batch 203 job 4): document the generated decoders/avif forwarding entry after the build phase.

- Tooling (batch 203 landing integration): explain current PBR basic-scene network rows and deferred emitted codec assets during the README phase; no README example changed.
