# @margoengine/usdz-export

The standalone USDZ exporter entry point reuses exporters' tested exportUSDZ implementation.

```ts
import {exportUSDZ} from '@margoengine/usdz-export';
const bytes = exportUSDZ(engine);
```

Exports USDZ scene types and static scene serialization into an aligned USDZ archive with USDPreviewSurface materials. This lightweight exporter does not package textures or vertex colors; those inputs reject rather than silently lose data. For texture-bearing PBR models and broader USDZ interoperability, use the existing @margoengine/usdz package. The same exporter implementation remains available from @margoengine/exporters.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/usdz-export

