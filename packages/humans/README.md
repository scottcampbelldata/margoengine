# @margoengine/humans

People in one call. `addPerson(engine, model)` takes a character loaded with `@margoengine/gltf/pbr` and dresses it
the way a film needs it: skin, eyes and strand hair on the materials named for them, an Animator that plays the clips
with cross-fades, dual quaternion skinning so a raised arm keeps its shoulder, relaxed hands on clips whose fingers are flat, and the
scene's shadows and sky light. Each further default (face, cloth) arrives as it is built, with no change to the call.

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {addPerson} from 'margoengine/humans';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb');
const person = await addPerson(engine, model, {materials: {skin: [model.primitives[0].material.name ?? '']}});
console.log(person.clips.length, person.animator?.state); // its clips; the first one plays
```

## Crowds of hundreds (`./crowd`)

`walkCrowd(crowd, drawer, {walk, stand, stride})` joins a `@margoengine/navmesh` `Crowd`, which moves the people, to a
`SkinnedCrowd` or `VATCrowd` from `@margoengine/animation`, which draws them all in one instanced call. Each agent gets an
instance placed and turned with it (at most `turnRate`, 4 radians a second, so avoidance does not snap a head round), and
its walk cycle moves on by the ground the agent covers divided by `stride`, so feet do not slide at any speed. With
`new Crowd(nav, {density: true})` those speeds are Weidmann's measured ones: about 0.6 m/s at 2 people a square metre.
Agents slower than `standBelow` (0.05 m/s) play the `stand` clip. An agent the crowd pushes back against where it means
to go (its `velocity` against its `preferredVelocity`, which a navmesh `CrowdAgent` has) steps back facing its way, its
walk cycle running backward, instead of turning round to face the push; without `preferredVelocity` the heading follows
the velocity. `variants` (atlas regions) give each agent one outfit
of several by a seeded hash. The entry imports neither package; it reads them by shape.

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
import {SkinnedCrowd, bakeBones} from 'margoengine/animation/instanced-skin';
import {Crowd, NavMesh} from 'margoengine/navmesh';
import {walkCrowd} from 'margoengine/humans/crowd';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const model = await loadGLTF(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb');
const people = SkinnedCrowd.attach(engine, bakeBones(new Animation(model)));
model.dispose();
const plaza = new NavMesh([[0,0,0], [40,0,0], [40,0,40], [0,0,40]], [[0,1,2,3]]);
const crowd = new Crowd(plaza, {density: true});
for (let k = 0; k < 300; k++)
  crowd.addAgent({position: [1 + (k % 20) * 0.6, 0, 1 + Math.floor(k / 20) * 0.6], radius: 0.25, maxSpeed: 1.34}).setTarget([39, 0, 20]);
const walkers = walkCrowd(crowd, people, {walk: 0, stride: 1.4});
for (let k = 0; k < 30; k++) {
  crowd.update(1 / 30);
  walkers.update(1 / 30);
}
console.log(walkers.instances.length, walkers.phases[0]); // 300 people, each at its own place in the cycle
```

## Period cast kit (`./cast`)

Clothes for a period film, cut in code for measured bodies: 1910 American West (US Forest Service rangers, miners,
loggers, railwaymen, townsmen) and 2011 coastal Japan (office workers, school pupils, fishermen). Each garment is a
thick mesh with seams and hems; layers stack from the skin out and never pass through each other at rest. Cloth
reflects light by the microcylinder model fitted to measured fabrics (Sadeghi et al. 2013), with a thin layer of loose
fibre ends over wool and cotton (`fuzz`: their grazing sheen), and is drawn with glTF base colour plus
`KHR_materials_sheen`, fitted to that model with the dye's measured colour kept.

