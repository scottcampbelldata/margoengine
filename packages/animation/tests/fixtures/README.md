# Eight-influence rig fixture

`tentacle-rig.glb` is Margo-made: `node packages/animation/scripts/make-rig-fixture.js` writes it (deterministic
bytes, no third-party data) with the exporters' GLB writer. `node scripts/animation-influences-browser-tests.js`
loads it.

- A tapered tube of 273 vertices (POSITION, NORMAL, TANGENT, TEXCOORD_0) skinned to a custom rig: an armature node
  (offset and turned, not a joint) above a chain of 8 joints with turned rest poses.
- Gaussian weights over every joint, strongest first: 247 vertices have nonzero `WEIGHTS_1`, with up to eight active
  influences. Both joint sets use unsigned 16-bit indices, and both weight sets use Float32 values.
- Two linear rotation clips, `wave` (2 s) and `curl` (1.5 s). 38,672 bytes.

The test loads the GLB through `loadGLTF`, compares GPU position, normal, and tangent deformation with an independent
CPU skinning reference, and poses a joint used by the secondary set. A four-influence truncation acts as a negative
control. Synthetic tests exercise all eight active influences, normalized integer weights, morph-before-skin order,
and a 1,001-joint palette.
