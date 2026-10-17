# Next Margo Engine demo: skeletal animation and inverse kinematics

## What Scott wants

Build the next Margo Engine demo using this exact Three.js example as the reference:

https://threejs.org/examples/#webgl_animation_skinning_ik

Scott supplied that link when asked what the next demo should be. The goal is a working Margo Engine counterpart that demonstrates skeletal animation and interactive inverse kinematics. Inspect and interact with the reference before settling the character, scene, controls, and behavior. Reproduce the important experience using Margo's renderer and optional packages; do not embed the Three.js demo as the implementation.

At handoff time, the reference could not be inspected because the in-app browser reported a saved permission denial for `https://threejs.org`. No specific character, asset, GUI, solver, or reference behavior has therefore been verified. The suggestions below are an implementation starting point, not additional requirements Scott has approved.

## Start here

1. Read `C:/Development/Projects/margoengine/AGENTS.md` and check Git status before editing. Several managed worktrees exist; choose a suitable base deliberately.
2. Open the reference in the Codex in-app browser. Exercise its controls, orbit the scene, move its IK target, and record the important behavior and asset attribution.
3. Inspect the existing animation, animator, glTF, controls, and example code. Reuse existing capabilities before adding another implementation.
4. Build a separate local demo with a real skinned rig, responsive controls, and a clear visual demonstration of IK. A draggable target, an optional skeleton view, an IK toggle, and a reset are sensible defaults if they fit the reference.
5. Verify the result in the actual browser, including deformation and interaction, then show Scott the working demo. Publishing the next demo is a later step; this handoff request itself only authorizes writing the brief.

## Architectural constraints

`@margoengine/core` and the stage facade are feature-frozen for v1.0.0. Do not add skinning math, material graphs, post-processing passes, or other features there. Core plus stage gzip must stay **below 25,000 bytes**; CI fails at 25,000 bytes or above (AGENTS.md). The last reported measurement was 21,107 bytes.

Future capabilities belong in separate optional, tree-shakable packages. Relevant packages already exist:

- `@margoengine/gltf-pro`: glTF 2.0 PBR loading.
- `@margoengine/animation`: skeletal animation and morph targets.
- `@margoengine/animator`: gameplay animation and existing IK utilities.
- `@margoengine/post`: optional post-processing, if needed.

Verified source references are in the Tokyo source worktree:

- `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/packages/animation/README.md`
- `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/packages/animator/README.md`
- `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/packages/animator/src/ik.ts`
- `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/examples/robot-expressive.html`
- `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/examples/character-animation.html`

`Animation.attach(model)` supports glTF skins, joint hierarchies, inverse bind matrices, STEP/LINEAR/CUBICSPLINE sampling, and a WebGPU deformation pass. It supports four influences per vertex and explicitly rejects additional influence sets. Animation alone does not blend clips.

`Animator` supplies states, blend trees, transitions, masked additive layers, and foot IK while reusing the animation pass. It owns pose playback while attached; it pauses `Animation` and updates pose before world-matrix evaluation. Avoid two systems overwriting the same pose each frame.

`solveTwoBoneIK(root, knee, ankle, target, pole)` is exported from the animator package. It returns solved joint positions, clamps unreachable targets, and handles a degenerate pole direction. It is not a complete arbitrary-chain CCD solver or an automatic arm-rig adapter. Converting solved positions to the rig's local joint rotations and integrating that pose still needs careful work. Do not assume the reference's solver is already implemented.

`addFootIK` is specifically a direct three-node leg chain with a world-space downward ray callback. It requires positive uniform scales for bones and ancestors. Do not treat it as a general hand-target API.

## Recommended acceptance checks

- The mesh visibly deforms from its skeleton; moving rigid props is insufficient to demonstrate skinning.
- The target can be manipulated without simultaneously orbiting the camera. Mouse and touch have usable hit targets and release correctly.
- The hand or other end effector follows reachable targets with stable joint bending. Unreachable and nearly straight/folded poses remain finite and stable.
- World/local transforms, inverse bind matrices, rig scale, and update order are correct while the model is moved or rotated.
- Reset restores a coherent pose, target position, and view. IK enable/disable and animation playback work together if those controls are included.
- There are no browser errors, WebGPU validation errors, missing assets, or broken resource paths. Test a fresh reload and a viewport resize.
- Asset licenses and attribution are recorded. Inspect the actual asset license before reuse; do not infer it from the example site's license.
- Add focused mathematical or integration checks for any solver changes and run relevant package/build/size checks. Avoid broad unrelated changes.

Scott prefers visual verification of the actual model from multiple angles. Recent Tokyo feedback repeatedly caught wrong scale, floating objects, absent window details, glass-mounted AC units without support, and intersecting signs, awnings, or bicycles. Apply the same care to proportions, contacts, rig deformation, and scene composition here.

## Working preferences and browser permissions

Scott expects direct action and dislikes repeated permission requests for work already authorized. Continue reversible implementation and testing autonomously. Use the in-app browser to inspect demos and the existing Blender MCP add-on when Blender work is needed.

The current browser block is separate from filesystem permissions. The filesystem is already unrestricted. The browser tool specifically reported that a saved permission or managed policy denies `https://threejs.org`; it cannot be bypassed with another browser, raw CDP, or another access route.

The documented user setting is **Codex Settings → Browser → Agent permissions**. Scott reported changing **Browse → Always allow** and the **threejs.org** exception, but the subsequent verification still returned the same saved permission or managed-policy denial. Access is therefore **not verified or fixed**. Resolve the effective site permission before retrying the blocked page; organization restrictions may override a user setting. The available agent tools do not expose editing that saved site setting.

