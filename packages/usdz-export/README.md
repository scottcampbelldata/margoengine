# @margoengine/usdz-export

The standalone USDZ exporter entry point reuses exporters' tested exportUSDZ implementation through `@margoengine/exporters/usdz`, so direct ESM imports load only the USDZ serializer and its shared scene collector.

```ts
import {exportUSDZ} from '@margoengine/usdz-export';
const bytes = exportUSDZ(engine);
```

Exports USDZ scene types and static scene serialization into an aligned USDZ archive with USDPreviewSurface materials.
Linear RGB/RGBA vertex colors (including baked AO) multiply the base color and are written as `displayColor` and
`displayOpacity` primvars read by the material; BLEND keeps vertex alpha, OPAQUE ignores it. Textures and alpha masks
are refused rather than silently lost. For texture-bearing PBR models and broader USDZ interoperability, use
@margoengine/usdz. The same exporter is also available from @margoengine/exporters.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/usdz-export

