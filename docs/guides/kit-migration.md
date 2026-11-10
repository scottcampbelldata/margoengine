# Starting from three.js

Choose core or stage alone for the smallest install, a domain profile for an application, or `margoengine` for
everything. Start with the [kits guide](kits.md), then the [API comparisons](../from-threejs.md) and the
[porting matrix](../threejs-parity.md). The MCP porting guide is generated from those same documents.

For an existing HTML page with `<canvas id="viewport"></canvas>`, install `@margoengine/web` and start with:

```ts
import {createStage} from '@margoengine/web';

const stage = await createStage('#viewport');
const cube = stage.box({color: '#84d6bd'});
stage.onTick((delta) => { cube.rotation.y += delta; });
```

For a new app, the path reviewed here is:

1. `npm create margo@latest my-app -- --template web` (or game, viz, react, next).
2. `cd my-app` and `npm install`.
3. `npm run dev`, or `npm run build` followed by the production server.

The packed-registry rehearsal actually executes npm create, installs without workspace symlinks, builds all five
starters with their own build scripts, and checks every resolved engine package and version. The GPU half serves
the built files, starts Next's production server, checks drawn pixels, application HUD/error state and page errors.
Thus the evidence covers install, imports, build, model assets, application initialization and an actual frame.
The game keeps its existing public-domain Pete model and licence; no new demo data was introduced.

## Comparison and friction found

The comparison uses public documentation only: three.js contributors, *Installation* and *Creating a scene*
(2026), [installation](https://threejs.org/manual/pages/installation.html) and
[scene](https://threejs.org/manual/pages/creating-a-scene.html). The manual's npm path installs the engine and Vite
and then authors HTML, camera, renderer, mesh and a frame loop. Margo's scaffold authors these files; the stage
manages mounting, default controls, resize and its loop. These are work counts and behaviour, not a timing claim.

| Point in the path | Finding and action |
| --- | --- |
| Selecting an install | Previously every template installed all 98 engine packages. Each now has one profile dependency: web 40 engine packages, game 70, viz 42, React/Next 42 in the packed check. |
| Mapping an addon import | Standalone profiles and full-install aliases had been conflated. The imports and from-threejs guides now distinguish installation from bundling and show the prefix mapping. |
| Starting a scene | WebGPU setup is asynchronous, unlike the documented synchronous WebGL constructor. The stage example includes the required await; the generated app handles startup errors. |
| Model loading | Loaders stay in a one-line profile subpath so a root-only page emits no Draco/Basis assets. The game starter actually loads its unchanged licensed model. |
| Matching versions | Every published package and template range is checked together; a combined game/web/viz app proves shared binding identity and one installed core. |
| Browsers without WebGPU | Full WebGL2 is a separate optional package, an extra installation compared with an included WebGL renderer. This boundary is documented and the kit compatibility frames pass; the extra-step usability gap is recorded in known-bugs. |
| Public one-line create | Publication is pending, so the released-registry path cannot be completed yet. The private packed registry proves the actual npm command without publishing; the release gap is recorded in known-bugs. |
| Template README examples | Remain owed under the build-phase rule. Runtime code, guides and checks are updated; no README example was authored or edited. |
| Elapsed time | Deferred by the build-phase speed rule. The install-to-interactive-frame timing scene is retained in speed-phase.md, with no timing assertion or benchmark run. |

Reproduce with `node scripts/template-install-check.mjs`, then
`node scripts/gpu-lock.mjs run --owner=template-check --wait-max=60 --max=2 --gpu=packed-template-first-frames -- node scripts/template-browser-check.mjs`.
Reports, build logs and first-frame PNGs are under `test-results/template-installs`. This audit does not claim
unmeasured installation speed or universal parity outside the profile and starter contract.