```ts
import {Engine} from 'margoengine/core';
import {parseGLTFAsync} from 'margoengine/gltf/pbr';
import {OUTFITS, BODIES, dress, outfitGLB, castCrowd, castVariants, applyCastSettings} from 'margoengine/humans/cast';

const engine = await Engine.create(document.querySelector('canvas')!);
// The 1910 ranger's uniform as one glTF binary: a mesh per garment with its cloth material.
const ranger = await parseGLTFAsync(engine, outfitGLB(OUTFITS['ranger-1910']));

// The garments as data: positions, normals, uvs, indices, seams and fit rings.
const garments = dress(BODIES.us1919Man, OUTFITS['miner-1910']);
console.log(garments.map((g) => `${g.spec.name}: ${g.geometry.positions.length / 3} vertices`));

// A crowd of 200: three miners to each logger, each with a dye lot of his own.
const cast = castCrowd(200, {roles: {'miner-1910': 3, 'logger-1910': 1}, seed: 7});
// The same shares as atlas regions for walkCrowd's `variants` (see Crowds of hundreds).
const variants = castVariants({'miner-1910': 3, 'logger-1910': 1});

// Slider rows on the shared settings shape: a red duck shirt on the miner.
const {outfit, body} = applyCastSettings({outfit: 'miner-1910', garment: 0, fabric: 'cotton-duck', color: [0.4, 0.05, 0.03]});
const miner = await parseGLTFAsync(engine, outfitGLB(outfit, body));
```

| Export | What it is |
| --- | --- |
| `OUTFITS` | Outfits by role and era, each naming its garments, body and sources. |
| `BODIES` | `japan2003Man`, `japan2003Woman` (AIST/HQL 2003 means, head girth from the AIST head database 2001) and `us1919Man` (Army Anthropology 1921, Table 117 group 4m and Table 119 group 5m). |
| `dress(body, outfit)` | Builds the garments in a rest pose: arms hang at the smallest angle that clears the dressed trunk below the armpit. |
| `outfitGLB(outfit, body?)` | The outfit as a GLB, `KHR_materials_sheen` in `extensionsUsed` only. |
| `MEASURED_FABRICS`, `fabricBRDF`, `fabricAlbedo`, `threadScattering` | The paper's measured fabrics and model (Eq. 2 to 13). |
| `periodFabric(kind, color)`, `periodLobes`, `clothLobes` | Period cloth and its fitted glTF lobes. |
| `castCrowd`, `castVariants` | Outfit picks for crowds and walkCrowd regions. |
| `CAST_SETTINGS`, `applyCastSettings` | Slider rows (outfit, body, a garment's fabric, colour, thickness, ease; dye spread). |

How the cloth is set up: period fabrics take the threads of the closest measured fabric (spun cotton, wool and polyester
blends: the linen threads; corduroy: velvet; silk: crepe de chine) with the fibre's own refractive index (cotton 1.555
from Burkinshaw 2016, wool 1.55). The dye colour is the cloth's reflectance: the model's albedo A is solved so the
fabric reflects that colour at normal incidence. The engine's lobes are then fitted to the model's angular shape with
the base colour tied to that albedo; `fitError` reports what the lobes cannot follow (about 0.22 to 0.47: threads
shadow grazing light more than a sheen lobe does).

Not in the kit yet: women of 1910 (no measured body of the period was found), cloth drape and wrinkles (no sourced
bending or shear data yet), the armscye seam (the sleeve tube meets the bodice without stitched topology). To put the
kit's clothes on a loaded, rigged person see the next section. See [docs/limits.md](../../docs/limits.md).

## Dressing a loaded person (`./fit`)

`dressPerson` puts any of the cast kit's 11 outfits on a person you loaded (a Character Creator export, a Mixamo
character, any rig with humanoid bone names) in one call. It finds the body's rest pose (T-pose or A-pose), measures
it (stature, girths, arm and leg lengths, in metres, centimetres or millimetres, facing any way), cuts every garment to
those measures with each layer its ease outside the one beneath, takes skin weights from the body under the cloth and
skins the outfit to the person's own skeleton, so the clothes follow every clip the person plays.

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {addPerson} from 'margoengine/humans';
import {dressPerson, fitPenetration, riggedBody, applyFitSettings} from 'margoengine/humans/fit';

