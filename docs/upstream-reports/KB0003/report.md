# Firefox on Windows: a WGSL function named `dx` fails to compile (DXC redefinition error)

Draft for bugzilla.mozilla.org, product Core, component Graphics: WebGPU. Not filed. Margo row: KB0003 in docs/known-bugs.md.

## Environment

- Firefox 157.0 (Playwright's Firefox build 1555), Windows 11, headed, prefs `dom.webgpu.enabled=true` and `gfx.webgpu.ignore-blocklist=true`.
- GPU: NVIDIA RTX A6000, driver 32.0.16.1742 (617.42). Firefox reports an empty adapter description.
- Chromium (Edge 157.0.4341.42, Dawn/Tint, same GPU) compiles every case below.

## Steps

1. Serve this folder over `http://localhost` and open `dx.html` in Firefox with WebGPU enabled (or run
   `node docs/upstream-reports/run-page.mjs docs/upstream-reports/KB0003/dx.html --browser=firefox` from the Margo repository).
2. The page builds five render pipelines whose fragment shader differs only in one identifier.

## Expected

All five build. The WGSL is valid: `dx` is not a keyword or reserved word in WGSL.

```wgsl
fn dx() -> f32 { return 1.0; }
@fragment fn f() -> @location(0) vec4f { return vec4f(dx()); }
```

## Actual

Only the function named `dx` fails (`createRenderPipelineAsync` rejects with `GPUPipelineError`):

```
Internal error in ShaderStages(FRAGMENT) shader: DXC compile error: hlsl.hlsl:8:7: error: redefinition of 'dx' as different kind of symbol
float dx()
      ^
hlsl.hlsl:15:23: error: unexpected namespace name 'dx': expected expression
```

`fn dy`, `fn ex`, a local `let dx` and a local `var dx` all compile.

## Analysis

The WGSL to HLSL translation keeps the identifier `dx`, which DXC (the HLSL compiler) treats as a namespace (the `dx::` intrinsics),
so a global function of that name collides. Renaming identifiers that collide with DXC namespaces would fix it.

## Result on this PC (2026-11-11)

Still reproduces: Firefox 157.0, case `fn dx` fails exactly as above, the other four pass; Edge 157 passes all five.

## Files

`dx.html` (the repro, no libraries), `../run-page.mjs` (optional Playwright driver).
