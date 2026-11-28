# The Rigid Body Rain

Press **Push a piece** to cast the first ray and release the suspended rain. Tap a visible body to push at the hit point. **Drop again** restores and releases the same layout.

## Model

This original cutaway contains 400 rounded timber boxes and 400 glazed ceramic spheres over a 24 × 21 meter sculpted basin. Each piece is a dynamic rigid body. The cast terrain is a fixed Margo heightfield with the same sampled vertices and triangle split used by the visible surface. Mutual collisions, friction, gravity, angular motion and sleeping remain active. A ray first queries the physics world and then applies an impulse at the actual point where it hits one piece. The initial impulse is body mass times 5.25 m/s.

The checkerboard release layout and modest grade spread the landing contacts across the basin. The solver uses fixed 60 Hz steps with two contact substeps. The worker targets 45 scene updates per wall-clock second so viewers can see each fall more clearly. The main thread interpolates measured position and rotation snapshots between those updates and renders at the display's pace. The visible starting arrangement can accept a ray while the worker loads. The queued ray runs against the actual first physics world and the first-input timing waits for its rendered motion. Both phone and desktop see the same scene, 800 bodies and solver settings.

Native WebGPU opens first. The official direct Margo WebGL2 renderer uses the same core geometry and material data and the same worker. All rendering and physics packages were built from public Margo main at **0efd9cff8230507a32deb49907ecd499d46925f5**. The scene uses zero external art assets.

## Verification

With MARGO_ENGINE_CHECKOUT pointing to the pinned checkout, set RIGID_BODY_RAIN_PRELOAD=1 to exercise the gallery's early Worker launch in the local build.

~~~text
node qa-output/the-rigid-body-rain/mechanics.mjs
node qa-output/the-rigid-body-rain/check.mjs
~~~

The browser test covers the first trusted ray, a full drop into the basin, a direct ray through the canvas, and reset. RIGID_BODY_RAIN_URL targets the deployed route. The isolated build hook in check.mjs shows the gallery's early Worker launch. Without it, the first audited 4× cold input reached 3.053 s.

The independent geometry check found maximum ray height error of 3.39 micrometers against the visible triangles. A matched seeded control proved the first impulse changes exactly one body's velocity before nearby contacts. The full replay retained 800 bodies, landed all 800, and reached 2,189 solved pairs and 4,869 solved contact points in a step.

With the early launch, cold 390 × 844 phone tests measured 2.711 s on native WebGPU, 2.726 s on automatic direct WebGL2 and 2.728 s on forced direct WebGL2 from navigation through a trusted input and painted body motion. The profile uses 2× DPR, 150 ms latency, 1.6 Mbps download and 4× CPU throttling. Desktop native and direct WebGL2 through-click times were 0.529 s and 0.317 s. All five runs logged at least 220 actual solver steps with 16.8 ms p95 animation frame intervals and zero gaps over 50 ms.

## References

- [Pinned Margo rigid-body, heightfield and ray-query APIs](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/physics) and the [original 800-body engine example](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/examples/physics-rigid.ts).
- Miles Macklin et al., 2019, [Small Steps in Physics Simulation](https://mmacklin.com/smallsteps.pdf).
- Erin Catto, 2005, [Iterative Dynamics with Temporal Coherence](https://box2d.org/files/ErinCatto_IterativeDynamics_GDC2005.pdf).
- The gallery base and manipulated terrain draw on landscape exhibition references. [Benesse Art Site Naoshima, Teshima Art Museum](https://benesse-artsite.jp/en/art/teshima-artmuseum.html), [The Chinati Foundation, Concrete Works Installation](https://chinati.org/concrete-works-installation-3/).
