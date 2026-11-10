# README work owed

Scott (2026-11-09): README examples and `check:readme-run` wait until the features are built. Each job that changes a package adds one line here. The README phase before release clears this list; it must be empty at release.

| Package | What its README must cover | Added by |
|---|---|---|
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
