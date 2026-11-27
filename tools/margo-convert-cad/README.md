# @margoengine/margo-convert-cad

Offline CAD to GLB conversion for [Margo Engine](https://margoengine.com): STEP (`.step`, `.stp`), IGES (`.iges`,
`.igs`), ACIS SAT (`.sat`), Parasolid XT (`.x_t`, `.x_b`, `.xmt_txt`) and JT go through Margo's own B-rep kernel,
`@margoengine/brep` (the same kernel `loadCAD` from `@margoengine/cad-import` runs in its worker), and come out as binary glTF
2.0 in metres. Tessellate once at build time and ship the GLB, so the page loads no CAD reader at all.

```sh
npm i -D @margoengine/margo-convert-cad
npx margo-convert-cad part.step part.glb
npx margo-convert-cad assembly.stp --edges --linear-deflection 0.05
```

| Option | Effect |
| --- | --- |
| `--linear-deflection <mm>` | Largest chord-to-surface distance. Default: 0.1% of each body's bounding-box diagonal, as `loadCAD` |
| `--angular-deflection <deg>` | Largest turn between neighbouring edge samples. Default 28.65 (0.5 rad), as `loadCAD` |
| `--merge` | One node per material with world-space geometry, instead of the assembly tree |
| `--no-instancing` | Write every placement of a body as its own mesh (by default placements share one mesh) |
| `--edges` | Bake feature edges into mesh `extras.featureEdges` (`featureEdges` from `@margoengine/machinery/edges`) |
| `--edge-angle <deg>` | Dihedral angle for `--edges`. Default 30, as `FeatureEdges` |
| `--quiet` | Print nothing on success |

Part names, colours and the assembly tree are kept. Each format converts from its own unit; axes are unchanged, as
with `loadCAD`. A JT part with triangle LODs only, and `.brep` files, are refused with a message.

## From code

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { convert, formatOf } from '@margoengine/margo-convert-cad';

const file = 'part.step';
const { glb, stats } = await convert(new Uint8Array(readFileSync(file)), formatOf(file), { edges: 30 });
writeFileSync('part.glb', glb);
console.log(`${stats.parts} parts, ${stats.triangles} triangles`);
```

`convert` takes the file's bytes, its format (`formatOf` reads it from the name) and the options above in camel case
(`linearDeflection`, `angularDeflection`, `merge`, `instancing`, `edges`, `generator`). It returns the GLB and counts
and timings (`parts`, `meshes`, `instanced`, `triangles`, `edges`, `failedFaces`, `tessellateMs`, `writeMs`).

## Tests

`node --test tests/margo-convert-cad.test.js` from the repository root, after `npm run build:packages`: every GLB is
checked with the Khronos glTF-Validator, loaded with `@margoengine/gltf/pbr` and `@margoengine/gltf`, and compared with
`loadCAD` of the same file (triangles and part names) and with the closed-form bounds of the shapes.
