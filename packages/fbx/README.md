# @margoengine/fbx

Binary and ASCII FBX import uses Three's established FBXLoader, converts legacy materials to PBR, and preserves node hierarchy, bones, animation clips and morph channels through GLB into Margo's optional glTF-pro pipeline.

```ts
import {loadFBX} from '@margoengine/fbx';
import {Animation} from '@margoengine/animation';
const model = await loadFBX(engine, '/assets/character.fbx');
const animation = Animation.attach(model);
```

convertFBX(bytes) returns a GLB; parseFBX(engine, bytes) returns PBRModel. These are browser APIs (FileReader, image decoding); byte-budget and malformed-file tests can use a test-only FileReader adapter. HTTP(S) loading honors abort and bounds bytes to 64 MiB, converted output to 128 MiB and decoded textures to 16 million pixels. Resource loading follows the FBX model's base URL. The caller must keep image resources accessible and choose animation clips through the animation package.

Three is a runtime dependency only of this optional loader. It never enters core or the stage facade. FBX features unsupported by the upstream FBXLoader/glTFExporter do not become supported by this bridge; arbitrary shader networks are reduced to standard PBR.

CPU tests cover binary and ASCII input, animation channels and Khronos GLB validation. To add a real skinned asset to the WebGPU integration test, set MARGOENGINE_FBX_FIXTURE to its URL (or a Vite-served path) before running npm run test:modules:browser. The test checks retained skins/clips and changing rendered animation pixels. Byte limits do not make the upstream synchronous parser a sandbox; only load trusted FBX assets.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/fbx

