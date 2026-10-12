# @margoengine/navigation

Heavy optional Recast/Detour Wasm navigation, separate from the dependency-free navmesh package.

```ts
import {Navigation} from '@margoengine/navigation';
const navigation = await Navigation.create(positions, indices, {cs: 0.2, ch: 0.2, walkableRadius: 0.5});
const path = navigation.path({x: 0,y: 0,z: 0}, {x: 10,y: 0,z: 10});
navigation.dispose();
```

Input is flat XYZ triangle geometry. Construction initializes the actual recast-navigation Wasm module, generates a solo navmesh, and owns its Detour query. path returns world-space points or null. Numeric voxel/rasterization budgets are validated before entering Wasm. Configuration exposes the solo mesh's numeric build controls and buildBvTree; bounds are computed from input geometry. For tiled meshes, crowd simulation or off-mesh connections use recast-navigation directly.

The public Margo declarations deliberately do not re-export upstream Wasm declarations: recast-navigation 0.43.1 has extensionless imports and a legacy export-module declaration incompatible with strict NodeNext/TypeScript 7. Margo's narrow portable types compile in both NodeNext and Bundler modes without skipLibCheck.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/navigation

