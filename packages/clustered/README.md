# @margoengine/clustered

Import `margoengine/clustered` from the `margoengine` package, or `@margoengine/clustered` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional clustered forward GGX lighting for up to 1,024 point/spot lights. A compute pass builds logarithmic-depth frustum AABBs and tests view-space light spheres and conservative spot-cone bounds. Fragment shaders calculate their screen/depth cluster and evaluate only its light list. This preserves forward alpha blending and does not require a deferred G-buffer.

```ts
import {EngineKernel,box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
const lights = Clustered.attach(engine); // 16 × 9 × 24
lights.setLights([
  {position:[0,2,1], range:12, color:[1,0.3,0.1], intensity:20},
  {position:[2,3,0], range:15, direction:[0,-1,0], innerAngle:0.3, outerAngle:0.7, color:[0.1,0.3,1], intensity:30}
]);
engine.start();
```

Positions and directions are world space; cone angles are radians up to π/2 (a hemisphere: everything in front of the light). Light radiance uses smooth range attenuation, inverse-square distance attenuation, and smooth inner/outer spot cones.

Crocotile's light parameters map one to one, with the falloff `@margoengine/bvh`'s vertex-light bake uses:

```ts
lights.setLights([
  {position:[0,3,0], range:0, decay:1, color:[1,0.8,0.6], intensity:4},                     // Distance 0: unlimited
  {position:[2,4,0], range:10, decay:2, direction:[0,-1,0], angle:0.5, penumbra:0.3, intensity:8},
]);
```

- Attenuation is `window / max(d^decay, 2^-12)` with `window = range > 0 ? clamp(1 - (d/range)^4, 0, 1)^2 : 1`.
  `decay` defaults to 2 (inverse-square); 0 turns distance falloff off. `range: 0` is unlimited (the light reaches every
  cluster); a light with a shadow map needs a finite range.
- A spot takes `angle` (half-angle, up to π/2) and `penumbra` (0 to 1, default 0) instead of `outerAngle`/`innerAngle`:
  the cone is `smoothstep(cos(angle), cos(angle * (1 - penumbra)), dot(-L, direction))`, so outer = angle and
  inner = angle × (1 − penumbra); penumbra 0 is a hard edge. Giving both forms throws.
