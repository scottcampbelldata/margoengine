# @margoengine/horses

Horses built in code from published equine measurements. `addHorse(engine)` builds a riding horse, a cavalry remount or
a heavy draft horse to its breed group's proportions, with a coat, white markings, a mane and tail of hair cards shaded
as strand hair, a 37-joint rig and walk, trot, canter and gallop taken from equine biomechanics. Its gait follows its
speed, a stance hoof stays where it struck, and film time seeks exactly. A rider seat gives a person the saddle, stirrups
and reins and a hip that rides the horse's back; `addHorseCrowd` draws hundreds in one call.

```ts
import {Engine} from 'margoengine';
import {addHorse} from 'margoengine/horses';
const engine = await Engine.create(document.querySelector('canvas')!);
const horse = await addHorse(engine, {type: 'cavalry', coat: 'bay', markings: {blaze: true}});
horse.speed = 4; // eases into a trot at 3 m/s^2
horse.advanceTime(1 / 30); // or horse.seek(12.5) for a film frame
console.log(horse.currentGait, horse.body.mass.toFixed(0)); // 'walk' as it sets off, 'trot' near 4 m/s; about 459 kg
```

An existing skinned horse can use the same controller through `skin`. Provide its loaded model in the same engine,
its fitted skeleton in metres facing +Z, and a function that applies the solved pose to its joint map. The controller
sets root position and yaw, attaches its skinning pass, and keeps the authored materials. The tightest of the four
fitted limbs determines whether the stride must shorten to keep the same speed at a quicker cadence. Fit the skeleton
in metres in a naturally bent stance so the package can measure extension in both directions. The caller owns the model.

```ts
import type { Engine } from 'margoengine';
import { addHorse, type HorseSkin } from 'margoengine/horses';

export async function startImportedHorse(engine: Engine, skin: HorseSkin) {
  const horse = await addHorse(engine, { skin });
  horse.speed = 3;
  horse.advanceTime(1);
  return horse;
}
```

Pass `ground(x, z)` for an uneven path. The controller holds each stance hoof at its world-space landing point
through turns, then releases the horizontal correction over 0.18 seconds. It conforms the hoof to the local grade and
retains toe breakover and swing clearance. The back and saddle lean with the wider ground slope. Supply a stable,
continuous height field in metres for deterministic seeks. Jumps, large risers, and overhangs require separate route
planning. Limb reach and splay constraints still apply.

```ts
import type { Engine } from 'margoengine';
import { addHorse } from 'margoengine/horses';

export async function walkOnAGrade(engine: Engine) {
  const horse = await addHorse(engine, { ground: (x, z) => 0.08 * z - 0.06 * x + 0.04 * Math.sin(2 * z) });
  horse.gait = 'walk';
  horse.speed = 1.4;
  horse.seek(2.4);
  return horse;
}
```