const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadGLTF(engine, '/character.glb'); // any humanoid rig, skin material named Body or Skin
const person = await addPerson(engine, model);

// The 1910 townsman's sack suit, cut to this body and skinned to its skeleton.
const outfit = await dressPerson(engine, person, 'townsman-1910');
console.log(outfit.fit.pose, outfit.fit.measures.stature.toFixed(2), outfit.model.primitives.length);

// A looser cut from the slider rows (FIT_SETTINGS on the shared settings shape).
outfit.dispose();
const loose = await dressPerson(engine, person, 'miner-1910', applyFitSettings({fit: 1.5}));

// How far any garment sits inside the body or another garment at rest, in the body's units.
const {body, layers} = fitPenetration(riggedBody(model), loose.fit);
console.log(body, layers); // 0 when nothing is inside the body or another layer
```

| Export | What it is |
| --- | --- |
| `dressPerson(engine, person, outfit, options?)` | One call: fit, GLB, gltf/pbr, cloth materials, skinning to the person's skeleton, shadows. The outfit joins the person's own scene, whichever scene is active. Returns `{model, fit, animation, dispose}`. |
| `riggedBody(model, materials?)` | The skinned body of a loaded model as data (skin material names: `BODY_MATERIALS`, Character Creator's `Std_Skin_*` included). A body split over several skins, as an FBX conversion gives one per mesh, is read as one skeleton, with unweighted bones above the joints (Character Creator's `CC_Base_Hip`) included. |
| `fitOutfit(body, outfit, options?)` | The garments cut and skinned as data: positions, normals, uvs, joints, weights, face kinds, seams; `measures` the body (the neck girth square to the neck, its narrowest ring between the clavicle line and the jaw). |
| `fitPenetration(body, fit, skin?)` | The deepest garment point inside the body and inside another layer, at rest or under joint matrices; `triangleTests` counts the closest points it measured (its work count). |
| `fittedOutfitGLB(model, fit, materials?)` | The fitted outfit as a GLB skinned to the model's own bones. |
| `FIT_SETTINGS`, `applyFitSettings` | Slider rows: `fit` (ease scale, default 1), `ease` (over the body, default 3 mm), `layerGap` (between layers, default 2 mm). |

How it fits: the body's skin is split into trunk, head, arms, hands, legs and feet by the bone that carries most of
each vertex's weight; each garment tube is cut ring by ring around that part's axis (the trunk's centre line, the
hip-knee-ankle and shoulder-elbow-wrist lines) to the convex hull of the body's slice there, which is the girth a tape
reads (ISO 8559-1), and keeps the kit's design (hem, sleeve length, ease, thickness) as Brouet et al. (2012) keep a
garment's design across bodies. Each layer stands its own ease off the layer beneath (a tailor measures the coat over
the vest), not every ease below it added up. Tops go over the shoulders as a tailor drafts them: each column climbs the
convex hull of the body (the shoulder point included) in its own vertical plane from under the arms to the neck base (the shoulder slope), and ends
in a neckline round the neck. The neck is measured square to its own axis, its girth the narrowest ring between the
clavicle line and the jaw (ISO 8559-1). A `GarmentSpec` `collar` stands up the neck (the townsman's 2 1/4 inch shirt
collar), and `points` parts its fronts from the stud and turns the top corners down into wing points; `opening` cuts a V
front down to the break, with `lapel` lapels that roll back from the top button (flat at the break, standing 11 mm off the
chest at the gorge, their folded edge two layers thick) and a turned-down collar on a coat that stops short of the lapel's
point (the notch), and puts a waistcoat over the shoulders. A `cut: 'tie'` garment (`knot` `'four-in-hand'` or `'bow'`)
ties at the collar's front over the shirt and under the waistcoat: a four-in-hand's tapered knot (Fink and Mao 1999), its face showing the wrapped band and the dimple under it, and
its blade down the shirt front to the waist, lying on the shirt and skinned as it is. Coats with buttons hang from the chest to the seat over the waist's hollow and fall plumb below the chest (the hem
never narrower than the chest, and no column of the front coming back in below a belly), as a sack coat does, from the
chest as the body stands with its arms down: the armpit flesh of an A or T rest pose, which comes in with the arm, does
not set the coat's breadth. Each sleeve is set in a ring further in than the sleeve beneath it, so no shirt shows at
the shoulder seam. A hat's `dome` rounds its crown over (the townsman's derby: 5 1/4 inch crown, 2 inch brim, dome
0.6). The outer garments carry folds cut into the cloth at rest (Rohmer et al. 2010): flutes round
a coat's sides and back below the chest, crests out and troughs in about the plumb line, creases inside the elbow and behind the knee, gathers at the cuff and the trouser break over the boot; trousers taper from the thigh to a knee and bottom cut to the seat by S. S. Gordon's 1895 proportions (19 inch
knee and 18 inch bottom on a 37 inch seat). Skin weights: a lattice over each part takes the weights of the body point under the
cloth where it is within 15 mm and faces the same way, and fills the rest by a harmonic solve, after Abdrashitov et al.
(2023); every layer reads the same lattice, so layers keep their order in any pose. The rows over the shoulders, which
cross the trunk, the shoulder's cap and the neck, take the weights of the body point under each instead, so the yoke
turns down with the deltoid when the arm drops. Measured on a test body (T and A
pose, four poses each): nothing inside the body or another layer at rest, no layer through another in any pose, and no
garment over 5 mm into the body. What it does not do yet: push cloth aside at runtime where the body presses into it
(a 20 mm life jacket meets an arm brought in by up to 12.5 mm), drape or wrinkle, straps on sleeveless tops. See
[docs/limits.md](../../docs/limits.md).

## What `addPerson` does

| Part | Default | Option |
| --- | --- | --- |
| Skin (`@margoengine/materials/skin`) | on materials named `Skin`, `Body`, `Face`, and Character Creator's `Std_Skin_Head`, `Std_Skin_Body`, `Std_Skin_Arm`, `Std_Skin_Leg` | `skin: SkinOptions` or `false`; names in `materials.skin` |
| Eyes (`@margoengine/materials/eye`), each fitted by `personEye` (centre from its vertices; a skinned eyeball follows its joint; a Character Creator eye also takes its axis, iris size and iris map) | on `EyeL`, `EyeR`, `Eye`, `Eyes`, `Std_Eye_L`, `Std_Eye_R` | `eyes: EyeOptions` or `false` (what you pass wins over the fit); names in `materials.eyes` |
| Eye shells hidden, as the eye draws its own cornea and tear film | `Std_Cornea_L`, `Std_Cornea_R`, `Std_Tearline_L`, `Std_Tearline_R` | names in `materials.shells`; none when `eyes` is `false`; a tear line drawn by `@margoengine/fbx/character-creator` stays |
| Strand hair (`@margoengine/materials/hair`), 1024 strands across a UV unit, running along the UVs (a direction of three numbers in `hair` follows the joint that carries most of the hair's weight) | on `Hair`, `Brows`, `Eyebrows`, `Lashes`, `Eyelashes`, `Moustache`, `Beard`, and Character Creator's hair materials made from them (`Hair_Transparency`, `Hair_Clap_Transparency`, `Brows_Base_Transparency` ...) | `hair: HairOptions` or `false`; names in `materials.hair` |
| Hair cards (`hairCards()` from `@margoengine/materials/hair`): a BLEND lash card seen edge on darkens the lid line as a fringe of lashes does | on `Std_Eyelash`, `Lashes`, `Eyelashes` | `cards: HairCardOptions` or `false`; names in `materials.cards` |
| Animator (`@margoengine/animator`), one state per clip, named as the clip | starts on the first clip | `clip: 'name'` |
| Cross-fade length for `play` | 0.3 s | `fade` |
| Hands (`@margoengine/rigging/hands`): the relaxed pose on every clip whose finger tracks stay under 15 degrees mean | on, for Mixamo, VRM, MPFB, Godot and humanoid bone names | `hands: HandsOptions` or `false` |
| Anatomy (`@margoengine/rigging/anatomy`): the human body fitted bone for bone, every clip and every IK solve held inside its joint ranges | on, for a rig whose bones a naming `fitHuman` knows uses (the humanoid names, Character Creator and the others it lists) | `anatomy: {limits: false}` keeps the body for reading and IK but holds nothing; `anatomy: false` fits none |
| Skinning | dual quaternion (Kavan et al. 2008) | `skinning: 'linear'` |
| Shadows | the `Shadows` attached to the model's scene, if any | `shadows: Shadows` or `false`, or `scene` (a `@margoengine/scenes` handle) |
| Ambient occlusion | none | `occlusion: scene.parts.occlusion`, or `scene` |
| Sky light (`Sky` from `@margoengine/sky`, `sky.add(model)`): the sky's diffuse light and its reflections, blurred by each material's roughness, so skin keeps its soft sheen under an overcast sky | the `Sky` attached to the model's scene, if any (every glTF model joins it by itself: gltf/pbr `sceneSky`, so a person's outfit and props are lit alike) | `sky: Sky` or `false` (either sets `model.sceneSky` false until dispose) |

A name the model lacks is skipped, so one call serves a man with a moustache and one without.
`personMaterials(names, options)` tells you which look each material name gets, without an engine:

```ts
import {personMaterials} from 'margoengine/humans';
console.log(personMaterials(['Skin', 'EyeL', 'Hair', 'Suit'])); // {Skin: 'skin', EyeL: 'eyes', Hair: 'hair'}
```

A Character Creator 4 or 5 export (FBX, Blender preset, loaded with `loadFBX` and the `pbrMaterials` entry) needs
nothing named: `addPerson(engine, model)` puts skin on `Std_Skin_*`, the eye on `Std_Eye_*`, strand hair on its
`Hair_*_Transparency` and `Brows_*_Transparency` hair materials and hides the cornea and
tear line shells. Loaded with `characterCreator(json)` from `@margoengine/fbx/character-creator` as well, the tear line
is the reader's clear glossy strip along the lower lid and stays drawn.

```ts
import {personMaterials} from 'margoengine/humans';
console.log(personMaterials(['Std_Skin_Head', 'Std_Eye_L', 'Std_Cornea_L', 'Boxers'])); // {Std_Skin_Head: 'skin', Std_Eye_L: 'eyes'}
```

`personEye(model, primitive)` gives the `eye()` options `addPerson` fits, to wire an eye by hand. On a Character Creator
model it also measures the upper lid's margin on the head's skin (`Std_Skin_Head`) with `eyeLidMargin`: seen along the
eye's axis, the first point up the ball in nine columns across it that the skin hides, by ray casting (Moller and
Trumbore 1997) and bisection, fitted with a parabola, so the eye's lid shading starts at the margin a camera sees. Walking down the ball the same
way gives the lower lid's margin (`lower` in the result), which `personEye` passes as `lowerLid`.

```ts
import {eyeLidMargin} from 'margoengine/humans';
// A sheet of skin in front of a unit eye, open below 0.2 radii: the margin is found there.
const positions = [-2, 0.2, 1.2, 2, 0.2, 1.2, 2, 3, 1.2, -2, 3, 1.2], indices = [0, 1, 2, 0, 2, 3];
console.log(eyeLidMargin({center: [0, 0, 0], axis: [0, 0, 1], radius: 1}, {positions, indices})); // height about 0.2
```

Everything is checked before anything is attached: a bad option or an unknown clip rejects and leaves the model as it
was.

## Anatomy by default

Every person obeys a human body with no configuration. `addPerson` fits the rig with the human table
(`fitHuman`), reads how its upper arms and thighs are rolled from its clips, and from then on each frame of each clip is
held inside the body's ranges, elbows and knees bend only the anatomical way, and the Animator's IK (`addIKChain`, foot
placement, the `footIK` option) solves on the same body. `person.body` is the fitted body; `person.check(tier)` lists
what the pose on screen breaks (`'normal'`, the clinical range, by default; `'structural'`, the stops no body passes,
which a held pose never reaches).

| `anatomy` option | Default | What it does |
| --- | --- | --- |
| `limits` | `true` | `false` keeps the body for `check`, `jointAngles` and IK but holds no clip |
| `tier` | `'structural'` | the range clips are held to: `'normal'` holds them to the clinical range |
| `calibrate` | `true` | reads the arm and leg rolls from the clips (`hingeRolls`); rolls over 30 degrees are not trusted |
| `onClamp` | none | called with the motions each held frame was brought back from |
| `map`, `roll` and the other `fitHuman` options | none | name joints a rig's naming misses, or turn a segment by hand |

A rig whose bones no naming knows gets no body (`person.body` is undefined); name its joints with `anatomy: {map}`.
The frames in `test/pose-frames.browser.mjs` draw a walk, an IK reach and a seated pose from the front, the
three-quarter and the side with the body and without it.

## A person built in code (`./body`)

`addBody(engine, {bones, meshes, clips})` makes a person from a skeleton and skinned meshes made in code or read from
another format, with no glTF file: each bone's name, parent and bind matrix, and each mesh's positions, normals,
indices, four joints and four weights a vertex. It writes them into an in-memory glTF (`bodyGLTF` returns that document),
loads it and hands it to `addPerson`, so the body gets every default above, its anatomy included. With no clips it gets
one, `rest`, holding the bind pose. `person.model` is the model it built, and disposing the person disposes it.

```ts
import {Engine} from 'margoengine';
import {addBody} from 'margoengine/humans/body';
// Joint positions in metres, y up, facing +z, parents before children, in the humanoid names.
const joints: [string, string | null, number[]][] = [
  ['hips', null, [0, 0.95, 0]], ['spine', 'hips', [0, 1.06, 0]], ['chest', 'spine', [0, 1.25, 0]],
  ['neck', 'chest', [0, 1.46, 0]], ['head', 'neck', [0, 1.56, 0]],
];
for (const [side, s] of [['left', 1], ['right', -1]] as const)
  joints.push(
    [`${side}Shoulder`, 'chest', [s * 0.04, 1.42, 0]], [`${side}UpperArm`, `${side}Shoulder`, [s * 0.19, 1.41, 0]],
    [`${side}LowerArm`, `${side}UpperArm`, [s * 0.4, 1.2, 0]], [`${side}Hand`, `${side}LowerArm`, [s * 0.58, 1.02, 0]],
    [`${side}UpperLeg`, 'hips', [s * 0.09, 0.9, 0]], [`${side}LowerLeg`, `${side}UpperLeg`, [s * 0.09, 0.48, 0.01]],
    [`${side}Foot`, `${side}LowerLeg`, [s * 0.09, 0.08, -0.01]], [`${side}Toes`, `${side}Foot`, [s * 0.09, 0.02, 0.14]],
  );
