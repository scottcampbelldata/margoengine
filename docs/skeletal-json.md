# Skeletal JSON import

Batch 245 job 4 uses the existing sprites skeletal rig. The optional
`@margoengine/sprites/spine` entry provides `parseSpineJSON`, `loadSpineJSON`,
`serializeSpineJSON`, `SpineAsset`, `SpineSkeleton`, `SpineAttachment` and
`SpineMesh`. The generated `margoengine/sprites/spine` alias has the same
exports and identities. Core and stage have no changes.

Spine is a trademark of Esoteric Software LLC. This independent format
reader has no affiliation with Esoteric Software and includes no runtime
or editor implementation. Artwork and audio retain their own rights.

The reader accepts a JSON string or a plain JSON object. It copies and
validates the document before allocating a rig: hierarchy and names,
references, weighted vertex records, mesh indices, linked mesh cycles,
skin activation sets, constraint definitions, timelines, curves, events
and draw order offsets. It retains metadata, omitted defaults and unknown
exporter fields. Serialization preserves the JSON values, including all
physics data; formatting and object identity are not preserved.

An asset owns animation descriptions and durations, skin definitions and
diagnostics. `createSkeleton` creates independent mutable rig instances.
They are `Skeleton2D` objects, with named slots and `SkinnedMesh` attachments
that work directly with `SkeletalLayer.addSkeleton`. The reader supports
both object and array skin layouts, separate legacy constraint lists and
the newer ordered typed constraint list. Curve sampling distinguishes
normalized legacy controls from per-channel absolute time/value controls.

Rendering attachments include regions, meshes and linked meshes. Weighted
meshes keep every influence and its own bone-local bind position; no four
influence truncation or averaged bind position is used. Deformation keys
apply per vertex or per influence as appropriate. Linked mesh deformation
inheritance follows its exported flag. Bounding polygons, cubic paths,
point positions/angles and clipping polygons remain available through
`getAttachment` and `worldVertices`. Clipping triangulates concave simple
polygons, interpolates atlas texels at intersections and ends after the
named end slot, inclusive. A collapsed clipping polygon draws no area.

Atlas regions are supplied by name in `SpineSkeletonOptions.regions` and
refer to one loaded `SpriteAtlas`. They describe packed texel rectangles,
quarter-turn rotation, original image dimensions and bottom-left trim
offsets. The application owns image/page loading and packing. If regions
are omitted, each attachment maps its full image dimensions; this is useful
for geometry inspection but is not an automatic image loader. Missing
regions fail when an explicit map is supplied. Sequence frames are named
using the exported start/digit count and support hold, once, loop,
ping-pong and reverse modes.

`scale` defaults to 1 and must be positive and finite. `yDown` defaults to
true, converting exported y-up positions, rotations, shears and deforms
into sprite coordinates. `skin` defaults to default, or the first skin
when no default exists. Skin lookup falls back to the default skin.
Changing skin resets setup pose and slots; call `pose` to resample an
animation afterward. Bone inheritance and skin-required bone/constraint
activation are retained.

`pose(name, seconds, { loop })` defaults to looping. Every call starts from
setup, then applies bone and slot channels, attachment/deform/sequence
keys, draw order and constraints in their exported order. Backward seeks
therefore have no accumulated animation state. IK uses the job 2 solvers;
transform constraints support local/world and relative/absolute modes and
property mappings. Path constraints support fixed/percent position,
length/fixed/percent/proportional spacing and tangent/chain/chain-scale
rotation. Constant-speed paths use a deterministic 128-segment chord
table per cubic; nonconstant paths use exported setup curve lengths.
Modern sliders sample an animation from a keyed time or a bone property
and mix its authored channels without replacing unrelated channels.

Slots retain light/dark tint, alpha and normal/additive/multiply/screen
blending. The skeletal renderer uses premultiplied output and ordered
runs. Multiply uses interleaved correction and multiply draws per triangle
to retain uncovered source color on transparent targets. Existing
`SkinnedMesh` users keep normal blending and black dark tint by default.
The additive `SkinOptions.jointPositions` API accepts eight finite
bone-local coordinates per vertex, avoiding inverse bind matrices for
collapsed setup poses. Imported meshes use their unrestricted influence
records on top of this rig API.

`eventsBetween(name, from, to, loop)` returns events in `(from, to]`, with
definition defaults and audio metadata. Pass -1 initially to include
time-zero keys. Loop crossings include each occurrence, including an end
key and the following loop's zero key at the same timestamp. Backward
intervals emit none. Posing itself does not emit or play events/audio.

Physics constraints are parsed and validated in either constraint layout.
Their definitions, global flags, animation curves and reset keys survive
serialization. Loading emits one `spine-physics-deferred` warning per
constraint, naming it. `asset.warnings` also retains those diagnostics.
Physics never affects pose; evaluation waits for Scott's physics phase.

Reader limits default to 1,000,000 JSON values and explicit source mesh/path
vertices, 64 JSON nesting levels, and JSON text length at most 128 times
`maxValues`. `maxValues` and `maxVertices` can lower or raise the budgets.
Event queries cap crossed loops at 10,000 and returned candidate events at
1,000,000. Invalid input uses MargoError code `failed` with a help link;
aborts propagate the signal reason. `loadSpineJSON` forwards AbortSignal
to fetch/body reading and validation. The library does not read arbitrary
paths named in image or event metadata.

Evidence is in `packages/sprites/tests/spine.test.js` and
`spine-check.mjs`. The latter exercises 96 offscreen blend/color/weighted
mesh/clipping cases per backend, plus the openly licensed animated tree
and exact backward-seek pixels. CPU tests also cover constraints, curves,
skins, nonrendering attachments, sequences, physics warnings/round-trips,
malformed inputs, cancellation and zero-scale bind data. No speed result
or complete editor/runtime API parity is claimed. README work is owed in
`docs/work-lists/readme-owed.md` for the build phase.