The terrain pass follows the world-space plant and continuous correction approach of [Kovar, Schreiner and Gleicher,
Footskate Cleanup for Motion Capture Editing (2002)](https://research.cs.wisc.edu/graphics/Papers/Gleicher/Mocap/cleanup.pdf).
Its separate support frames and trunk sampling draw on [Coros, Karpathy, Jones, Reveret and van de Panne,
Locomotion Skills for Simulated Quadrupeds (2011)](https://www.cs.ubc.ca/~van/papers/2011-TOG-quadruped/index.html)
and [Miller, Holden, Al-Ashqar, Dubach, Mitchell and Komura, Carpet Unrolling for Character Control on Uneven Terrain
(2015)](https://www.pure.ed.ac.uk/ws/portalfiles/portal/21937045/MIG_2015_paper_22.pdf).

## Anatomy (`./anatomy`)

| Group | Withers | Build | Weight |
| --- | --- | --- | --- |
| `riding` | 1.63 m (16 hh) | Thoroughbred: long legs, narrow chest | about 488 kg |
| `cavalry` | 1.57 m (15.2 hh) | remount: 15 to 16 hands, 950 to 1,200 lb | about 459 kg |
| `draft` | 1.75 m (17.1 hh) | Shire, Clydesdale, Percheron: deep chest, heavy bone | about 859 kg |

Every length is a ratio of the withers height: body length, croup, heart girth, chest depth and width, hip width, head
and neck, the heights of the elbow, knee, fetlocks, hip joint, stifle and hock, and the cannon circumference. Weight is
girth squared times length over 11,880 (Carroll and Huntington 1988). `withers` sets another height, `condition` (0.8 to
1.25) a lean or heavy horse.

```ts
import {handsToMetres, horseBody} from 'margoengine/horses/anatomy';
const shire = horseBody({type: 'draft', withers: handsToMetres(17.2)});
console.log(shire.withers.toFixed(3), shire.mass.toFixed(0)); // 1.778, about 900 kg
```

## Gaits (`./gaits`)

| Gait | Froude u^2/gh | Footfall (left lead) | Duty factor | Trunk |
| --- | --- | --- | --- | --- |
| walk | below 0.4 | LH, LF, RH, RF, a quarter stride apart | 0.75 to 0.6 | two rises a stride, 2.5 % of withers |
| trot | 0.4 to 2.4 | diagonal pairs, half a stride apart | 0.48 to 0.36 | two rises, 5 % (about 8 cm) |
| canter | 2.4 to 6.5 | RH; LH and RF; LF; suspension | 0.46 to 0.36 | one rise and a rock |
| gallop | above 6.5 | RH, LH, RF, LF; suspension | 0.32 to 0.22 | one rise and a rock |

Stride length is 2.3 h (u^2/gh)^0.3 with h the hip joint height (Alexander and Jayes 1983): a riding horse covers
1.6 m a stride at 1.6 m/s, 2.8 m at 4 m/s, 3.9 m at 7 m/s and 6.4 m at 16 m/s. Gait changes by Froude number, so a pony
trots sooner than a Shire. Footfall timing is Hildebrand (1965, 1977), trot and canter stance Clayton (1993, 1994), trunk
motion Buchner et al. (1996).

```ts
import {horseBody} from 'margoengine/horses/anatomy';
import {gaitFor, stride, hoovesDown} from 'margoengine/horses/gaits';
const body = horseBody();
const s = stride(body, 7); // a canter
console.log(gaitFor(body, 7), s.length.toFixed(2), s.duty.toFixed(2), hoovesDown(s, 0.95)); // canter 3.92 0.41 0
```

## The model (`./model`)

`horseDocument(options)` returns the horse as a glTF 2.0 document and its buffers, for `parseGLTFAsync(engine, doc,
buffers)`; `horseGLB(options)` returns a `.glb` file. Five materials (`Coat` with vertex colours for points and markings,
`Hoof`, `Mane`, `Tail`, `Eye`), a skin of 37 joints (the fore limb swings from the scapula, the hind from the pelvis),
a `saddle` node on the trunk, and the clips `stand`, `walk`, `trot`, `canter` and `gallop`, each one stride long at its
speed (`speeds` sets them). A pair of planar inverse-kinematic solves places each elbow or stifle and then the
lower-leg hinge. The fore carpus stays nearly straight through loaded stance and flexes in early swing. The hind
hock folds on the opposite side of the limb and extends toward landing. Through late stance and lift-off the hoof
rolls about the toe and transitions continuously to the swing arc. The kinematics follow the swing and support
phases described in [The forelimb in walking horses, Hodson, Clayton and Lanovaz (2000)](https://pubmed.ncbi.nlm.nih.gov/10952376/),
[The hindlimb in walking horses, Hodson, Clayton and Lanovaz (2001)](https://doi.org/10.2746/042516401776767485), and
[Forelimb kinematics and net joint moments during the swing phase of the trot, Lanovaz, Clayton, Colborne and Schamhardt (1999)](https://doi.org/10.1111/j.2042-3306.1999.tb05225.x).
The gait curves are approximations of these patterns. `detail` 2, 1 or 0 gives about 11,000, 4,000 or 1,300 vertices.

The two forelegs straighten the carpus under weight, including if a skinned model's bind pose already bends it.
For a typical walk, the engine targets about 55 degrees of carpal fold, peaking near 76% of the full stride.
The fetlock drive follows at about 81%, and the elbow and coffin joint drive follow near 84%. The trot has a
larger carpal swing around 76 degrees and decelerates into landing. The angles and order follow [Hodson, Clayton
and Lanovaz, The Forelimb in Walking Horses: Kinematics and Ground Reaction Forces (2000)](https://doi.org/10.2746/042516400777032237),
[Clayton, Sha, Stick and Mullineaux, Three-Dimensional Carpal Kinematics of Trotting Horses
(2004)](https://doi.org/10.2746/0425164044848037), and the walking range summarized in [Jose L. Mendez-Angulo,
Effect of Water Level on Kinematics of Healthy Horses (2012), Table 1](https://conservancy.umn.edu/bitstreams/3a03b69d-656f-4f98-be2c-9706192aa746/download).

`fitHorseHooves` runs the leg solve directly for authored contact targets in model space. Pitch and roll are in
radians about +X and +Z, with zero as the default trunk slope. Each target applies its terrain angles to the base
hoof motion. The leg lengths and original bending sides are preserved. Turning the whole chain laterally is capped
at 0.35 radians. The live terrain controller uses this same method.

```ts
import { horseBody } from 'margoengine/horses/anatomy';
import { fitHorseHooves, horsePose, horseSkeleton, type HorseHoofTarget } from 'margoengine/horses/model';

const rig = horseSkeleton(horseBody());
const targets: HorseHoofTarget[] = rig.ground.map(([x, , z]) => ({
  point: [x, 0.1 * z, z],
  pitch: -Math.atan(0.1),
  roll: 0,
}));
const standingOnTheGrade = fitHorseHooves(rig, horsePose(rig, null), targets, -Math.atan(0.1));
console.log(standingOnTheGrade.rotations.length); // 37
```

Swing matches the planted hoof's local fore-aft velocity at lift-off and touchdown. During a gait change, the
controller matches hoof positions and short-term travel to select the incoming phase. The outgoing cadence eases out
as the new gait takes over. Timing comes from the support sequences in [*Symmetrical Gaits of Horses*, Milton Hildebrand
(1965)](https://pubmed.ncbi.nlm.nih.gov/5844074/). The contact and transition treatment draws on [*Footskate Cleanup for
Motion Capture Editing*, Lucas Kovar, John Schreiner and Michael Gleicher (2002)](https://graphics.cs.wisc.edu/Papers/2002/KSG02/)
and [*Automated Semi-Procedural Animation for Character Locomotion*, Rune Skovbo Johansen (2009)](https://runevision.com/thesis/rune_skovbo_johansen_thesis.pdf).

In a walk the fore fetlock yields as weight transfers and tucks relative to the cannon during swing.
The pose solver combines the cannon, pastern, and hoof at their local angles to maintain the planned sole path,
including the established departure from and return to the plant. It preserves segment lengths and leaves
the carpus and coffin flexion timed separately. References are [Hodson, Clayton and Lanovaz, *The Forelimb
in Walking Horses: 1. Kinematics and Ground Reaction Forces* (2000)](https://doi.org/10.2746/042516400777032237),
[Clayton, Hodson and Lanovaz, *The Forelimb in Walking Horses: 2. Net Joint Moments and Joint Powers*
(2000)](https://doi.org/10.2746/042516400777032174), and [Clayton, Sha, Stick and Elvin, *3D Kinematics of the
Equine Metacarpophalangeal Joint at Walk and Trot* (2007)](https://pubmed.ncbi.nlm.nih.gov/17546207/).

The scapula glides against the thorax through loading and swing. Both scapula translation channels are exported,
and the runtime solves the forelimbs from the changing attachment. The reference range for scapula glide is
[Lawson and Marlin, Preliminary Report Into the Function of the Shoulder Using a Novel Imaging Approach (2010)](https://doi.org/10.1111/j.2042-3306.2010.00289.x).

Three dock joints lead a stride-driven sway and five weighted hair joints follow with a phase lag.
Call `horse.flickTail(strength, side)` for a stronger swish at any gait. It lifts from the dock, sweeps toward
the chosen flank, and settles with a smaller return. The event is recorded on the timeline and survives `seek`.
Authored skins get the follow-through when their `applyPose` maps all eight tail joints. The measured separation
of the dock and trailing hair follows [Matherne, Cockerill, Zhou, Bellamkonda and Hu,
*Mammals Repel Mosquitoes with Their Tails* (2018)](https://doi.org/10.1242/jeb.178905). The flexible chain is a
kinematic approximation of bending and drag, informed by [Bertails, Audoly, Cani, Querleux, Leroy and
Lévêque, *Super-Helices for Predicting the Dynamics of Natural Hair* (2006)](https://doi.org/10.1145/1179352.1142012).

```ts
function swishOnTheWalk(horse: import('margoengine/horses').Horse) {
  horse.gait = 'walk';
  horse.speed = 1.5;
  horse.advanceTime(2);
  horse.flickTail(0.8, 'left');
  horse.advanceTime(0.32);
  return horse.pose;
}
```

| Option | Default |
| --- | --- |
| `type`, `withers`, `condition` | `'riding'`, the group mean, 1 |
| `coat` | `'bay'` (`bay`, `chestnut`, `black`, `grey`, `dun`, `brown`) |
| `markings` | none: `{socks: [LH, LF, RH, RF] heights in m, blaze: true}` |
| `maneLength`, `tailLength` | 0.11 and 0.55 times the withers height |
| `speeds` | each gait's preferred speed for this horse |
| `detail` | 2 |
| `atlas` | false: texture coordinates into the crowd coat atlas |

```ts
import {horseDocument, horseGLB} from 'margoengine/horses/model';
const {doc, clips} = horseDocument({type: 'draft', coat: 'grey', detail: 1});
console.log(clips.map((c) => c.name).join(' '), horseGLB({detail: 0}).byteLength > 0); // stand walk trot canter gallop true
```

## `addHorse`

| Part | Default | Option |
| --- | --- | --- |
| Coat hair (`@margoengine/materials/hair` along the body and down the legs) | 400 strands, specular 0.45 | `coatHair` or `false` |
| Mane and tail hair | 1024 strands | `maneHair` or `false` |
| Skinning | dual quaternion | |
| Start | `[0, 0]`, heading 0 (facing +Z) | `position`, `heading`, `ground(x, z)` |
| Speed and turning | 3 m/s^2, 1.2 rad/s | `acceleration`, `turnRate` |
| Gait change cross-fade | 0.3 s | `fade` |
| Shadows | the scene's `Shadows`, if any | `shadows`, `occlusion` |

`horse.speed`, `horse.heading` and `horse.gait` (`'auto'` or a forced gait) are kept on the film timeline.
`advanceTime(dt)` steps a fixed 1/240 s clock; `seek(t)` replays every set from time 0, so a sought frame is the frame
playing reaches. The stride phase is the distance travelled over the clip's stride length, so hooves never slide when
the speed changes; the stride frequency at a speed other than the clip's is the clip's stride length over the speed.

## Rider seat (`./seat`)

`riderSeat({height, thigh, knee})` places a rider's hips, knees, ankles, stirrups and rein hands in the saddle's frame,
with Winter's segment lengths (thigh 0.245, shank 0.246 of standing height). `mountRider(horse, person.model)` seats a
`@margoengine/humans` person: every step the rider hip rides the saddle through a damped spring (9 Hz, damping 0.8: the
pelvis follows the saddle closely and a little behind, Bystroem et al. 2009, Muenz et al. 2014), and the rider's root is
placed so its hip joint sits there, taking 0.4 of the trunk's pitch. The person plays its own riding clip; the seat's
knees, stirrups and hands are the targets for its leg and arm IK.

```ts
import {riderSeat, SeatFollower} from 'margoengine/horses/seat';
const seat = riderSeat({height: 1.78, knee: (115 * Math.PI) / 180});
const hip = new SeatFollower({frequency: 9});
hip.step(1 / 240, [0, 1.62, 0.17]); // feed the saddle point each step
console.log(seat.stirrups[0][1] < 0, hip.position[1]); // true 1.62
```

## Crowds (`./crowd`)

`addHorseCrowd(engine, options)` bakes the crowd-detail horse into a bone texture and draws every horse in one
`SkinnedCrowd` call with a coat atlas, so each horse has its own coat (`coats`, dealt in turn), place, heading, gait and
stride phase. `update(horses)` takes any list of `{x, z, heading, speed, distance}`: the members of a
`@margoengine/navmesh/formations` `Army` fit. Near a gait boundary the two clips blend by Froude number.
`herd.saddles` holds each horse's seat frame (16 numbers, column-major: +Y out of the seat, +Z to the head), read back
on the CPU from the same bone texture the GPU skins with (`poseBone` of `@margoengine/animation/instanced-skin`), so a
rider placed there rides the back the GPU draws: within 1.1 mm of the model's own saddle, rising and falling 7.4 cm in
the trot. `saddleFrame(trunk, saddle, horse)` is the same sum for one horse; `@margoengine/armies` seats a crowd of
riders on it.

```ts
import {Engine} from 'margoengine';
import {Army} from 'margoengine/navmesh/formations';
import {addHorseCrowd} from 'margoengine/horses/crowd';
const engine = await Engine.create(document.querySelector('canvas')!);
const army = new Army();
army.add({count: 31, kind: 'cavalry', shape: 'wedge'}).march({speed: 6});
const herd = await addHorseCrowd(engine, {type: 'cavalry'});
army.advanceTime(1 / 30);
herd.update(army.members);
console.log(herd.count, herd.saddles[13].toFixed(2)); // 31, and the first horse's seat height, about 1.5
```

## Settings (`./settings`)

`HORSE_SETTINGS` holds every option above as slider rows on the shared shape (`@margoengine/sky/settings` is the
model). `speed`, `gait`, `acceleration`, `turnRate` and `fade` are live; the rest rebuild. `horseOptionsFromSettings`
returns the `addHorse` options, the live motion values and the `mountRider` options.

```ts
import {horseOptionsFromSettings} from 'margoengine/horses/settings';
const {options, motion} = horseOptionsFromSettings({type: 'draft', coat: 'grey', speed: 1.5});
console.log(options.type, motion.speed); // draft 1.5
```

## Limits

A stance hoof keeps within 3 cm of where it struck through every gait, type and clip speed from 0.8 to 1.25 times the
preferred one; the canter and gallop come closest. The legs move in the side plane only (no abduction), and the
gallop is the transverse gallop on the left lead. The mane and tail are cards, shaded as strands, not simulated hair.
Riders in a crowd ride `herd.saddles` through `@margoengine/armies`.

## Sources

Carroll and Huntington 1988 (Equine Vet. J. 20:41); Buchner et al. 1997 (J. Biomech. 30:653) and 1996 (Equine Vet. J.
28:71); Brooks et al. 2010 (Anim. Genet. 41 s2:159); Holmstroem et al. 1990 (Equine Vet. J. 22:186); Hildebrand 1965
(Science 150:701) and 1977 (J. Mammal. 58:131); Alexander and Jayes 1983 (J. Zool. 201:135); Alexander 1989 (Physiol.
Rev. 69:1199); Hoyt and Taylor 1981 (Nature 292:239); Heglund, Taylor and McMahon 1974 (Science 186:1112); Clayton 1993
(Acta Anat. 146:183) and 1994 (Equine Vet. J. 26:230); Back and Clayton, Equine Locomotion, 2013; Winter, Biomechanics
and Motor Control of Human Movement, 2009; Bystroem et al. 2009 (Equine Vet. J. 41:280); Muenz, Eckardt and Witte 2014
(Hum. Mov. Sci. 33:227); Kajiya and Kay 1989 (SIGGRAPH).
