# Basis encoder loading and recovery

The default `@margoengine/exporters/ktx2` encoder is Margo's clean-room
Rust/Wasm ETC1S/UASTC encoder, loaded only when encoding starts. It requires
WebAssembly SIMD. `encoderPath` is an explicit compatibility override for an
external `basis_encoder.js` and `basis_encoder.wasm`; those files are not the
default bundled encoder.

The loader maps CSP compilation failures through the existing `wasmError`
translator to MargoError `failed`, naming `script-src 'wasm-unsafe-eval'` and
linking to CSP help. Other initialization and HTTP failures carry `failed`
and a help link. When compilation fails, a small owned module containing
`v128.const` distinguishes missing SIMD (`unsupported`, with a help link)
from an invalid encoder asset (`failed`). The original initialization error
is retained as `cause` in process. Worker replies retain code and help text.
There is no scalar fallback and no automatic retry loop.

Node calls and worker messages share a pending module load. A rejected load is
removed from the cache before its callers receive the error. The next encode
call or worker message can start one new load attempt. A successful module
stays cached. RDO buffers enter cleanup ownership immediately after allocation,
including when allocating the second buffer traps.

## Standards and clean-room basis

Reviewed before implementation, without reading companion implementations:

- *WebAssembly JavaScript Interface*, W3C WebAssembly Working Group,
  editors Ms2ger and Ryan Hunt, 2026 draft:
  https://webassembly.github.io/spec/js-api/ . Validation, compilation and
  instantiation have different failure paths; `validate` tests feature support
  without starting a module. Allocation failures must unwind owned resources.
- *WebAssembly Core Specification 3.0*, W3C WebAssembly Working Group, 2026:
  https://webassembly.github.io/spec/core/ . The vector type and binary
  `v128.const` encoding define the diagnostic module written here.
- *Content Security Policy Level 3*, Mike West and Antonio Sartori, W3C,
  27 October 2026 draft: https://www.w3.org/TR/2026/WD-CSP3-20261027/ .
  The WebAssembly compilation policy is checked independently of feature
  validation, so policy errors take precedence over the SIMD diagnostic.

## Reproduction

After `npm run build:packages`, run
`node --test --test-timeout=120000 packages/exporters/tests/basis-loading.test.js`.
The tests inject compilation, transport and allocation failures; check linked
codes and causes; verify that two concurrent callers share each attempt;
fail successive calls then recover through real encoding; exercise the built
worker in an isolated VM; and validate the SIMD probe on the real runtime.
Missing SIMD is simulated deterministically, not certified on an old browser.
No throughput, quality or new hardware compatibility claim is made.
