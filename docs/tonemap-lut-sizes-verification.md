# Variable-size .cube LUT verification

Verified 2026-10-17 in optional `@margoengine/tonemap`. Core and stage source are unchanged by this feature.

`parseCube` accepts integer sizes 2–65 and exactly `size³` RGB rows, red index varying fastest. Its result includes
`size`, Float32 RGBA samples and Float32 domains. Legacy manually constructed objects without `size` retain the
33³ contract. Text is limited to 32 × 1024² JavaScript characters, enough for high-precision 65³ files exceeding
the former 8 Mi-character cap. Unsupported 1D/shaper formats remain unsupported.

LUT replacement snapshots all input data, validates the actual 3D texture dimension limit, and uploads matching
dimensions/row pitch. Validation, allocation and upload failures preserve the prior CPU and GPU LUT. Failed new
textures are destroyed. Restoration retains the CPU snapshot, and even a failed restoration keeps the engine
owner so disposal can remove its plugin and passes.

Non-33 cubes share one shader variant that derives the lattice endpoint from `textureDimensions`. Both the SDR
and HDR/P3 excess entry points use that variant. Original 33³/no-LUT shader text, pipeline keys and GPU command
descriptors remain unchanged. No sampler filtering feature is required: interpolation still uses eight texture loads.

## Focused and physical GPU checks

Before implementation, parser tests failed for the 33-only restriction, old text cap, early sample allocation and
manual non-33 arrays. Runtime tests also exposed missing device-limit validation and CPU state corruption after
an upload failed. Review caught lost engine ownership after restoration failure; its regression failed before the fix.

All 25 Tonemap Node tests pass, including seven parser and ten runtime regressions. Strict TypeScript checks pass
for all 74 packages. The API report contains 173 entries and 1,782 exports. Tonemap hygiene has no new violations;
its existing bare-error violations decrease from 15 to 8.

`node scripts/tonemap-lut-sizes-gpu-check.js` passes 605 checks on physical NVIDIA Ampere hardware
(`fallback=false`) at actual 1x and 4x MSAA. There are 62 accepted captures plus 18 excess attachments, no rejected
cases, and no page, engine or WebGPU validation errors. Ignored results: `test-results/tonemap-lut-sizes/gpu.json`.

Known HDR stripes and independently generated nonlinear cross-channel cubes are compared against a CPU oracle
that enumerates all eight lattice corners. Cases cover sizes 2, 16, 17, 32, 33, 64 and 65; domains, clamping,
red-fastest order, parsed text and manual objects, standalone capture, external sources, PostStack, replacements,
input mutation and device reboot. Maximum ordinary error is 0.0004883; maximum HDR/P3 excess error is 0.0018877
on float16 targets. Legacy 33³/no-LUT shader hashes and attachment hashes remain exact.

The HDR/P3 tests exercise Tonemap's production fragment/excess shaders through the ColorOutput context protocol.
They do not independently test browser canvas HDR negotiation or ColorOutput's final compositor.

## Demo reference update

Only the existing NVIDIA profile's `tonemap-high` and `tonemap-phone` UI references change, to advertise the new
sizes. Both were captured four times from clean implementation commit `6be169b`; all runs are bit-identical.
Independent pixel inspection confirms that both rendered canvas rectangles are exactly unchanged. Differences
are confined to the introductory text and file-input label. Other images, original Intel references, noise floors
and tolerance policy remain unchanged. Per-view provenance records the clean commit, matching browser/adapter,
AC power, and no rendered-input changes. The profile's original creation audit remains historical.

## Main integration gates

`npm run check:merge` exits 0: all 2,504 Node tests, all 15 current proofs, the site build and all 55 visual
comparisons pass. The seven additional `verify:full` package/interop checks pass, including 163 Node tests and
strict import consumers of all 74 packaged modules. Final Tonemap hygiene has no new violations. Core + stage
measures 21,094 bytes gzip (50,155 raw). Logs are retained under ignored `test-results/lut-sizes-*.log`.