Official settings reference: https://learn.chatgpt.com/docs/reference/settings

Follow-up diagnostics ruled out an explicit local browser-origin policy in the user config. The project/parent `.codex/config.toml` files, `C:/Users/ScottCampbell/.codex/managed_config.toml`, and `C:/ProgramData/OpenAI/Codex/requirements.toml` were absent. `codex doctor --json` successfully loaded the invocation config (including cloud-managed policy), reported no locally visible recent security enforcement, and did not expose the effective site permission or active-thread overrides. The app logs showed the reference loading manually, but no matching denial detail. The separate ChatGPT plugin-permissions service did not recognize the built-in Browser as an installed connector, so no plugin settings were changed. These checks do not rule out saved UI exceptions, active-session state, or cloud-managed browser restrictions. The next missing evidence is the actual Browser → Agent permissions defaults and threejs.org exception shown in the app. A redacted diagnostic report is saved at `C:/Development/Projects/margoengine/test-results/browser-permissions-doctor.json`. No browser security settings were modified.

## Preserve the completed Tokyo demo

The Tokyo diorama is already updated, published, and verified at:

https://margoengine.com/demos/tokyo-diorama

Completed changes include restored windows; smaller, supported AC units with window framing; a pole moved out of a doorway; corrected bench height/support; separated signs and awnings; bicycle placement/scale; and a smaller cat.

The underside dedication is baked into the existing base texture: **Margo Engine**, a small heart, and **Made for Margie**, in warm gold on dark charcoal. It uses no separate lettering geometry. It shares the existing Ground atlas, with a dedicated underside material primitive. Preserve this result.

### Authoritative editable source

- Worktree: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine`
- Branch: `codex/tokyo-window-repair`
- Latest source commit: `937ed67ec97b44de8bb01b6f095d91894e1fe3a6`
- Native Blender file: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/examples/assets/source/tokyo-diorama.blend`
- GLB: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/examples/assets/tokyo-diorama.glb`
- Generator modules: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-window-repair/margoengine/examples/assets/source/tokyo_diorama/`

These source changes are committed locally. No Git push or PR was created in this session. The primary checkout may be older; do not overwrite the authoritative source with an older recovered asset.

The final GLB is 4,402,284 bytes with SHA-256:

`3058755dba48cef18eb87e5d37f13f23fbc98e7fe512a5236a022991ae4cea7a`

Validation completed: 14 relevant Node tests passed; glTF validation had zero errors and 12 existing image-profile warnings; the fast Blender scene check passed. The bake preserved 156 objects' geometry/UV/transforms and 28 other packed images.

### Blender MCP connection

Blender is installed at `C:/blender/blender.exe` and reports 5.3.0 Beta. Its MCP add-on is running at `127.0.0.1:9876`. This connection was successfully used to inspect and modify the scene. Do not claim Blender or the connection is unavailable without checking it.

Existing client: `C:/Development/Projects/margoengine/test-results/blender/mcp-request.ps1`.

The add-on accepts null-terminated UTF-8 JSON, for example `{"type":"execute","code":"import bpy\nresult = {'file': bpy.data.filepath}","strict_json":true}` followed by a NUL byte. The PowerShell client accepts `-CodeFile` with an absolute Python script path. Long jobs should run through a Blender timer and write a status file rather than exceed the client timeout.

Preserve the currently open Tokyo file before creating a different scene. Use a separate native file for the new demo.

For future Tokyo rebakes, `image.save()` alone can leave old packed bytes in the blend file. The working source saves the PNG, unpacks with `method='REMOVE'`, reloads, and packs the new image before export. Preserve that fix.

### Live deployment state

- Cloudflare Pages project: `margoengine`; production branch: `main`; direct upload, not Git-triggered.
- Latest verified deployment: `347259f8` at https://347259f8.margoengine.pages.dev
- Public model: https://margoengine.com/demos/assets/tokyo-diorama-3058755dba.glb
- Public entry bundle: `demos/assets/tokyo-diorama-8957dcfcf4.js`
- Deployment worktree: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-live-model/margoengine`
- Exact public snapshot: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-live-model/margoengine/test-results/tokyo-live-deploy/site`
- Deployment helper: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-live-model/margoengine/test-results/tokyo-live-model-update.mjs`
- Current model baseline/proof: `C:/Users/ScottCampbell/.codex/worktrees/tokyo-live-model/margoengine/test-results/tokyo-live-deploy/model-update.json`

Wrangler OAuth was authorized and the production upload succeeded. Recheck the login if future publishing is requested; never print credentials. All 164 public files were verified against the deployed snapshot. Only the Tokyo HTML and its new hashed JS/model files changed; the other demo/runtime assets were preserved.

Do not rebuild and redeploy the whole site from an arbitrary checkout: the current live snapshot contains earlier runtime/demo changes that may be absent there. A new-demo release needs a deliberate integration with the existing site and verification that Tokyo and the other public demos remain intact.

## Suggested opening message for the next chat

> Read `C:/Development/Projects/margoengine/docs/NEXT_DEMO_HANDOFF.md`. Build the next Margo Engine demo based on https://threejs.org/examples/#webgl_animation_skinning_ik. Inspect and interact with the reference first, use Margo's optional animation/animator packages, keep core and stage frozen, preserve the finished Tokyo demo, and show me a working local result.