- A light that sets neither `decay` nor `angle` keeps the original shader term (`d * d`, and the cone's 1e-5 floor) bit
  for bit, and while no light sets them the shaders are exactly the original ones. Once one does, the light loop
  evaluates each light by its own form, and so does the volumetric fog's froxel loop in `@margoengine/environment`
  (the same terms, from one shared definition). `setLights()` replaces the list, validates all entries before changing it, and uploads only when called. Animate lights by calling it before rendering. Camera transformations and culling happen on the GPU.

`lights.intensityScale` multiplies all local light radiance and defaults to 1.
Set a nonnegative finite GPU-float value or a callback sampled each render, such
as `() => sky.nightFactor` for automatic night lights. Zero clears the GPU cluster
lists; authored intensities remain unchanged. The setting survives restoration.

Core meshes receive local lighting automatically. Call `lights.add(pbrModel)` or `lights.add(terrain)` for optional renderers; the returned function unregisters the receiver. `lights.add(model, {receiveShadow: false})` lights it without any local-light shadow (integrated maps or `LocalShadows`); casting stays per object through `addShadowCaster` / `LocalShadows.add`. A core mesh with `mesh.receiveShadow = false` (core) is lit without local-light shadows too; the core shader patch carries that test only while some mesh opts out. Directional shadows compose with local lighting in either registration order.

## Light size: sphere lights

A point or spot light's `radius` (world units, default 0) makes it a sphere of light, as a bulb, a candle flame or a
fire is. Its highlight on a smooth surface is the reflection of a disc of that size, and it can never be brighter than
the sphere itself, however close the surface comes; a point light's highlight grows without limit as the surface
nears it. A `castShadow` light's radius also sizes its soft `LocalShadows` shadow (see "Soft point and spot shadows").

```ts
import {EngineKernel, PbrMaterial, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend: 'webgpu'});
// A polished copper box 15 cm under a flame-sized light: a 0.155 m sphere, not a point.
engine
  .createMesh()
  .setGeometry(box(0.3, 0.3, 0.3))
  .setMaterial(new PbrMaterial({color: [0.95, 0.64, 0.54], roughness: 0.1, metalness: 1}));
const lights = Clustered.attach(engine);
lights.setLights([{position: [0, 0.3, 0], range: 6, color: [1, 0.48, 0.17], intensity: 4.5, radius: 0.155}]);
engine.start();
```

- The method is Karis 2013 ("Real Shading in Unreal Engine 4", sphere lights): the specular takes its light direction
  from the point of the sphere nearest the reflection ray, and GGX D there is scaled by (alpha / alpha')^2, with alpha'
  = alpha + radius / (2 distance), so the lobe keeps its energy. Margo widens alpha' anisotropically, along the plane of
  incidence by radius / (2 distance (v.h)) (the half-vector Jacobian of Walter et al. 2007), so grazing views stay
  bounded too, and keeps alpha' at least radius / (2 distance) inside the source.
- Diffuse is the sphere's irradiance: its radiance, intensity / (pi radius^2), times the cosine-weighted solid angle of
  the cap it fills (Snyder 1996, "Area Light Sources for Real-Time Graphics"; Lagarde and de Rousiers 2014, "Moving
  Frostbite to Physically Based Rendering", section 4.7 (area lights); Howell's configuration factor B-43). Above the horizon and
  outside the sphere that is exactly the point light's intensity x cos / distance^2; a sphere dipping below the
  horizon still lights the surface with the part above it, and a surface inside the sphere is lit as one touching it,
  at most intensity / radius^2, where a point light's inverse square grows without limit (a wall 0.09 m from a 0.634 m
  fire sphere took 50 times that). Materials' Lambert and Phong get the same irradiance. The specular follows the
  representative point's own horizon, so a sphere partly below it still shows its visible part. The falloff window
  (`range`) applies as before; the bound is for the default inverse square (`decay` 2).
- Diffuse bound, measured: a Lambert plane at any tilt (0 to 170 degrees off the light) and distance (a tenth of the
  radius to 10 radii) receives the closed form within 0.01% and never more than intensity / radius^2 (radius 0.634,
  0.155 and 0.02; same GPU check, WebGPU and the WebGL2 layer). Cabin Hearth firebox back, flame spheres of 0.634 m:
  the flames over the logs (lane B's five lines, bloom on) peak at 98 to 141 display levels, from 17 to 70 when the
  wall was lit by inverse square.
- Bound, measured: where the reflection meets the light, a metal's specular is at most F x intensity / (pi radius^2),
  the sphere's radiance times its Fresnel, at every distance (a quarter of the radius to 40 radii), roughness 0 to 0.6
  and view angle 0 to 85 degrees, and it equals the closed form within 0.1% (`scripts/clustered-sphere-light-gpu-check.js`,
  `npm run test:gpu:sphere`, on an RTX A6000, WebGPU and the WebGL2 layer; peak at most 1.00001 of the bound). A point
  light at one radius' distance gives 60,966 times the bound. The Cabin Hearth kettle spout (copper, roughness 0.32)
  0.08 to 0.15 m from the two fire points: peak linear luminance 814 as points, 16.2 with the flames' radius 0.155.
- Off is exact: while no light has a radius above 0, the light records (16 floats), the culling pass and every shader
  are the point lights' ones, byte for byte. Once one does, each record gains one vec4f (20 floats) and the light loop
  the sphere terms; a light of radius 0 in that list still shades bit for bit as before (GPU-checked). Cost: one
  reflection, two normalisations and two selects per light and pixel, plus an acos, an atan2 and three square roots
  where the sphere crosses the horizon, only while some light has a radius.
- Limits: `ShapeLights`
  sphere lights are a separate, LTC-shaded kind without shadows. Toon materials and the physical lobes (clearcoat,
  sheen) keep their own terms, lit from the centre by inverse square. Inside the sphere the cap is taken as the
  hemisphere it is at the sphere's surface (continuous there), not the full sphere of directions a point inside a
  shell of light would see.

## Directional lights

`@margoengine/clustered/directional` adds up to 16 directional lights beside core's one sun,
shaded in the same light loop as the point lights:

```ts
import {EngineKernel} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {DirectionalLights} from 'margoengine/clustered/directional';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine), suns = DirectionalLights.attach(engine, {lights});
suns.setLights([{direction: [-1, -2, 0.5], color: [1, 0.9, 0.8], intensity: 3}]); // direction: the way the light travels
```

`intensity` is the illuminance on a surface facing the light (lux in physical units), as core's sun. The lights use the
point lights' GGX and Lambert BRDF text, so materials' Lambert and Phong shade them with their own BRDF and a
`ShadowCatcherMaterial` counts them; `intensityScale` scales them. Every fragment evaluates every directional light
(they reach everywhere, so they are not culled). With `castShadow` they are shadowed by `LocalShadows` (see
[Directional and area light shadows](#directional-and-area-light-shadows)). The storage buffer (binding 141 of the lit
shader's group) and the shader code exist only while the list is not empty: an empty or absent `DirectionalLights`
leaves every GPU call unchanged. `lights.list` and `suns.list` return the lists last set (frozen copies).

## Every lobe under every light

A clustered light reaches a physical material as plain GGX on the base by default. `physicalLobes` lights its other
layers too: clearcoat, sheen, anisotropy and the thin film answer every point, spot and extra directional light, with the
same falloff, cone, profile and shadow as the base, and clearcoat answers every area light. Under the sheen each of those
lights dims the base by KHR_materials_sheen's punctual albedo scaling, as the main directional light does. Shaders without those lobes
keep their text, and the code loads only if you import it.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {physicalLobes} from 'margoengine/clustered/physical-lobes';
import {PbrMaterial, createMesh} from 'margoengine/materials';

const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'webgpu'});
const lights = Clustered.attach(engine);
lights.lobes = physicalLobes; // set it to undefined to go back
lights.setLights([{position: [0, 2, 1], color: [1, 1, 1], intensity: 8, range: 20}]);
const panel = {positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3]};
lights.add(createMesh(engine, panel, new PbrMaterial({color: [0.1, 0, 0, 1], clearcoat: 1})));
```

Area lights light the coat through its own Linearly Transformed Cosines; their sheen, anisotropy and thin film stay out,
because each would need its own fitted table. The `clearcoat()` model extension of `@margoengine/materials` keeps its coat
under the directional light only. Cost: a second GGX and a sheen term per light, on physical materials alone. Set
`lights.lobes` yourself: shaders compose synchronously, so the entry cannot load itself when a physical surface appears.

## Flicker and a shadow budget

Two small entries that work on your light list, on the CPU.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {animateFlicker, flickerAt} from 'margoengine/clustered/flicker';
import {shadowBudget} from 'margoengine/clustered/budget';

const engine = await Engine.create(document.querySelector('canvas')!);
const lights = Clustered.attach(engine, {shadows: {maxLights: 4}});
// candle, fire, fluorescent, pulse, strobe or your own function of seconds.
const stop = animateFlicker(engine, lights, [
  {position: [0, 2, 0], range: 8, intensity: 5, flicker: {curve: 'candle'}},
  {position: [3, 2, 0], range: 8, intensity: 5, flicker: {curve: 'fluorescent', speed: 0.5, seed: 2}},
]);
console.log(flickerAt('fire', 1.5));
stop();
// Shadow texels shared by importance: nearer, brighter lights get bigger maps and the rest stop casting.
lights.setLights(shadowBudget([
  {position: [0, 2, 0], range: 8, castShadow: true},
  {position: [9, 2, 0], direction: [0, -1, 0], outerAngle: 0.6, range: 8, castShadow: true},
], {viewer: engine.camera.position, texels: 1024 * 1024}));
engine.start();
```

`shadowBudget` budgets what is drawn each update, with a point light paying for six faces. The shadow texture array
keeps the size its `resolution` and `maxLights` set, so call it again when the camera moves far, not every frame.
`stop()` puts the steady lights back. A `Clustered` or light group disposed first (`isDisposed`, as when the engine or
the scene goes before the code that stops the flicker) gets nothing more from the flicker, and `stop()` is then safe;
`setLights` on a disposed `Clustered` throws `MargoError` `'disposed'`.

### Flames from temperature and lumens

`flameLight` (`@margoengine/clustered/flicker`) makes a flame's point light from what can be measured: its colour
from its colour temperature (`blackbodyColor`, `@margoengine/math/color`) and its intensity so that, averaged over its
flicker, it gives `lumens / 4 pi` candela. `hurricaneLantern` is a measured kerosene hurricane lantern.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {animateFlicker, flameLight, hurricaneLantern} from 'margoengine/clustered/flicker';

const engine = await Engine.create(document.querySelector('canvas')!);
const lights = Clustered.attach(engine);
const stop = animateFlicker(engine, lights, [
  {position: [0, 1.2, 0], ...hurricaneLantern()},
  {position: [2, 0.3, 0], ...flameLight({kelvin: 1860, lumens: 48, range: 9, curve: 'fire'})},
]);
engine.start();
```

| `flameLight` option | Default | Meaning |
| --- | --- | --- |
| `kelvin` | required | Colour temperature, 1,667 to 25,000 K. |
| `lumens` | required | Luminous flux averaged over the flicker, 0 or more, over 4 pi sr. |
| `range` | required | `PointLight` range in metres, above 0. |
| `curve` | `'candle'` | `'candle'` (mean 0.9) or `'fire'` (mean 0.75): `flameFlickerMean`. |
| `speed`, `seed` | 1, 0 | Flicker speed and seed. |
| `radius` | 0 | The flame's half width in metres (`PointLight.radius`): a sphere light, and the `shadow.radius` of a `castShadow` light, so its shadows get a flame's penumbra. 0 is a point. |

`hurricaneLantern({seed, globe})` (seed default 0): 1,900 K (a kerosene flame; measured kerosene flames 1,580 to 2,290 K,
Tatsuta, Trans. JSME B 72(720), 2006, doi:10.1299/kikaib.72.1875), 82 lm (the brightest hurricane lantern on Mills'
goniophotometer, LBNL 2003; 6.53 cd), `'candle'` at speed 0.6, range 18 m (its window keeps 0.99 of the inverse
square within 4.9 m), radius 0.011 m (`HURRICANE_FLAME_RADIUS`: its 22 mm flat wick, Mills 2003, over 2). A shadow
edge d_o from the flame lands on a receiver at d_r with a penumbra 2 x 0.011 x (d_r - d_o) / d_o wide; until
2026-11-16 the lantern was a point with hard shadows (KB-CABIN-GROUNDEDGE1). `globe` (default `'clear'`) is the
lantern's glass: `'frosted'` or `'sooted'` glass scatters the flame's light, so it leaves from the whole globe and
`radius` is `HURRICANE_GLOBE_RADIUS`, 0.065 m, about six times softer shadow edges. That is the sphere with the side-on
area of a Dietz No. 2 Blizzard globe (the 22 mm wick lantern; 171 mm tall, 86 mm and 70 mm across its base and top,
Lehman's replacement globe dimensions). The light's colour and flux stay the clear lantern's; how much soot dims a
globe depends on the soot, so give `flameLight` your own `lumens` for a dimmer one.

```ts
import {hurricaneLantern} from 'margoengine/clustered/flicker';

const softer = hurricaneLantern({globe: 'frosted'});
console.log(softer.radius); // 0.065
```

A flame is seen as well as lit by. `flameEmission(light, area?)` gives the radiance the flame's surface shows: the
light's intensity over its projected area, by default `pi radius^2`, the area its sphere light shows from every side, so
the flame is exactly as bright as the light it gives. A hurricane lantern's 6.53 cd over its 11 mm flame is 17,000
cd/m2 averaged over the flicker. It returns `emissive` (the light's colour) and `emissiveIntensity` to spread into an
emissive material; `animateFlicker(engine, lights, list, {emitters})` scales each light's emitter by that light's
flicker every frame and puts its steady value back on stop. Draw the flame with the area you give: an ellipsoid with
semi-axes `a` across and `b` up shows `pi a b` from the side. Before KB-CABIN-BLOOM1 the Cabin Hearth's lantern flame
was a lit cone, as dark as the iron round it, and nothing round the lantern glowed; now its glow round the lantern
measures its bloom's prediction from this radiance (`scripts/cabin-hearth-browser-test.mjs`).

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {animateFlicker, flameEmission, hurricaneLantern} from 'margoengine/clustered/flicker';
import {UnlitMaterial, createMesh} from 'margoengine/materials';
import {sphereGeometry} from 'margoengine/geometry';

const engine = await Engine.create(document.querySelector('canvas')!);
const lights = Clustered.attach(engine);
const lantern = {position: [0, 1.2, 0] as [number, number, number], ...hurricaneLantern()};
const flame = new UnlitMaterial({color: [0, 0, 0], ...flameEmission(lantern)});
// 16.5 mm across and 29 mm tall: pi 0.00825 x 0.0147 = pi 0.011^2 from the side.
createMesh(engine, sphereGeometry(lantern.radius, 16, 12), flame).root.setPosition(lantern.position).setScale([0.75, 4 / 3, 0.75]);
const stop = animateFlicker(engine, lights, [lantern], {emitters: [flame]});
engine.start();
```

### Light through an opening

`openingLight` (`@margoengine/clustered/area`) is the light a lit room sends out of a window or doorway: a one-sided
rectangle filling the opening at the room's mean radiance, from the room's surfaces (area and reflectance) and the
lights in it. The lights' own rays through the opening stay theirs (their shadows draw them); this is what the room
reflects, bounce after bounce: an integrating sphere with ports (Goebel, "Generalized Integrating-Sphere Theory",
Applied Optics 6(1), 1967, doi:10.1364/AO.6.000125; the split-flux enclosure sum of Hopkinson, Longmore and
Petherbridge, Trans. Illum. Eng. Soc. 19(7), 1954), per channel `rho Phi (1 - f) / (pi A (1 - rho (1 - f)))`, `f` the
openings' share of the area. A flickering flame counts at its time average (`flameFlickerMean`). It lights the sill, the
snow under a window and the eaves; `VolumetricFog` scatters it too.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {AreaLights, openingLight} from 'margoengine/clustered/area';
import {hurricaneLantern} from 'margoengine/clustered/flicker';

const engine = await Engine.create(document.querySelector('canvas')!);
const lights = Clustered.attach(engine);
const lamp = {position: [1.2, 1.9, 1.9] as [number, number, number], ...hurricaneLantern()};
lights.setLights([lamp]);
AreaLights.attach(engine, {lights}).setLights([
  openingLight({
    position: [1.2, 1.5, 2.67], direction: [0, 0, 1], width: 1.2, height: 1.1,
    room: [{area: 50, reflectance: [0.26, 0.21, 0.15]}, {area: 54, reflectance: [0.16, 0.07, 0.03]}],
    lights: [lamp],
  }),
]);
engine.start();
```

| `openingLight` option | Default | Meaning |
| --- | --- | --- |
| `position`, `direction`, `width`, `height`, `up` | required (`up` [0, 1, 0]) | The opening's outer face, as a `RectAreaLight`; `direction` points out of the room. |
| `room` | required | The room's inner surfaces, `{area, reflectance}` (reflectance one number or linear RGB, 0 to below 1), openings excluded. |
| `lights` | required | The room's point lights (`color`, `intensity` in cd, `flicker`). |
| `openings` | 0 | Area of the room's other openings, square metres. |
| `glazing` | `'clear'` | `'clear'` or `'frosted'`: the glass in the opening (below). |
| `frost` | 1 | How far frost has grown in from the edges, 0 to 1, for frosted glazing: a border `frost x min(width, height) / 2` wide is frosted. |
| `transmittance` | `FROSTED_GLAZING.transmittance`, 0.637 | Diffuse transmittance of the frosted glass, 0 to 1. |
| `recess` | 0 | How far the wall's outer face stands in front of `position`, metres: the opening's sides reach that far out and shade what its light lights (the light's `recess`, below). |
| `sill` | 0 | How far a sill under the opening stands proud of the wall's outer face, metres (the light's `sill`). |

The light holds the room's time-averaged radiance (it does not flicker) and casts no shadow map; it lights only what is
in front of the opening's plane, so the wall's own faces beside it stay dark, as they do outside a real window. Set back
in a thick wall (`recess`, `sill`), it lights each point only through the part of the opening that point sees past the
opening's sides and sill, so the snow right under a deep sill stays dim.

#### A light set back in its wall: `recess` and `sill`

Any one-sided `RectAreaLight` may sit back in a wall: `recess` (default 0) is how far the wall's opening, the light's
own outline, reaches in front of it, and `sill` (default 0) how far a sill level with its lower edge stands proud of
the wall's face. Each fragment then integrates the part of the rectangle it sees through that opening: the opening's
outline projected from the fragment onto the light (the backprojection of Drettakis and Fiume, "A Fast Shadow
Algorithm for Area Light Sources Using Backprojection", SIGGRAPH 1994, doi:10.1145/192161.192207; Nishita and
Nakamae, SIGGRAPH 1985, doi:10.1145/325165.325169), a smaller rectangle that the LTC integral takes exactly. A point
inside the opening sees the whole light, one beside it on the wall's face or under the sill sees none. The shader code
is in the light loop only while some light has a `recess` or `sill`; changing them later only rewrites the light data.
`LightBounce` reflects an opening's light with the same clip (`rectIrradiance`), and `apertureWindow` is its JS form.
The voxel path tracer traces its scene's own walls and ignores both. Checked against a traced wall and sill (boxes, a
slab test per sample) to 1% in packages/clustered/test/area.test.js and test/bounce.test.js, and on a GPU in
examples/package-benchmarks/area-lights-gpu.mjs (RTX A6000, WebGPU and the WebGL2 layer: the frame equals the CPU
mirror to 1/255 on core and materials floors, and the reveal shades all 89 lit floor samples by more than 10 codes).

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {AreaLights} from 'margoengine/clustered/area';

const engine = await Engine.create(document.querySelector('canvas')!);
const lights = Clustered.attach(engine);
// A window 1.2 x 1.1 m whose glass sits 0.22 m behind the wall's face, over a sill 0.09 m proud of it.
AreaLights.attach(engine, {lights}).setLights([
  {position: [0, 1.5, 2.45], direction: [0, 0, 1], width: 1.2, height: 1.1, intensity: 3, recess: 0.22, sill: 0.09},
]);
engine.start();
```

#### Frosted glazing

A winter window frosts over inside, and the frost spreads the light. With `glazing: 'frosted'` the opening also sends
out the lamps' own light: the frost takes in what falls on its room side and re-emits it diffusely, a Lambertian
transmitter of radiance `L(x) = tau_d E(x) / pi` at each point x. E(x) is each lamp's intensity times the cosine at x
over the squared distance (point lights radiate evenly), wherever the segment from x to the lamp clears the glazing bars
and leaves the room through the opening's `reveal`, plus the room's own radiance from the whole hemisphere,
`pi L_room`. So the pane is brightest nearest the lamp and dimmest in the corner farthest from it, and the bars and the
frame shade the frost behind them. Each light then needs its `position`.

The pane must stop the lamps' beams: build it with `generateWindowPane` (`@margoengine/procedural`) with the same
`glazing`, `frost`, `lites`, `barWidth`, `barDepth` and `thickness`, add its glass and its bars to `LocalShadows` as
casters, and give `position` the glass's outdoor face (the frost lies `thickness` behind it). `lites` (default `[1, 1]`)
divides the glass with glazing bars, `barWidth` wide (default 0.03) and `barDepth` deep (default 0.035), centred on the
glass; `reveal` (default 0) is how far the opening's sides reach into the room behind the frost.

`openingLight` is the opening's mean radiance: the frosted glass's `L(x)` integrated exactly (a lamp's irradiance
integrates over a rectangle to its intensity times the solid angle the rectangle fills, by van Oosterom and Strackee's
formula, IEEE Trans. Biomed. Eng. BME-30(2), 1983, and the lit part of each lite is a set of rectangles), the room's
radiance through any clear glass, and nothing from the bars, over the opening's area. So the area light carries the
pane's flux. `glazingSurface(options)` gives the pane's two faces as `PbrMaterial` options of `@margoengine/materials`:
outside, the frost's reflectance and the light it sends out, `emissive` white times `emissiveMap` (the radiance over the
pane, `mapSize` texels along its longer side, default 256, sRGB RGBA8 on the pane's UVs) times `emissiveIntensity` (its
brightest radiance); inside, the frost's reflectance, lit by the room. The lamps are read where they are given, so call
it again when one moves; a flame lamp counts at its flicker mean, so the glow does not flicker. The window then glows
milky, warmest round the lamp, its bars dark across it, and its patch on the snow is a soft glow with no window-bar
lines in it.

`FROSTED_GLAZING` is 3 mm float glass (transmittance 0.90, Rubin, "Optical properties of soda lime silica glasses",
Solar Energy Materials 12(4), 1985) frosted over: frost is ice, which absorbs next to no visible light (Warren and
Brandt, J. Geophys. Res. 113, D14220, 2008), with asymmetry g = 0.89 (Warren, "Optical properties of snow", Rev.
Geophys. 20(1), 1982); frosted over means an optical depth of 5, where 0.7% of the light still passes unscattered, and
a conservative scattering layer lets through `1 / (1 + 3 (1 - g) tau / 4)` = 0.708 of it (the Eddington approximation,
Shettle and Weinman, J. Atmos. Sci. 27(7), 1970), so `transmittance` 0.637 and `reflectance` 0.292.

```ts
import {Engine} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
import {AreaLights, glazingSurface, openingLight} from 'margoengine/clustered/area';
import {hurricaneLantern} from 'margoengine/clustered/flicker';
import {generateWindowPane} from 'margoengine/procedural';
import {createMesh, PbrMaterial, Texture} from 'margoengine/materials';

const engine = await Engine.create(document.querySelector('canvas')!);
const lights = Clustered.attach(engine);
const lamp = {position: [1.2, 1.9, 1.9] as [number, number, number], ...hurricaneLantern(), castShadow: true};
lights.setLights([lamp]);
// Four lites, the glass's outdoor face at z 2.452, the frame's sides reaching 0.12 m into the room behind it.
const sash = {lites: [2, 2] as [number, number], barWidth: 0.045, barDepth: 0.05};
const opening = {
  position: [1.2, 1.5, 2.452] as [number, number, number], direction: [0, 0, 1] as [number, number, number],
  width: 1.2, height: 1.1, glazing: 'frosted' as const, ...sash, reveal: 0.12,
  room: [{area: 50, reflectance: [0.26, 0.21, 0.15] as [number, number, number]}], lights: [lamp],
};
AreaLights.attach(engine, {lights}).setLights([openingLight(opening)]);
const look = glazingSurface(opening),
  glass = generateWindowPane({width: 1.2, height: 1.1, glazing: 'frosted', ...sash}),
  glow = new Texture(look.emissiveMap, {wrapS: 'clamp', wrapT: 'clamp'}),
  pane = createMesh(engine, glass.frosted, [new PbrMaterial({...look.outside, emissiveMap: glow}), new PbrMaterial(look.inside)]),
  bars = createMesh(engine, glass.bars, new PbrMaterial({color: '#5a4330', roughness: 0.75}));
for (const mesh of [pane, bars]) {
  mesh.root.setPosition([1.2, 1.5, 2.45]);
  lights.add(mesh);
}
const shadows = LocalShadows.attach(engine, {lights});
shadows.add(pane);
shadows.add(bars);
engine.start();
```


## Bounce light

`@margoengine/clustered/bounce` gives the point, spot and opening lights one bounce: lantern-lit snow lights the logs
round the window, a lit wall lights the floor under a table. `LightBounce.attach(engine, {lights})` is all it takes:
every `castShadow` point and spot light bounces (a light's `bounce: true` adds one without a shadow map, `bounce:
false` leaves one out), diffuse only, added to the lit shader through the `Clustered.bounce` hook.

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LightBounce} from 'margoengine/clustered/bounce';

const engine = await Engine.create(document.querySelector('canvas')!);
const grey = new PbrMaterial({color: [0.8, 0.8, 0.8], roughness: 1});
engine.createMesh().setGeometry(box(2, 0.1, 2)).setPosition([0, -0.05, 1]).setMaterial(grey); // a lit patch
engine.createMesh().setGeometry(box(6, 3, 0.1)).setPosition([0, 1.5, -0.05]).setMaterial(grey); // the wall it lights
const lights = Clustered.attach(engine);
lights.setLights([{position: [0, 6, 1], direction: [0, -1, 0], angle: 0.5, range: 0, intensity: 40, bounce: true}]);
const bounce = LightBounce.attach(engine, {lights}); // vpls 32, resolution 32, refresh 1, occlusion true
engine.start();
// A glTF model reflects the bounce too once added: const removeModel = bounce.add(await loadGLTF(engine, url));
console.log(bounce.stats); // {captures, vpls, sources, occluders}
```

Options, each checked (RangeError out of range): `maxLights` 4 (1 to 4, strongest first), `vpls` 32 per source (8 to
128), `resolution` 32 texels per capture view (8 to 128), `visibility` 32 (8 to 64, the visibility map per VPL),
`near` 0.15 m (surfaces nearer a source do not bounce: a lamp's own fixture), `intensity` 1 (0 to 16; 1 is physical),
`occlusion` true, `refresh` 1 view captured again each frame round robin (0: only new sources and after
`invalidate()`), `openings` (up to 4 `{light: openingLight(...), glazing, lites, barDepth}`, below; give the window's
`lites` and `barDepth` as `openingLight` takes them, so its capture looks out from in front of the glazing bars). Light
colours and intensities are read every frame, so a flicker or a dimmer has no lag; a capture is redone only when a
source moves, round robin, or 120 frames after its last readback. WebGPU and the WebGL2 layer from its half-float tier (the LDR tier would clamp
distances: coded `unsupported`). The capture draws core's meshes with the frame's own lit shader, so Snow and every
other surface hook are in it. `bounce.add(model)` adds a gltf/pbr model, a `@margoengine/materials` mesh
(`createMesh`), a `Terrain` or anything else with the capture hook SSR uses (`setCapture`): its own materials (maps,
alpha mask, instances, skinning) are drawn into every capture after the core meshes, depth tested against them, so a
glTF floor bounces as a core floor does (the GPU check matches them exactly), and adding or removing one captures every
source again. A clearcoat, a materials `Material`'s or a glTF one drawn by `materials.install`, keeps the base layer's
1 - F_coat(n.v) share of the albedo, as the beauty pass does (0.955 of the uncoated patch head on). It returns a
remover, and `dispose()` releases every added model. A model not added receives the bounce but does not reflect it;
blended, transmissive and unlit primitives are left out of the capture, as SSR leaves them out. An added gltf/pbr
model or materials mesh also stops the bounce in the visibility maps: the triangles its captures draw (each instance,
nodes shown in the scene) join core meshes' as occluders, so a glTF wall no source sees keeps a room dark
(`bounceModelMeshes`; skinned primitives, terrain and voxel occlude through their captures only, docs/limits.md). A lamp bounces the light it casts: its IES profile, projector image or cube cookie and its layers
weigh what each captured surface gets, as they weigh its direct light (below). GPU cost per bouncing source: one draw of the core
meshes per refreshed view at 32 x 32, about 100 KB of targets and readback buffers and 130 KB of storage buffer, and 32 VPLs per
fragment in the light loop.

A shaped lamp bounces its own shape: each light term the light loop multiplies in (`IESLights`, `ProjectorLights`,
`CubeProjectorLights`, `LightLayers`) has a CPU twin of its factor in the bounce entry, read from the very words the
shader reads (so a user of those terms who does not bounce pays no byte for it), and each captured texel's flux is
weighed by it toward that texel; a term of your own gives its twin as `ClusteredLightTerm.emission`. A wall
washer that is dark straight down lights the floor in a ring and bounces off the ring, not off the spot under it; a
projector's red and blue halves bounce red and blue light. `lightEmission(lights, index)` gives that weight for any
light of the list. Layers: the capture draws core meshes, which are on layer 0, so a light off layer 0 bounces nothing
(its bounced light, coming off a surface, lights every receiver, as a path tracer's light linking does). Setting a
term's entries again (`setProfiles`, `setProjectors`, `setCubes`, `setLayers`) captures its sources afresh. Sources:
a reflective shadow map's texel carries the flux the light emits into its solid angle, its intensity toward the
texel (C. Dachsbacher and M. Stamminger, "Reflective Shadow Maps", I3D 2005, doi:10.1145/1053427.1053460, section 3);
instant radiosity starts its particles with the light's own emission distribution (A. Keller, "Instant Radiosity",
SIGGRAPH 1997, doi:10.1145/258734.258769); an IES file's candela table is that distribution
(ANSI/IES LM-63-19, "Approved Method: IES Standard File Format for the Electronic Transfer of Photometric Data and
Related Information", 2019).

```ts
import {Engine, PbrMaterial, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {IESLights, parseIES} from 'margoengine/clustered/ies';
import {LightBounce, lightEmission} from 'margoengine/clustered/bounce';

const engine = await Engine.create(document.querySelector('canvas')!);
const grey = new PbrMaterial({color: [0.8, 0.8, 0.8], roughness: 1});
engine.createMesh().setGeometry(box(4, 0.1, 4)).setPosition([0, -0.05, 1]).setMaterial(grey); // the floor
engine.createMesh().setGeometry(box(6, 3, 0.1)).setPosition([0, 1.5, -1.05]).setMaterial(grey); // a wall
// LM-63 text of a wall washer (candela by vertical angle): dark straight down, 1,000 cd from 30 to 60 degrees.
const washer = parseIES(`IESNA:LM-63-2002
TILT=NONE
1 -1 1 4 1 1 2 0.1 0.1 0
1.0 1.0 20
0 30 60 90
0
50 1000 1000 200
`);
const lights = Clustered.attach(engine);
lights.setLights([{position: [0, 2, 1], range: 0, intensity: washer.peak, bounce: true}]); // the file's own candela
IESLights.attach(engine, {lights}).setProfiles([washer]);
LightBounce.attach(engine, {lights});
engine.start();
const weigh = lightEmission(lights, 0)!;
console.log(weigh([0, 0, 1]), weigh([1.5, 0, 1])); // about 0.05 under the lamp, 1 at 37 degrees from straight down
```

The method, from four papers:

1. Capture: a reflective shadow map per source (Dachsbacher and Stamminger 2005), the albedo and distance of the
   first surface along each texel's ray: six cube faces for a point light, one view fitted to a narrow spot's cone,
   five faces out of an opening.
2. Reduce: every texel reflects albedo x irradiance x area (area d^2 omega / max(cos, 0.1), omega the texel's exact
   solid angle); strata of equal flux in Morton order seed a k-means in position and normal (Prutkin, Kaplanyan and
   Dachsbacher 2012) and in offset from the cluster's plane (variational shape approximation's L2 proxy distance,
   Cohen-Steiner, Alliez and Desbrun 2004, so a sill and the snow under it stay apart), and each cluster is one virtual point light (instant radiosity, Keller 1997) with the cluster's
   flux and area. No random seeds, so a still scene never flickers. Each VPL stands at its cluster's centroid lifted
   along its normal to the cluster's highest texel: on a convex surface (a snow drift, a log) the centroid lies under
   the surface, inside the surfels its own texels draw, and the VPL would be hidden from everything
   (KB-BOUNCE-VPL-BURIED1).
3. Gather: E(x) = sum_j flux_j max(n_j.w, 0) max(-n.w, 0) / (pi r^2 + A_j), the disc form factor of Wallace,
   Elmquist and Haines 1989, so a receiver beside a VPL sees no spike; the shader adds base (1 - metal) / pi x E.
4. Visibility: imperfect shadow maps (Ritschel et al. 2008). Each VPL has a paraboloid depth map (32 x 32 by
   default) of the captured surface points drawn as surfels. Each surfel is an ellipse 1 / cos longer along the ray
   that saw it than across, as a grazing texel's footprint is (Heckbert 1989; elliptical splats, Zwicker et al. 2001,
   Botsch et al. 2005), and takes its normal from the neighbours on its own surface (the side whose next two texels
   run straight on), so a wall seen at grazing angles leaves no gaps and its foot does not tilt toward the floor
   (KB-BOUNCE-SHADOWSNOW1). Besides the captured points, every triangle core draws is an occluder, so a wall no
   source sees (the front wall behind a table) still hides the room (`sampleSurfaces`, below): a triangle whose
   circumradius is at least the cell size 2^floor(log2(2 d / resolution)) is drawn exactly, each texel's centre ray
   against it (Moller and Trumbore 1997), d its distance to the nearest VPL in front of it, and smaller ones (a far
   tree's leaves) merge per cell into one covering surfel, so the detail follows the solid angle each VPL sees, as
   view-adaptive imperfect shadow maps do (Ritschel et al. 2011; Hollander et al. 2011, ManyLoDs). A triangle tests
   only the 4 x 4 texel tiles of a map its three edge planes through the VPL can reach (edge functions, Olano and
   Greer 1997; whole tiles, Pineda 1988), with the same maps: on Cabin Hearth 69 million rays and 0.7 s a rebuild
   against 235 million and 11.7 s with every texel of the triangles beside a VPL (KB-SHOT-COMPAT-SKYCOV1;
   `buildVisibility` `stats.rays` counts them). Surfaces no VPL
   faces are skipped, triangles nearer a VPL than 0.02 m are its own patch (the map's near plane), and meshes a
   package draws itself (`@margoengine/materials` glass, gltf-pro, terrain) occlude only through the captures. A receiver is compared where its own
   tangent plane meets the texel's centre ray (adaptive depth bias, Dou et al. 2014), so a floor does not shadow
   itself and a 0.3 m wall keeps a lit room's bounce out of the next. That plane stands in for the receiver only
   where the texel holds the receiver's own surface: each texel keeps its surface's normal beside its depth (one
   float, hemi-octahedral, Meyer et al. 2010; Cigolle et al. 2014), as an object-ID shadow buffer keeps which surface
   it holds (Hourcade and Nicolas 1985), and a receiver past the texel's depth is lit only if one flat or convex
   surface can join it to the texel's surface point: the two normals within 60 degrees, and that point behind the
   receiver's tangent plane by no more than the chord times the sine of the angle between them, plus 2 cm (a convex
   surface's chord runs between its two tangents). A 0.15 m log's crest keeps the snow's bounce its own lower face
   stands in for; at a concave corner, snow 0.2 to 0.6 m outside a wall's foot, the plane runs on through the wall
   into the room and the texel holds the wall (90 degrees) or the floor under that plane (parallel, 5 cm down), so the
   snow no longer takes the room's bounce through the wall (KB-BOUNCE-SHADOWSNOW1). Snow 1 to 2 cm above a floor on
   the other side of the wall is, to that one depth, on the floor's own plane, so the joined surface is checked to run
   on unbroken: the texel beside it on each axis, toward the ray to the receiver, is asked too, and where the two
   texels' points form a valley (each in front of the other's plane by over 2 cm: the floor and the wall standing on
   it) and the receiver lies over 2 cm behind the second one's plane, the ray meets that wall between them, as a
   silhouette map places an edge inside a texel (Sen, Cammarano and Hanrahan 2003). A convex edge is never a valley,
   so the crest keeps its bounce. A receiver within the 2 cm and 2% depth slack behind a surface still takes it, as
   any shadow map's bias lets through (docs/limits.md).

`sampleSurfaces(meshes, vpls, {resolution, budget})` is the occluder sampling on its own (`LightBounce` calls it with
the frame's batches): vertices in core's layout (position, normal), a column-major world matrix, and `budget` 16384
pieces at most (past it the cells double).

```ts
import {sampleSurfaces} from 'margoengine/clustered/bounce';

const wall = {
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: [0, 1, 2],
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1], // the triangle moved 2 m along z
};
const vpl = {position: [0.2, 0.2, 0] as [number, number, number], normal: [0, 0, 1] as [number, number, number], flux: [1, 1, 1] as [number, number, number], area: 0.1, source: 0};
const occluders = sampleSurfaces([wall], [vpl], {resolution: 32});
console.log(occluders.length, occluders[0].corners); // 1, the triangle's 9 world coordinates, drawn exactly
```

In Cabin Hearth (`examples/cabin-hearth`, `scripts/cabin-hearth-browser-test.mjs`) the outward crest of the log at
(0.3, 1.35, 2.65), left of the window and facing the snow, gets its light from the snow alone. Measured on an RTX
A6000, fire off, the lantern steady: with clear glazing the lantern's bounce is 0.1274 R, 0.0302 G irradiance, 10% over
a quadrature over the test's snow surface (0.1155, 0.0274: the lantern's 6.5 cd through the window's opening, bars and
sill, albedo 0.9 / 0.92 / 0.95, the form factor to the crest); with the scene's frosted glass the lantern bounces
nothing outside and the window's light, its opening given `recess: 0.218` and `sill: 0.09`, gives 0.0624 R (measured 2026-11-20 on an Intel Arc 140V laptop GPU, WebGPU and the WebGL2 layer alike), 3.6% under
the quadrature with the window's reveal, sill and bars shading the snow (0.0647; 0.1196 without them, and 0.1035
before the scene passed the recess and sill; docs/known-bugs.md KB-BOUNCE-REVEAL1). Read in float at the crest's own point (the HDR capture
over TAA's 8-frame jitter cycle, bilinear between pixel centres), the frame equals the JS twin to 0.1% (0.9989 clear,
0.9991 frosted, both backends); the bounce there changes 4.2 to 4.7% per pixel down the log. The hearth view's mean
luminance goes from 0.0529 to 0.0552 on WebGPU and 0.0524 to 0.0553 on the WebGL2 layer (the moving flames shift it
by a few per cent from frame to frame), the fire-lit rug from 0.0542 to 0.0621 (+15%) on both.


### Counting the room's light once

`openingLight` already sends a room's light out of its window: the radiance L_room of an integrating sphere with ports,
which is the room's inter-reflected light of every order from the first, and with frosted glass also the lamps' direct
light on the pane, tau_d E / pi. The bounce adds nothing that is already there:

- A VPL on the room side of an opening lights nothing through it. Its light is a first-order reflection inside the
  room, part of L_room. Each such VPL's visibility map holds the opening's rectangle (`BounceOpening`), so its rays
  through the opening stop there.
- With frosted glass a lamp's capture stops at the opening: the frost turns the lamp's beam into the pane's diffuse
  term, which the opening light carries, and the lamp's shadow map already stops the beam. Surfaces past the opening
  get no VPL from that lamp (`crossesOpening`). With clear glass the beam passes: the opening light leaves the beam out
  (the lamp's own shadows draw it), so the snow it falls on bounces.
- The opening light itself is a source: what it lights outside (the snow under the window) bounces onto the wall and
  the logs, its irradiance from Lambert's polygon formula (Arvo 1994) over the rectangle clipped to each receiver's
  horizon.

With frost the pane's own look is per point, L(x) = tau_d E(x) / pi with the bars' shadows (`glazingSurface`), but its
flux over the glass is the opening light's radiance times the area (packages/clustered/test/opening-light.test.js),
and the bounce takes the opening light itself as its source, so it reflects exactly the light the area light puts on
the snow; the frosted pane is a `@margoengine/materials` mesh, outside core's capture, so it is not a second source.

So a path from a lamp to a surface outside is counted by exactly one term: through clear glass by the lamp (direct, then
its bounce), otherwise by the opening light (direct, then its bounce). `packages/clustered/test/bounce.test.js` checks
both glazings: the room's VPLs reach the snow through the window at a measurable level without the rule and at under 2%
of it with it (what is left goes through the logs' imperfect maps); frosted, no lamp VPL lies outside.

```ts
import { rectIrradiance, texelSolidAngle } from '@margoengine/clustered/bounce';

// A 1 x 1 m opening of radiance 1 lights a point 1 m in front of its centre with pi x its form factor.
const window = {kind: 'rect' as const, position: [0, 1, 0], normal: [0, 0, 1], u: [0.5, 0, 0], v: [0, 0.5, 0]};
const e = rectIrradiance(window, [0, 1, 1], [0, 0, -1]); // 0.752 (form factor 0.2395)
// The 1,024 texels of a cube face of 32 x 32 hold 4 pi / 6 steradians between them.
let omega = 0;
for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) omega += texelSolidAngle(1, 32, i, j);
console.log(e.toFixed(3), omega.toFixed(4));
```

## Line lights and light groups

A flame along a log, a neon bar or a strip light is a line, not a point: one point light lights everything near it
from one place and casts hard shadows. `lineLights` (`@margoengine/clustered/line`) returns point lights at the
Gauss-Legendre nodes of the segment, each with its share of the power and a soft shadow (PCSS through `LocalShadows`)
sized so the points' shadows merge into one. `LightGroups` (`@margoengine/clustered/groups`) lets the fire, a lamp and
your own lights share one `Clustered`, each replacing only its own part of the list, and `animateFlicker` takes a group.
A group's `dispose()` never throws, whichever of the group, its `LightGroups` and their `Clustered` goes first (a scene
disposes its `Clustered` before the fire that owns a group); once the `Clustered` is disposed its groups read
`isDisposed` and `setLights` on them throws `'disposed'`.

```ts
import {Engine, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
import {lineLights} from 'margoengine/clustered/line';
import {LightGroups} from 'margoengine/clustered/groups';
import {animateFlicker} from 'margoengine/clustered/flicker';

const engine = await Engine.create(document.querySelector('canvas')!);
const floor = engine.createMesh().setGeometry(box(6, 0.1, 6));
const log = engine.createMesh().setGeometry(box(0.7, 0.12, 0.12)).setPosition([0, 0.2, 0]);
const lights = Clustered.attach(engine);
const shadows = LocalShadows.attach(engine, {lights, resolution: 1024});
shadows.add(floor);
shadows.add(log);
const groups = LightGroups.attach(engine, lights);
// The flames: a 0.62 m line 0.45 m up. Two points by default, spheres of 0.155 m radius, one shared flicker.
const flame = lineLights({
  start: [-0.31, 0.45, 0], end: [0.31, 0.45, 0], range: 6,
  intensity: 9, color: [1, 0.55, 0.25], flicker: {curve: 'fire'},
});
const stop = animateFlicker(engine, groups.group('fire'), flame);
// Your own lights, in their own group: the fire's flicker never replaces them.
groups.group('room').setLights([{position: [2, 2.5, 1], range: 8, intensity: 3}]);
engine.start();
// stop() ends the flicker and puts the fire's steady lights back.
console.log(typeof stop);
```

- The points stand at the nodes x_i of the n-point Gauss-Legendre rule on the segment and carry `intensity` times
  w_i / 2, so their sum integrates the line's light exactly when the integrand along it is a polynomial of degree up to
  2n - 1 (Abramowitz and Stegun 25.4.29; nodes found by Newton's method on the Legendre recurrence). `samples` takes 1
  to 8 (default 2); `gaussLegendre(n)` returns the rule itself.
- Each point is a sphere light: its `radius` and `shadow.radius` default to `lineShadowRadius(length, samples)`, the
  share of the line it stands for, so a smooth metal a hand away reflects a bounded disc (at most F0 x intensity /
  (pi radius^2), "Sphere lights" above) instead of a point light's spike. The Cabin Hearth kettle spout 0.08 to 0.15 m
  from the fire's two points peaked at linear luminance 814 as points and 10.4 as the kit's 0.155 m spheres on the
  `tarnishedCopper` preset. The radius is half the length over `samples`, raised
  from 6 samples up so that the 10-90% penumbra of a disc light (1.374 radius x the blocker ratio, see "Soft point and
  spot shadows") covers half of the widest gap between neighbouring points. The copies of a shadow that separate
  points cast are then one soft shadow at every receiver distance. `radius: 0` gives points with hard shadows,
  `castShadow: false` no shadows (the points stay spheres); `shadow` sets `near` (default 0.05, close to the fuel), `far` and `resolution`.
- Every point gets the line's `flicker` with one seed (default 0), so the line brightens and dims as one source.
- Cost: every shadowed point renders six cube faces (two points: 12 faces of `LocalShadows`, whose `maxLights`
  default is 4), and each point is one light in the cluster lists. A shadowed tube (`ShapeLights`) would cost an LTC
  lobe per pixel and has no shadows; fog and flicker read point and spot lights only. The radius softens
  `LocalShadows` maps; Clustered's integrated maps (`ClusteredOptions.shadows`) ignore it.
- Proof, on an RTX A6000 through `scripts/clustered-line-gpu-check.js` (`npm run test:gpu:line`), WebGPU and the
  WebGL2 compatibility layer: a 0.62 m line 3 high over the edge of a bar 1.5 high. The largest change of the floor's
  shadow factor (averaged over 41 rows along the bar, as the PCSS taps turn per pixel) between points 0.02 m apart is
  0.055 of the lit side (two hard points: 0.52), and the mean stays within 0.035 of two disc lights' analytic shadow.
- Groups merge in the order they were made. Outside a frame callback a group's `setLights` goes through at once and
  throws for invalid lights, leaving every group as it was; changes made in frame callbacks (`animateFlicker`) go in
  one `Clustered.setLights` before the frame renders when the groups are attached. `group.dispose()` removes its
  lights; `groups.dispose()` stops managing the list and leaves the lights last sent.

## Directional and area light shadows

`DirectionalLights` and `AreaLights` (`@margoengine/clustered/area`) lights with
`castShadow: true` are shadowed by the `LocalShadows` attached to the same lights: the same casters (`local.add`: core
meshes, glTF PBR models, materials and instanced meshes, `{dynamic: true}` for skinned ones), `bias` and `normalBias`,
and the same depth map array, after the point and spot layers. No binding is added. Both local caster shaders declare
the position `@invariant` (WGSL 12.10), as every Margo shadow caster does.
`LocalShadows` `maxLights` (1 to 16, default 4) sets how many point and spot lights get maps, in list order; further
`castShadow` point and spot lights stay unshadowed. The integrated maps (`ClusteredOptions.shadows`, below) take 1 to 32
and reject a list with more shadowed lights instead.

```ts
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
import {DirectionalLights} from 'margoengine/clustered/directional';
import {AreaLights} from 'margoengine/clustered/area';
import {EngineKernel, box} from 'margoengine/core';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const floor = engine.createMesh().setGeometry(box()).setScale([10, 0.1, 10]);
const table = engine.createMesh().setGeometry(box()).setPosition([0, 1, 0]);
const lights = Clustered.attach(engine), local = LocalShadows.attach(engine, {lights, resolution: 1024});
const suns = DirectionalLights.attach(engine, {lights}), panels = AreaLights.attach(engine, {lights});
suns.setLights([
  {direction: [1, -2, 0], intensity: 2, castShadow: true, shadow: {bounds: {min: [-10, 0, -10], max: [10, 5, 10]}}},
  {direction: [-1, -3, 1], intensity: 1, castShadow: true, shadow: {cascades: 3, distance: 60}},
]);
panels.setLights([{position: [0, 3, 0], direction: [0, -1, 0], width: 1.2, height: 0.4, intensity: 5, castShadow: true}]);
local.add(floor);
local.add(table);
```

- **Directional.** `shadow.bounds` renders one orthographic map over that world box, independent of the camera: it
  re-renders only when the light or a caster changes. Casters and receivers must be inside the box. Without `bounds`,
  `cascades` (1 to 4, default 3) maps are fitted to the camera's view out to `distance` (default 100, or the camera's
  far plane), split half logarithmically and half uniformly, each a bounding sphere snapped to whole texels. These
  re-render when the camera moves. Casters up to `distance` past a cascade toward the light still cast into it. A
  receiver uses the finest cascade that holds it, and is lit outside them all. Filtering is the point lights' 3x3 PCF,
  with the bias and normal offset in texels of the cascade.
- **Area.** Cube faces around the light's centre in its own frame: five (the side it lights and the four sides) or six
  when `twoSided`. Each face covers 45 degrees plus a 0.1 UV guard band. The penumbra is PCSS (Fernando 2005). 16 depth
  reads around the receiver find the blockers, and their mean depth sets the filter radius: the light's half
  `width` and `height` at the receiver times (receiver - blocker) / blocker depth. 24 comparisons filter that radius,
  each against the receiver's tangent plane, so wide filters do not shadow the surface they sit on. Wider or taller
  lights give wider penumbrae. On a real GPU a 1.2-wide light gave a 10-90% penumbra 2.9 times wider than a 0.4-wide
  one (analytic 3), each within 15% of the exact uniform-light width
  (`scripts/clustered-shadow-gpu-check.js`). `shadow.near` (default far / 1000) and `shadow.far` (default 100) bound
  the faces; past `far` a receiver is unshadowed.
- Both take `shadow.resolution` (16 up to LocalShadows' `resolution`, one integer or `[width, height]`; a smaller map
  uses its layers' corner, as a local light's). At most 4 directional and 4 area lights of a list cast
  (`MAX_DIRECTIONAL_SHADOWS`, `MAX_AREA_SHADOWS`); a fifth throws RangeError from `setLights`. Layers: one per
  cascade, five or six per area light, `resolution² × 4` bytes each.
- Limits: the filter radius stops at the guard band (0.1 UV, about 50 texels at 512), so very wide penumbrae are
  clipped. Blockers nearer the light than a quarter of the receiver's distance can fall outside the search. Each pixel
  turns its 16 + 24 taps by its own screen noise, so a wide penumbra shows fine, steady noise (no stair steps); a
  temporal filter such as TAA smooths it. Without `LocalShadows` the lights stay unshadowed. `ShadowCatcherMaterial`
  does not yet count these shadows. A receiver added with `receiveShadow: false`, or a core mesh with
  `mesh.receiveShadow = false`, is not darkened.
- Cost: every fragment evaluates every area light, two integrals each (GGX and Lambert), with an exact arc tangent per
  edge. A quad wholly above or below the surface's horizon skips the clip with the same result. At 1,000 boxes and four
  lights that is 0.38 ms of GPU a frame on an RTX A6000, about 0.32 of it the lights
  ([accepted difference](../../docs/limits.md#rendering)).
- Off is exact: while no directional or area light casts, the shaders, bindings, buffers and uploads are byte for byte
  what they were before these shadows existed (unit-tested by hash; images and probe radiance compared on a real GPU).

## Sphere, disc and tube lights

`ShapeLights` from `@margoengine/clustered/shapes` adds bulbs (`shape: 'sphere'`), round fixtures (`'disc'`, lit on the
side its `direction` faces, or `twoSided`) and fluorescent tubes (`'tube'`, a capsule from `start` to `end`) to a
`Clustered` light loop, up to 64 at once. Highlights take the light's shape and the light falls off with its size, shaded
with the same Linearly Transformed Cosines as the rectangle lights. `intensity` is the surface radiance;
`radianceFromPower(light, lumens)` converts a total power. Shaped lights do not cast shadows yet (docs/limits.md).

## Many shadowed lights

`StochasticLights` from `@margoengine/clustered/stochastic` keeps the shadow cost of a pixel at `samples` lookups (default
2, at most 8) however many shadowed point and spot lights reach it. Each light's unshadowed light stays exact; the
shadows of a few lights, picked in proportion to the light each brings, give the visibility that scales the shadowed
lights' sum (a ratio estimator). A pixel reached by `samples` shadowed lights or fewer is exact. Estimates are shared
across each 2 x 2 pixel quad (`quad`, default on) and the pattern changes every frame (`temporal`), so
`@margoengine/taa` averages the remaining noise. It needs `LocalShadows` or `ClusteredOptions.shadows`; without shadows it
changes nothing. Attach it with `StochasticLights.attach(engine, {lights})`.

## IES profiles

`@margoengine/clustered/ies` reads IES LM-63 photometric files (the 1986 to 2019 revisions, type B and C photometry) and
shapes point and spot lights with them:

```ts
import {EngineKernel} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {IESLights, parseIES} from 'margoengine/clustered/ies';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
const profile = parseIES(await (await fetch('/downlight.ies')).text());
const ies = IESLights.attach(engine, {lights});
lights.setLights([{position: [0, 3, 0], range: 0, decay: 2, intensity: profile.peak}]);
ies.setProfiles([profile]); // entry i shapes the light at index i of setLights
```

Entry i of `setProfiles` belongs to the light at index i of `lights.setLights` (a profile, `{profile, rotation}` or
null); update both together when the list changes order. The profile, normalised to its peak, multiplies the light's
cone term, so `intensity` is the candela of the brightest direction: `profile.peak` reproduces the file, and
`profile.flux` (lumens, the distribution integrated over the sphere) converts a lumen rating. Vertical angle 0 points along
a spot's `direction`, or straight down for a point light; horizontal angle 0 is world +x made perpendicular to that axis
(+z when the axis is within 26° of x), turning counterclockwise seen from behind the light (from above, for a downlight),
plus `rotation` radians. Mirrored files (last horizontal angle 90° or 180°, or 90° to 270°) are unfolded as LM-63
describes; vertical angles outside the file emit nothing; lamp tilt data is read past and not applied; type A throws.
A type B file (floodlights) is resampled onto the same 1° × 5° grid with its beam at vertical angle 0, its horizontal
angles along plane 0 and its vertical angles along plane 90; past the angles it measured it emits nothing. These axes are checked on a real floodlight report in `test/fixtures`. The ballast-lamp
factor scales candela only in files before LM-63-2002: later revisions keep that place for other things. The shader reads a 1° × 5° grid of each profile (one column when it is rotationally symmetric) from one storage
buffer (binding 142), filtered bilinearly by hand: no textures. At most 16 distinct profiles at a time. Without profiles
it adds nothing to the shaders or the GPU work.

## Projector lights

`@margoengine/clustered/projector` makes spot lights project an image:

```ts
import {EngineKernel} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {ProjectorLights} from 'margoengine/clustered/projector';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
const projectors = ProjectorLights.attach(engine, {lights});
lights.setLights([{position: [0, 3, 2], range: 10, direction: [0, -1, -0.6], outerAngle: 0.5, intensity: 40}]);
const bitmap = await createImageBitmap(await (await fetch('/slide.png')).blob());
const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), g = canvas.getContext('2d')!;
g.drawImage(bitmap, 0, 0);
projectors.setProjectors([g.getImageData(0, 0, bitmap.width, bitmap.height)]); // entry i: the spot at index i
```

Entry i of `setProjectors` belongs to the spot at index i of `lights.setLights` (an image, `{image, colorSpace, angle,
aspect}` or null); point lights ignore theirs. The image's UVs are those of the spot's local shadow map
(`localShadowMatrix`: a perspective along `direction` with a field of view of twice the outer angle, up +y, or +z within
8° of vertical), so a shadowed projector's image and shadow line up; it appears upright and unmirrored seen from the
light. `angle` (half the vertical field of view) and `aspect` (default 1, the square of the shadow map) change the
frustum; the cone still bounds the light, so at the default it cuts a square image's corners. The image multiplies the
light (filtered bilinearly, edges clamped, alpha premultiplied); outside it the light is dark. Images are sRGB unless
`colorSpace: 'linear'`, and are copied on the call. They live in one storage buffer (binding 143) as packed rgba8
texels, not textures: physical materials with shadows, IBL and LocalShadows already bind all 16 textures a shader
stage may have. At most 16 distinct images of up to 4,096 texels a side, 16,777,216 texels in all. Without images it
adds nothing to the shaders or the GPU work.

## Physical light units

Margo's light intensities are photometric already, as glTF's KHR_lights_punctual (which gltf/pbr's `applyGLTFLights`
passes through unchanged): a point or spot `intensity` is candela, a directional light's (core's sun,
`DirectionalLights`) lux on a surface facing it, an area light's nits; the linear output is luminance in nits.
`@margoengine/clustered/units` holds the conversions, plain functions with no GPU work:

```ts
import {EngineKernel} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {lumensToCandela, nitsToLumens, ev100, exposureFromEV100} from 'margoengine/clustered/units';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine);
lights.setLights([
  {position: [0, 3, 0], range: 0, decay: 2, intensity: lumensToCandela(800)},                    // an 800 lm bulb
  {position: [2, 3, 0], range: 0, direction: [0, -1, 0], outerAngle: 0.5, innerAngle: 0.3,
    intensity: lumensToCandela(800, {outerAngle: 0.5, innerAngle: 0.3})},                         // the same in a cone
]);
lights.intensityScale = exposureFromEV100(ev100(2.8, 1 / 60, 800));                              // an indoor exposure
```

`lightSolidAngle(cone?)` is 4π for a point light and 2π(1 − (cos outer + cos inner)/2) for a spot: the smooth edge is a
smoothstep in the cosine, which integrates to half its width, so the conversion is exact for clustered's cone.
`lumensToCandela(lm, profile)` takes an IES profile's peak and flux. `candelaToLux`/`luxToCandela` (inverse square at
normal incidence), `nitsToLumens`/`lumensToNits` (π L A per side of a rectangle light), `nitsToCandela` (an area light as
the point light it matches face on), `ev100(aperture, shutter, iso)` and `exposureFromEV100(ev)` (1 / (1.2 × 2^ev),
saturation-based) complete the set.

## Point and spot shadows

Opt into bounded local shadow maps when creating the effect, enable shadows on
individual lights, and register their casters:

```ts
import {Clustered} from 'margoengine/clustered';
import {EngineKernel,type Mesh} from 'margoengine/core';

function localShadows(engine:EngineKernel,blocker:Mesh) {
  const lights=Clustered.attach(engine,{shadows:{resolution:512,maxLights:4}});
  lights.setLights([
    {position:[0,3,0],range:12,intensity:30,shadow:true},
    {position:[2,4,1],range:15,direction:[0,-1,0],outerAngle:0.6,
      innerAngle:0.3,intensity:40,shadow:{near:0.05,bias:0.0005,normalBias:0.02}},
  ]);
  const removeCaster=lights.addShadowCaster(blocker);
  return ()=>{removeCaster();lights.dispose();};
}
```

`shadows` defaults to resolution 512 and a maximum of four shadowed lights.
`maxLights` is an integer from 1 through 32, independent of the 1,024-light
lighting limit. Each slot reserves six `depth32float` layers; point lights render
all six faces and spot lights render one perspective face; a spot at the full π/2 (a hemisphere, which needs a
180° frustum no single perspective map holds) renders the six cube faces of a point light, here and in
`LocalShadows`. Four slots at 512
reserve 24 MiB of depth storage. Attachment validates texture dimensions, array
layers and buffer limits before allocation. `setLights()` validates the full
replacement before changing the list; too many shadowed lights reject explicitly.

Per-light `shadow` defaults to false. `shadow:true` uses near distance
`min(0.1, far/100)`, far distance `range`, depth bias 0.0005, world-space normal bias 0.02 and a map of
`shadows.resolution` texels. An object overrides those values; near must be positive and below far, and both biases
must be finite and nonnegative. Animate positions, directions, ranges or shadow settings with `setLights()` before
rendering.

Per light, as Crocotile's Shadow Map Width/Height and shadow camera Near/Far:

```ts
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const lights = Clustered.attach(engine, {shadows: {resolution: 1024, maxLights: 2}});
lights.setLights([
  {position: [0, 4, 0], range: 12, intensity: 30, shadow: {resolution: 256, near: 0.2, far: 8}},
  {position: [3, 5, 1], range: 0, decay: 1, direction: [0, -1, 0], angle: 0.6, shadow: {resolution: [1024, 512], far: 20}},
]);
```

`far` (default the light's `range`) ends the shadow camera: casters and receivers past it are unshadowed, and a light
with unlimited range (`range: 0`) can have a shadow map only with an explicit `far`. `resolution` is one integer or
`[width, height]`, each from 16 up to `shadows.resolution`, which stays the size of every layer and so the most a light
can ask for: memory is `maxLights × 6 × resolution² × 4` bytes whatever the lights ask (one slot at 2048: 96 MiB). A
smaller map renders into the top-left corner of its layers (a point light all six cube faces, a spot its cone) and is
sampled there with matching UVs, so a 256 light has 256 texels of detail next to a 1024 one; it keeps two texels per
side as a guard band, so the 3×3 filter never reads past it. A light at the full size uploads and renders exactly what
it did before these options existed, and the shaders never change.

`LocalShadows` (`castShadow` lights) takes the same per-light map size and near/far from the light's `shadow` object,
up to its own `resolution`, the same way (corner viewport, matching UVs, two-texel guard band, no shader change):

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const blocker = engine.createMesh().setGeometry(box()).setPosition([0, 2, 0]);
const lights = Clustered.attach(engine), local = LocalShadows.attach(engine, {lights, resolution: 1024});
lights.setLights([{position: [0, 4, 0], range: 12, castShadow: true, shadow: {resolution: [512, 256], far: 8}}]);
local.add(blocker);
```

### Hard shadow edges and their biases

`LocalShadows` filters every hard point, spot and directional shadow over 3x3 bilinear taps (Reeves, Salesin and Cook
1987), and compares each of the 4x4 texels they read with the depth of the receiver's tangent plane on that texel's ray
(the receiver-plane depth bias of Isidoro, GDC 2006, taken per texel as the adaptive depth bias of Dou et al., JCGT
2014). A plane stays a plane under the light's projection, so a flat receiver needs no slope offset at any angle, and
the shadow edges stay on their casters. Directional cascades map the plane through each cascade's own matrix, and also
leave out texels whose stored surface lies behind the plane by more than the receiver's own offsets plus one texel:
those texels show no part of the receiver (it ended at a contact or an edge), so a thin wall or ceiling meeting a
grazing-lit receiver no longer lights it through them. All four settings are `LocalShadows` options, fixed at
construction:

| Option | Default | What it does |
| --- | --- | --- |
| `bias` | `1` | Moves the receiver toward the light, in shadow-map texels at the receiver. Covers float error and gentle concave curvature; it does not move edges sideways. |
| `normalBias` | `0.25` | Moves the receiver along its normal, in texels (Holbert, GDC 2011). One texel moves a hard edge tan(angle to the light) texels toward the light; 0.25 covers shading normals tilted 10 degrees off the surface at up to 66 degrees from the light. It was 1.5 before 2026-11-16 (directional cascades kept 1.5 until KB-SUNSHADOW-OFFSET1). |
| `receiverPlane` | `true` | Point, spot and directional. `false` compares every texel with the receiver's own depth through the comparison sampler, the filter used before 2026-11-16; it needs `normalBias` about 1.5 against acne. |
| `slopeBias` | `0` | Lifts each texel nearer the light by this many extra multiples of the tangent plane's rise there (never lowers one). `0` is the exact plane. About `2` removes acne from normal-mapped receivers lit at 80 to 85 degrees, whose tilted normals give a plane that rises slower than the surface; casters within about 2 `slopeBias` sin(angle) texels of the receiver then lose their shadow. |

Measured on an RTX A6000 (`npm run test:gpu:shadow` in this package; the same checks run on the WebGL2 layer): a bar
lit from 3.8 m at 58 degrees with 256 px maps, its edge averaged over 16 light positions, ends 1.1 cm from the true
edge for a point light and 0.6 cm for a spot (the 0.25-texel normal offset's own shift); the old 1 and 1.5 texels put
it 7.1 cm and 3.9 cm out (KB-LOCALSHADOW-OFFSET1). A floor lit at 80 to 85 degrees, with true normals or normals tilted
10 degrees at 49 to 66 degrees, has no acne (the old filter fell to 0.87 at 80 to 85 degrees), and the floor behind a
0.1-high pebble stays in its shadow. Normals tilted 10 degrees at 80 to 85 degrees need `slopeBias: 2` (docs/limits.md).
A sun at 58 degrees with a 256 px map puts the edge 1.0 cm out (2.4 cm texels; 5.8 cm before KB-SUNSHADOW-OFFSET1),
with the same acne and pebble results, and the directional Cornell box against Mitsuba went from an absolute error of
567,377 to 478,366.

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const floor = engine.createMesh().setGeometry(box()).setScale([10, 0.1, 10]);
const crate = engine.createMesh().setGeometry(box()).setPosition([0, 0.55, 0]);
// The defaults written out; set slopeBias: 2 if a bumpy normal map shows acne where the light grazes it.
const lights = Clustered.attach(engine);
const local = LocalShadows.attach(engine, {lights, resolution: 512, bias: 1, normalBias: 0.25, receiverPlane: true, slopeBias: 0});
lights.setLights([{position: [-3, 1, 0], range: 12, intensity: 20, castShadow: true}]);
local.add(floor);
local.add(crate);
```

### Soft point and spot shadows

A castShadow point or spot light's `shadow.radius` (world units, default the light's `radius`, else 0) gives it the size of a bulb: its
`LocalShadows` penumbra widens with the receiver's distance behind the blocker, as a real lamp's does, instead of the
fixed 3x3 filter:

```ts
import {EngineKernel, box} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {LocalShadows} from 'margoengine/clustered/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const floor = engine.createMesh().setGeometry(box()).setScale([10, 0.1, 10]);
const bar = engine.createMesh().setGeometry(box()).setScale([1, 0.05, 6]).setPosition([0, 1.5, 0]);
const lights = Clustered.attach(engine), local = LocalShadows.attach(engine, {lights, resolution: 1024});
lights.setLights([
  {position: [0, 3, 0], range: 20, intensity: 30, castShadow: true, shadow: {radius: 0.4}},
  {position: [3, 3, 0], range: 20, direction: [0, -1, 0], angle: 1, intensity: 30, castShadow: true, shadow: {radius: 0.2}},
]);
local.add(floor);
local.add(bar);
engine.start();
```

- The method is the area lights' PCSS (Fernando 2005): 16 depth reads find the blockers within the light's footprint,
  their mean depth sets the filter radius `radius * (receiver - blocker) / blocker` (depths from the light), and 24
  comparisons filter it against the receiver's tangent plane. Such a light's map covers its cone (a point light's
  cube face) plus a 0.1 UV guard band, the area lights' face tangent of 1.25, so the filter reads its own face; the
  map is the same size, so its texels are 25% wider than a radius 0 light's.
- Proof, on an Apple silicon Mac GPU (Metal) through `scripts/clustered-shadow-gpu-check.js`: a bar 1.5 over a
  floor, lights 3 and 4.5 high. The 10-90% penumbra on the floor is within 2% of a disc light's analytic width,
  `1.374 radius (receiver - blocker) / blocker`, for a point light of radius 0.2 and 0.4 at blocker ratio 1, radius
  0.4 at ratio 0.5, and a spot of radius 0.4; doubling the radius or the ratio doubles it.
- Each pixel turns both tap spirals by its own angle and moves every tap within its own ring, from interleaved gradient
  noise of its screen pixel (Jimenez 2014). One pattern shared by every pixel drew a wide penumbra as 24 shifted hard
  shadows, stair steps and radial streaks up close; the turned taps draw fine noise that does not change from frame to
  frame, whose mean over a strip of pixels follows a disc light's exact penumbra within 0.012 (0.053 to 0.058 before),
  on an RTX A6000 through the GPU check below. TAA smooths the noise.
- Limits, as the area lights': the filter stops at the guard band, so very wide penumbrae are clipped; blockers nearer
  the light than a quarter of the receiver's depth can fall outside the search; without a temporal filter the noise
  shows on very wide penumbrae. Each lookup costs 40 texture reads instead of 9 (not timed yet).
- The integrated maps (`ClusteredOptions.shadows`) honour the radius too, with the same kernel (one WGSL text,
  `packages/shared/point-pcss.js`) on their own map (depth near 0, far 1) and their face's depth bias: a light with
  `shadow: {radius}` (or a `radius` of its own) and no `castShadow` gets the same penumbra under them. Only lights
  with a radius above 0 widen their faces by the guard band and read the kernel; the others keep the 3x3 filter.
  Proof (`scripts/clustered-shadow-gpu-check.js`, RTX A6000, WebGPU and the WebGL2 layer): for point lights of radius
  0.4 and 0.2 and a spot of radius 0.4, 3 above the floor, the strip mean follows the exact disc-light penumbra within
  0.012 (bound 1/48) and LocalShadows' within 0.025 (bound one tap, 1/24); `shadow.radius: 0` and `radius: 0` keep
  the lit shader text and radiance identical to no radius.
- Off is exact: while no shadowed light has a radius above 0, the shaders, frame buffer and uploads are byte for
  byte the plain ones (unit-tested; images and probe radiance compared on a real GPU). The radius is read when
  `setLights` runs; a changed radius re-renders that light's maps.

Without `ClusteredOptions.shadows` a castShadow light's `shadow` may hold only `resolution`, `near` (default far /
1000) and `far` (and `radius`, above): `LocalShadows` takes its biases, in texels, from its options (`bias`,
`normalBias`, `receiverPlane`, `slopeBias`, above). A size above its `resolution` throws
when the maps render. With both systems attached, a light with `castShadow` and a `shadow` object is shadowed by both.

`addShadowCaster()` accepts core meshes, individual loaded glTF/FBX nodes and sources exposing `shadowPrimitives`
(a primitive with `displacement`, a materials mesh with a `displacementMap`, is drawn displaced here and in
`LocalShadows`),
including glTF PBR models and their current deformed vertex buffers. Overlapping model/node registrations draw each primitive once, including distinct materials sharing GPU geometry. PBR masks
honor alpha, vertex alpha, UV0/UV1 and texture transforms; blended PBR primitives
are excluded. Hidden ancestors and disposed sources stop casting. Register a
model with both `addShadowCaster(model)` and `add(model)` when it also receives
local lighting. A source with a `drawLocalShadow` hook (a `RawMesh` of `@margoengine/shader/raw`, clipmap
terrain) casts here too: each active layer calls it after the primitives with `depthCompare: 'less-equal'`, since
these maps hold forward depth (near 0, far 1, cleared to 1), where `LocalShadows` calls the same hook with
`'greater'`. The maps redraw every face each frame, so a moved caster, a new material or new uniform values show at
once. A source with only another system's `drawShadow()` is refused with TypeError.

```ts
import {EngineKernel} from 'margoengine/core';
import {Clustered} from 'margoengine/clustered';
import {RawShaders, RawShaderMaterial, RawMesh} from 'margoengine/shader/raw';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const raw = RawShaders.attach(engine);
const lights = Clustered.attach(engine, {shadows: {maxLights: 2}});
const vertexShader = `
struct Out { @builtin(position) clip:vec4f }
@vertex fn vertex(a:Attributes)->Out { return Out(camera.viewProjection * mesh.world * vec4f(a.position, 1.0)); }
@fragment fn fragment(i:Out)->@location(0) vec4f { return margoDisplay(vec4f(1.0)); }`;
const quad = raw.add(new RawMesh({
  material: new RawShaderMaterial({vertexShader}),
  attributes: {position: {data: new Float32Array([-1,1,-1, 1,1,-1, 1,1,1, -1,1,1]), type: 'vec3f'}},
  index: new Uint32Array([0,1,2, 0,2,3]),
}));
lights.addShadowCaster(quad); // drawn with depthCompare 'less-equal' into each shadowed light's maps
lights.setLights([{position:[0,4,0], range:10, direction:[0,-1,0], outerAngle:0.6, intensity:30, shadow:true}]);
engine.start();
```

Local depth passes run before clustered culling and main shading, redraw active
faces each frame, and use a fixed 3×3 comparison filter (`LocalShadows` lights with a `shadow.radius` filter by PCSS,
and its hard shadows compare each texel with the receiver plane, above). Shadows multiply only
their own light's contribution. Ambient, unshadowed local lights and directional
cascades retain their responses. Bias and resolution control acne and detached
edges; this filter does not model area-light penumbrae (area lights' own shadows do, below). Device restoration
recreates the maps and caster bindings; disposal releases owned resources.

`ShadowAtlas` (from `@margoengine/clustered/shadow-atlas`) packs the same maps into one depth image with tiles sized
by screen coverage, and caches them per face: a tile stays where it is while its size holds, and a face re-renders
only when its light or tile changes or a caster whose bounds reach that face moves, shows, hides, is added or is
removed. `stats.layers` counts the faces drawn last frame.

Without `ClusteredOptions.shadows`, the original shader, four lighting bindings
and allocation path remain exact. Opted-in effects add bindings 16-18 in the
existing lighting group (group 2 for glTF PBR); group 3 remains the independent
material slot. TAA, sky and terrain's existing bindings remain available.

Fragment lookup removes camera projection jitter before selecting the unjittered compute cluster. This keeps TAA from dropping small lights at fractional tile boundaries; the uniform's previously unused depth.zw fields carry the screen offset, without a dependency on TAA.

Each cluster reserves 1,024 indices. With the default `maxLights` (1,024) every light that reaches a cluster is listed, so nothing is ever dropped. With `maxLights` above 1,024, a cluster reached by more than 1,024 lights lists the first 1,024 of them in `setLights` order and shades only those (it never writes into the next cluster's list; the GPU check `scripts/clustered-shadow-gpu-check.js` pins it with 1,100 lamps over one point); put the lights that must always show first. The default grid uses 13.5 MiB for indices. An optional `grid:[x,y,z]` is checked against storage limits at attachment. `lightLists` exposes GPU counts/indices for diagnostics or custom forward materials; ordinary rendering needs no readback. `clusteredSampling(group)` exports WGSL for custom materials. Frame rate depends on light overlap, materials, resolution and hardware; no locked FPS is promised.

Custom code reproducing `ClusterFrame` must include the trailing `intensity:vec4f`
at byte 112, making the uniform 128 bytes. Its X component is the radiance scale.
Consumers of `clusteredSampling()` and `bindings()` receive this layout automatically.
Custom shadow-aware materials use `clusteredSampling(group,true)` with the
bindings of a shadow-enabled effect; the default second argument is false.

`dispose()`/`destroy()` releases resources and receiver hooks. Device restoration recreates buffers and reuploads the light list. The package stays separate from core, stage and PBR assets.

`LocalShadows.shadowMap(kind, index, face)` returns one map as last rendered (its depth texture, layer, reversed perspective or orthographic projection, near and far, and the texels it covers, an atlas tile included) for a debug view: pass it to `ShadowMapViewer` from `@margoengine/shadows/viewer`, as `ShadowMapViewer.attach(engine, { source: () => shadows.shadowMap('point', 0, 3) })` for the first light's -y cube face. `kind` is `'point'` (faces 0 to 5: +x, -x, +y, -y, +z, -z), `'spot'`, `'directional'` (face = cascade) or `'area'`, and `index` the light's place in its own list; it returns null for a light without a map.

## Many lights

`ClusteredOptions.maxLights` raises the point and spot light cap from 1,024 to as many as 65,536 for city and
stadium scenes; the light buffer grows in pages of 1,024 lights (64 KiB each) only as `setLights` lists need them.
Each cluster still lists at most 1,024 lights, and culling tests every light per cluster, so a frame's culling cost
grows with the count. `AreaLightOptions.maxLights` raises the area light cap from 64 to as many as 1,024; area lights
are not clustered, so every lit fragment evaluates every one, and only the first 64 may cast shadows. IES, projector
and contact settings cover the first 1,024 point and spot lights.

## Contact shadows

`ContactLights` (`@margoengine/clustered/contact`) grounds small details under point and spot lights: each lit
fragment marches a short ray toward each light through the previous frame's scene depth, and a hit removes `strength`
of that light (default 0.8; `setStrengths` sets it per light index, 0 turns a light off). Options: `distance` (0.3),
`thickness` (0.1), `steps` (12), `bias` (0.01) and `depth`, the scene's single-sample depth texture or a callback for
it; omitted, it shares the scene-depth capture water and HTML panels use, which SSAO and depth of field refuse (pass
their stack's `depthTexture` then). A callback is the form to prefer: a plain `depth` texture belongs to the device it was made on, so after a device restore it is dropped, the march stays off, the loss is reported once through `engine.onError` and `contact.setDepth(texture)` brings it back (docs/conventions.md, "Borrowed GPU objects"). It works with or without shadow maps and adds binding 145. It reads one frame late
(a moving caster's contact trails it by a frame), only what is on screen casts, and receivers added with
`receiveShadow: false` skip it.

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

`CubeProjectorLights` now refuses the preview in its own `setup` (`CubeProjectorLights needs WebGPU`, code `unsupported`). Before 2026-11-10 it inherited `ProjectorLights`' refusal, whose message named the parent class; the preview-contract gate could not see an inherited refusal and failed `npm run verify`. Behaviour on native WebGPU and the full compatibility layer is unchanged. Regression: `test/cube-projector.test.js`.