const bones = joints.map(([name, parent, p]) => ({
  name,
  parent: joints.findIndex((j) => j[0] === parent),
  bind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1],
}));
// A small triangle on each joint, skinned to it.
const positions: number[] = [], normals: number[] = [], indices: number[] = [], skin: number[] = [], weights: number[] = [];
joints.forEach(([, , [x, y, z]], i) => {
  positions.push(x - 0.03, y, z, x + 0.03, y, z, x, y - 0.06, z);
  normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1);
  indices.push(i * 3, i * 3 + 1, i * 3 + 2);
  for (let k = 0; k < 3; k++) skin.push(i, 0, 0, 0), weights.push(1, 0, 0, 0);
});
const engine = await Engine.create(document.querySelector('canvas')!);
const person = await addBody(engine, {bones, meshes: [{positions, normals, indices, joints: skin, weights}]});
console.log(person.body?.preset, person.clips); // 'humanoid' ['rest']: the human body, on by default
console.log(person.check().length); // 0: the bind pose is inside every range
person.dispose(); // and the model with it
```

## Playing and seeking

`person.play(clip, {fade, at})` cross-fades to a clip (the clip left keeps playing through the fade) and starts it at
`at` seconds. `person.time` is the time in the current clip; with `person.playing = false` the pose is a pure function
of it, so a film sets it every frame and any frame renders the same whether it was played to or sought:

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {addPerson} from 'margoengine/humans';
const engine = await Engine.create(document.querySelector('canvas')!);
engine.stop();
const person = await addPerson(engine, await loadGLTF(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb'));
person.playing = false;
for (const frame of [0, 12, 24]) {
  person.time = frame / 24; // the shot's clock
  engine.render({delta: 1 / 24});
}
person.dispose(); // takes the looks, the Animator, the shadows and the sky light off again; the model stays
```

