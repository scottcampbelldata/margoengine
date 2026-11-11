# Margo game

A small third-person game: walk Prototype Pete around a sunny field, knock over a stack of crates and find the six
glowing orbs. WASD or the arrow keys walk, Shift runs. Built with the `margoengine/game` kit: a physical sky with sun
shadows, bloom, Rapier physics and an animated glTF character. Needs a browser with WebGPU.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check, then a production build in dist/
```

The game is `src/main.ts` (about 120 lines). `vite.config.ts` raises Vite's chunk-size warning limit for Rapier's 4.3 MB lazy chunk, so `npm run build` prints no warning. `margoengine` is the only engine dependency: every package is a subpath
(`margoengine/shadows`, `margoengine/physics`), and the build keeps only what you import.

## Three things to try next

1. **Change the time of day.** Set `hours: 19.2` in `Sky.attach` for a sunset, or `timeScale: 0.5` to watch the sun
   move (half a sky-hour per second); the shadows follow.
2. **Give Pete a jump.** Add `jump: [{ type: 'key', code: 'Space' }]` to the `Input`, a `jump: 'Jump'` state to the
   Animator and a transition into it when a `jump` parameter is 1; the clip list is in `public/pete.glb` (`Hop`,
   `Roll`, `Dance` and 26 more).
3. **Throw things.** `physics.addBody(stage.sphere({ position: [x, 2, z] }), { colliders: { shape: 'sphere', radius: 0.5 } })`
   and then `body.applyImpulse([0, 3, 6])` on a key press.

Pete is from KayKit Character Animations by Kay Lousberg (CC0, `public/pete-LICENSE.txt`).
