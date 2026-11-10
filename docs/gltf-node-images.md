# glTF images without browser decoding

When `createImageBitmap` is absent, `loadGLTF`, `parseGLTFAsync` and progressive image loading lazily use the existing `@margoengine/decoders/image` entry. PNG and JPEG need no caller decoder hook. The browser path still requests no colour-space conversion and no alpha premultiplication.

The resulting `GLTFPixelImage` holds `width`, `height` and `data`: top-first RGBA8 rows with straight alpha. Models retain these bytes for device restoration. Normal material setup writes level zero with `queue.writeTexture` and generates the same GPU mip chain as the bitmap path. `uploadImage` returns a caller-owned, single-level texture. Material extension maps and MToon accept pixel sources; React cached model mounts copy their bytes independently.

Existing download, decoded-image and device dimension limits still apply. Decoder support and errors are those of the existing optional image decoder. CPU memory includes four bytes per pixel plus each independent React image copy. No decoder speed claim is made, and different JPEG decoders need not round identically.

Evidence: `packages/gltf-pro/tests/node-images.test.js` covers PNG/JPEG data URIs, buffer views and fetched files, upload bytes, mip allocation, restoration, failures and abort. Its six source cases fail on the original loader. `test-node-images.mjs` compares real Node WebGPU texture renders exactly with uniform base-colour references. `test-pixel-images.mjs` compares PNG bitmap/pixel rendering and restoration pixel for pixel on native WebGPU and WebGL2. Material, MToon and React regressions cover the consuming paths.

Clean-room sources compared before implementation:

- Khronos 3D Formats Working Group, *glTF 2.0.1 Specification* (2021), [Images and Textures](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#texture-data).
- W3C GPU for the Web Working Group, *WebGPU* (2026 draft), [byte and external image uploads](https://www.w3.org/TR/webgpu/).
- W3C PNG Working Group, *Portable Network Graphics, Third Edition* (2025), [stored samples and alpha](https://www.w3.org/TR/png-3/).

The fix reuses Margo's own decoder and upload paths. No external implementation source was read or copied.
Node bundles retain @margoengine/decoders as an installed dependency for runtime resolution. The worker URL postprocessor preserves runtime import annotations, so model-free browser kit imports discover no codec assets.
Model entry size: 60,402 bytes gzip before, 60,566 after (+164), measured against the parent source with the quality bundle method. The optional entry ceiling rises from 60,429 with normal headroom; splitting would duplicate loader/upload/restoration paths and require caller configuration for these 164 bytes.