`person.hands.left` and `person.hands.right` take keyed poses on the same clock, for a hand closing on a rail:

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {addPerson} from 'margoengine/humans';
import {grip} from 'margoengine/rigging/hands';
const engine = await Engine.create(document.querySelector('canvas')!);
const person = await addPerson(engine, await loadGLTF(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb'));
person.hands?.right.set(grip(0.035), {blend: 0.3}); // a 35 mm rail, closed over 0.3 s (a rig with finger bones)
```

`person.animation` and `person.animator` are the `@margoengine/animation` and `@margoengine/animator` objects, for
layers, IK and look-at. A model with no clips gets no Animator.

## Imported clothing and the Character Creator workflow

Use `@margoengine/humans/wardrobe` for mesh construction and offline checks on clothing made in Blender or
generated in Tripo. Existing procedural outfits use the [fit entry](#dressing-a-loaded-person-fit). A finished GLB
uses `addPerson` for playback in Margo.

1. **Export a matching body.** In Character Creator, export the character as FBX for Blender in its
   bind pose. Keep the same pose, skeleton and scale when bringing the garment back. Reallusion uses an
   A-pose for imported clothes and a separate AI-cloth A-pose for its generator. If using an existing
   CC garment as a template, keep its shoulder and elbow anatomy and adapt its shell in the same pose.
2. **Construct the wearable shell in Blender.** Separate generated garments. Inspect each expected neck,
   cuff, waist or hem opening. Remove the cap or joined faces, then retopologize around the opening and
   joints. On a damaged generated sleeve, cut back to a clean seam and rebuild to the wrist.
   Model a small inward fold at the edge, and maintain clear space for the layers beneath.
   Use the source garment as the reference for silhouette, seams and cloth textures.
3. **Bind and calibrate.** Import the Blender mesh as an accessory in CC and use Transfer Skin Weights.
   Use the arm layer to isolate sleeve weights from the trunk. Inspect weight errors in the Calibrate
   poses and refine the garment and weights. When binding in Blender, transfer from the same CC rig
   and check it through elbow flexion, forearm twist and shoulder elevation. Measure both along the
   forearm and across it. Check both wrists before trimming permanently covered skin.
4. **Check the actual moving layers.** Sample the body and the worn garments in the walking, lifting
   or talking takes. If an apron or coat panel needs drape, use a pinned single-surface Blender cloth
   proxy and transfer it to the render mesh. Test the resulting outer mesh against the posed inner
   layers. A vertex-only clearance sample can miss intersections between triangles. Use sufficiently
   dense geometry and review the fabric silhouette throughout motion.
5. **Export and inspect in Margo.** Export animation, skin and any baked shape keys into the GLB.
   When matching a GLB authored with linear blend skinning, use
   `addPerson(engine, model, { skinning: 'linear' })`. View the actual takes from the front, side and rear.
   Check the wrist position and hand opening, the elbow and underarm, and the lower garment during a
   full stride or bend.

For new Tripo assets, generate one garment at a time from consistent front, side and back views.
Show the sleeves clear of the torso and use the same pose and scale in every image. Inspect
the resulting openings before fitting. [Tripo image-to-3D guide](https://www.tripo3d.ai/help/features/how-to-get-better-image-to-3d-results).

If a Character Creator step fails, first check the current manual and search the
[Reallusion forums](https://discussions.reallusion.com/) for the CC version and the exact symptom.
Check the documented bind pose, garment type and transfer preset before changing the mesh or rig.

Reallusion sources. [Custom clothes and binding](https://manual.reallusion.com/Temp/CC5.2_Only/Content/ENU/5.0/08_Cloth/Creating_Custom_Clothes_OBJ.htm),
[opening AI clothing](https://manual.reallusion.com/Temp/CC5.2_Only/Content/ENU/5.2/08-AI-Mesh-Gen/Opening-AI-Generated-Clothing.htm),
[arm-layer transfer](https://manual.reallusion.com/Character-Creator-5/Content/ENU/5.0/08-Creating-Custom-Assets/Arms-Layer-for-Transferring-Skin-Weight.htm),
and [modeling](https://wiki.reallusion.com/Content_Dev:CC_Clothing_Modeling_Guidelines).
Production references include Waggoner and de Goes, 2022,
[*Revamping the Cloth Tailoring Pipeline at Pixar*](https://research.pixar.com/docs/2022.SiggraphTalks.WG.pdf),
and Abdrashitov et al., 2024,
[*Robust Skin Weights Transfer via Weight Inpainting*](https://www.dgp.toronto.edu/~rinat/projects/RobustSkinWeightsTransfer/).
Tripo's developers show the weight and collision tradeoffs in their
[dress-up asset case study](https://developers.tripo3d.com/en/cookbook/ai-tailor-dressup-game).

```ts
import { buildSleeve, inspectGarment, measureCuff } from '@margoengine/humans/wardrobe';

const sleeve = buildSleeve([
  { centre: [0, 0, 0], radii: [.065, .060], forearm: 0 },
  { centre: [0, 0, .22], radii: [.060, .054], forearm: .5 },
  { centre: [0, 0, .45], radii: [.043, .037], forearm: 1 },
], { thickness: .003, turnback: .012, upperJoint: 18, forearmJoint: 19 });

const { openings } = inspectGarment(sleeve);
const cuff = measureCuff(sleeve.positions, openings[1], [0, 0, .22], [0, 0, .45]);
console.log(cuff.axialOffset, cuff.radialOffset);
```

| Function | Use |
| --- | --- |
| `inspectGarment(shell)` | Reports open rings, irregular boundaries, zero-area triangles, and nonmanifold or inconsistent edges in indexed triangles. Exact duplicate positions, such as UV splits, are joined for inspection. |
| `measureCuff(positions, opening, elbow, wrist)` | Reports wrist alignment, depth and minimum ring radius in the input units. Use the exposed rim or account for the width of a turned lip when inspecting its inner boundary. |
| `buildSleeve(stations, options)` | Builds a cuff and skin-weighted sleeve from bind-pose centres and radii. The first rim is ready to sew to the garment. Specify the upper and forearm joint indices in the receiving skin's joint palette. |
| `clearGarmentLayer(positions, collider, options)` | Projects selected vertices about an axis to clear the farthest hit of the posed inner surface. A `MeshBVH` from `@margoengine/bvh/tree` supplies the collider. Use `limited` to check the allowed push and review the corrected silhouette. |

The layer projection is suitable for tubular panels such as closed coats or skirt sections. It works on a
single combined pose and leaves motion caching and solving to the authoring application. All coordinates
and ease must use the same units, typically metres. The output positions are in the posed coordinate
space. To bake as glTF morph targets, map their displacements back through the vertex skinning transform
before writing the bind-space shape deltas.
