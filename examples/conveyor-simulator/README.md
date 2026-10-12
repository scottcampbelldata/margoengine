# Standalone conveyor benchmarks

The three conveyor model assets are stored with Git LFS. Install Git LFS, then run `git lfs install` and `git lfs pull` after cloning to download them before serving the viewers.

Serve the repository root over HTTP; no viewer bundler or Vite server is needed:

```sh
python -m http.server 5308 --bind 127.0.0.1
```

- [Margo viewer](http://127.0.0.1:5308/examples/conveyor-simulator/margo-conveyor.html) imports the workspace's built core and Blender packages and loads `conveyor.margo`.
- [Three.js viewer](http://127.0.0.1:5308/examples/conveyor-simulator/three-conveyor.html) imports pinned Three.js r186.1, OrbitControls and GLTFLoader from jsDelivr and loads the existing `Untitled.glb`.

Both pages keep a 920×652 canvas at DPR 1, exclude the Blender Cube, and instance repeated geometry. Left drag rotates, middle/right/Shift-drag pans, and the wheel zooms. The explode sweep uses the same bounds-based radial offsets in both viewers and writes retained transform storage in place. Directional lighting, diffuse probe strength, ACES exposure and camera framing use matching values. Margo draws with one sample; Three.js requests antialiasing and reports the actual sample count provided by WebGL2.

The button runs exactly 60 warmup frames and 600 measured frames of continuous orbit and explode. It reports median, p95, mean interval, FPS, draw calls and part count through the HUD and console. It restores the previous camera and explode amount afterwards. Switching away from the tab cancels a run.

An HTML page cannot disable browser vsync. For uncapped measurements, launch a separate Chromium/Edge process with `--disable-gpu-vsync --disable-frame-rate-limit`. Without those flags the button measures display-paced frame intervals. These are requestAnimationFrame intervals, not GPU timestamps. The live HUD reports steady rendering, including when the camera is stationary. Three.js needs internet access for its pinned CDN modules; Margo needs the existing `packages/*/dist` outputs available under the served workspace.

Verify both pages on the dedicated NVIDIA GPU with `node examples/conveyor-simulator/benchmark.test.mjs` while the HTTP server is running. The check covers the 569 matching parts, fixed viewport even on a DPR 2 browser, real draw counts, 1×/4× samples, in-place transforms, an isolated sweep without GC, native camera and keyboard input, zero layout shifts, the 660-frame run, and asset failure messages. Results and screenshots are saved under `test-results/conveyor-viewers/`.

[Three.js instancing documentation](https://threejs.org/docs/pages/InstancedMesh.html) describes the retained instance buffer and update flag used by the WebGL2 viewer.
