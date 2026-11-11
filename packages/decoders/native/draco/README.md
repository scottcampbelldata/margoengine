# Clean-room Draco crate

This dependency-free Rust crate powers the optional `@margoengine/decoders/draco-native`
entry. Default TypeScript entries still use the shipped prebuilts. No codec
implementation source was read or copied. Rules omitted by the published
specification come from the recorded crafted-input black-box experiments in
`docs/clean-room.md` and the batch 133 inference checkpoint.

Run the native regressions and build the private Wasm ABI:

```sh
cargo test --offline --locked --manifest-path packages/decoders/native/draco/Cargo.toml
cargo build --offline --locked --release --target wasm32-unknown-unknown --manifest-path packages/decoders/native/draco/Cargo.toml
node packages/decoders/native/draco/tests/wasm-kd.mjs
node packages/decoders/native/draco/tests/wasm-memory.mjs
node packages/decoders/native/draco/tests/wasm-prediction.mjs
node packages/decoders/native/draco/tests/wasm-metadata.mjs
node packages/decoders/native/draco/tests/wasm-flavor.mjs
node packages/decoders/native/draco/tests/wasm-predictive.mjs
```

The native tests retain 281 attribute, 369 KD and 730 topology fixtures. The KD
Wasm test compares every byte and descriptor, checks selected complete-file strict
prefixes, mutates streams and repeats decode/free. The memory regression compares
oracle-derived output hashes on two pinned ABeautifulGame streams and enforces
the prebuilt's unchanged 20,185,088-byte committed linear-memory ceiling. Fixture
provenance and grants are in `tests/fixtures/NOTICE.md` and `memory.json`.

Whole-corpus evidence is separate: all 454 original payloads match exact native
and float outputs, at an 18,874,368-byte Wasm peak. This does not establish full
feature/version/predictor coverage, process RSS, paired per-file performance,
typed conversion or loader/worker/lifecycle integration. Those replacement gates must pass before replacing either prebuilt. Coordinator
note 2 authorizes this optional landing with the remaining gaps recorded.

The additional 289-case prediction/traversal suite retains 247 exact
multi-parallelogram cases and 42 independent raw-attribute traversal canaries.
Prediction-degree traversal visits seed vertices even when their face was
already visited. The 41-case metadata suite preserves attribute and file roots,
raw keys/values and child references, including 32,769-byte values and 129 child
levels. Metadata parsing and destruction use a flat arena, without recursive
calls or a fixed depth ceiling. The private Wasm result appends a `META` arena
trailer when metadata exists. The optional bridge reads point names from the arena; the frozen real point
records check native types, names and bytes. Bytes a malformed last group
would need past the value read as zero: the opaque binding reads its own memory
there (E25), so those 22 strings are an accepted difference.

Historical texture-coordinate predictor 3 (versions 1.0 to 1.2) decodes with
the float32 rule, bit-stream bounds and wrap-span limit inferred in E23/E24;
`tests/legacy_uv.rs` checks 258 crafted cases (237 accepted, 21 rejected)
against the full opaque output.

`node --test packages/decoders/tests/draco-native.test.js` runs native tests,
builds this Wasm artifact and runs the KD, memory, prediction, metadata, flavor and predictive Wasm
regressions with hard process-tree limits. This package test is part of `verify`
and therefore `check:merge`; Cargo and its Wasm target are required, with no skip.

The expanded diagnostic retains all 454 original inputs and adds the existing
development fixtures: 1,937 unique streams match the full prebuilt, and all 1,003
accepted by the glTF prebuilt match its own output. These builds differ on
multi-parallelogram prediction: the glTF build reconstructs method 2 as difference
prediction. `decode` preserves full behavior; the native `decode_gltf` development
entry preserves that compatibility behavior. The private Wasm ABI accepts flavor
0 (full, including omitted sixth argument) or 1 (glTF); other values return a
coded error. One Wasm contains both paths. The 214-case flavor fixture compares
each output independently, including 60 crafted controls and held-out original
prediction fixtures. The optional TypeScript mesh worker uses flavor 1, and its point worker uses
flavor 0. Neither default entry is changed.

The tagged-bit cursor now loads at most five source bytes for a 32-bit value,
instead of loading one byte per bit. Its independent regression covers every
offset, width 0..33, strict input length and next-bit cursor position. This is a
source-read reduction with identical output, not a measured speed claim.

Predictive EdgeBreaker traversal 1 now retains 2,160 complete crafted cases over
versions 1.0, 1.1, 1.2, 2.0, 2.1 and 2.2. They cover C/R predictions, transmitted
fallbacks, split merges, disconnected components, vertex/corner attributes and
depth-first/prediction-degree ordering. All match the full opaque decoder. The
shipped glTF build rejects this traversal in all these cases, which is recorded
as a supported-feature difference, not a glTF exact-output claim. The native and
Wasm tests check both Rust flavors, 362,250 nonempty strict prefixes, 8,192
deterministic mutations and 2,000 repeated decode/free operations.

Seam-free attribute fans are no longer searched a second time for a seam. The
independent closed-tetrahedron work test counts 28/52/148 fan steps for 1/4/16
attribute streams, against 36/84/276 before. Restoring the old scan fails that
unchanged test. The paired 1,937-input diagnostic has no overall speed gain and
retains two small total-output timing losses. This is less work with identical
output; it is not a decoder speed-parity claim. The optional public entry has separate worker/bundler tests; other
feature inventory, cold/RSS completion and remaining speed losses are still open. The coordinator permits landing an optional entry with warm losses
recorded once its other gates pass; the prebuilt stays the default until parity.
