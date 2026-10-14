# Atomic Planet map upgrade — October 13, 2026

The optional Creative Planet now supports `await earth.updateMaps({dayMap, nightMap, specularRoughnessMap, normalMap, clouds, signal})`. It replaces one complete map set after fetch, decode, dimensions/budget checks and GPU validation. The committed surface, clouds and atmosphere stay drawable while the replacement is pending. A failed or canceled operation leaves that complete preview active.

The method returns `Promise<void>`, requires a day map, uses existing URL/AbortSignal validation, and rejects a second pending operation. Omitted optional maps use the existing fallbacks. It keeps the same Planet/plugin identity, transform nodes and rotation reference, tilt, sun, cloud offset object and registered pass callbacks. It does not add a Core or Stage feature.

Downloads remain bounded to 32 MiB per map. Distinct retained plus candidate decoded bitmap identities share the 256 MiB budget and the current device's texture limit. This bounds accepted decoded ownership; it is not a claim that browser decoder transient memory cannot exceed that amount. Each operation has its own abort controller, so one failed replacement does not cancel the visible Planet's lifetime. Late decoded candidates and failed candidate GPU resources are retired exactly once.

Device restoration during fetching rebuilds the committed preview. A device change during candidate validation disposes that stale candidate and revalidates/rebuilds it against the current device before adopting it. Cancellation and disposal during delayed validation preserve the abort reason even when the old device's validation promise rejects. The existing linear sampler, single mip level, sphere geometry, shader maps and target formats are unchanged. Rebuilding and uploading the replacement pass may cause a hardware-dependent hitch; browser upload and final-pixel measurements are a separate acceptance step.

## CPU validation

The Creative build and emitted TypeScript declarations succeed. All **23 Planet checks** pass: 13 existing checks and ten added upgrade checks covering atomic five-map publication, transform/callback identity, overlap rejection, local sibling cancellation, late decoding, retry/fallback behavior, pipeline/GPU validation failure, retained-plus-pending budgets, device races, disposal and steady resource reuse after the first target-variant draw. The existing consumer-isolation checks still keep Planet out of Core-only and particle bundles.

Commands run in the canonical checkout:

```powershell
node packages/creative/scripts/build.js
node --test packages/creative/tests/planet.test.js
```

Two initial failures are retained in the work record. TypeScript required an explicit `GPUDevice` annotation for the loop-local device. The atomic-upgrade test initially asserted steady allocation counts before the new pass's first lazy target-variant draw; it now warms that first draw before checking repeated frames. Neither correction changes rendering quality. A further cancellation check covers both resolved and rejected delayed validation for caller cancellation, plus rejected validation after disposal.

## Optional package bytes

Write-false Vite library builds use the same current dependencies, target `es2022`, and external Core/extension imports for both forms. The baseline Planet source is from Git `5fc55a0826fba23f0ff220f48bc6bf6de6c305cd`; only `planet.ts` is substituted for that baseline, preserving the same current PlanetPass and other Creative code in both builds. Node's default `gzipSync` is used consistently.

| Consumer entry | Before raw | After raw | Before gzip | After gzip | Gzip change |
| --- | ---: | ---: | ---: | ---: | ---: |
| `@margoengine/creative/planet` | 21,180 | 23,353 | 6,635 | 7,141 | +506 bytes |
| Full Creative index | 78,860 | 81,033 | 21,345 | 21,872 | +527 bytes |

The new optional capability is not byte-neutral. These are isolated library entry sizes, not the final Earth consumer size, complete site payload, load time, or a Core/stage size increase. The core freeze remains in force.

Source SHA256 before: `74e4d9956e5dc61e4d42f876a5433d29af68b981d3122a14cd6065a6b3eb33ee`; after: `37b55131b4a72192b8736b2e37ea4df08c4b91b21709ac96ecaead4614af818e`. Planet entry bundle SHA256 before: `4a872089d3619ea6a706c7c306da24dc34904e53824914418ea5165f84b3f7f8`; after: `6d3142c0eada3697db0dcce4ca715898761300ec99f54322158748d691fdd787`.

Raw CPU size evidence and the built before/after JavaScript are in ignored `test-results/planet-shadow-committed-byte-check.json` and `creative-{planet,index}-maps-shadow-{before,after}.js`. No browser/device benchmark ran during this CPU validation window. Earth preview presentation, desktop all-five-map final equality, cancellation/fallback behavior and upload hitch timings require the separate browser fixture before claiming complete application acceptance.

## Functional browser verification

`node scripts/test-earth-streaming.js` subsequently passed all five local-source
scenarios on Intel Arc 140V, headless Edge 154.0.4258.62: desktop success, failed
detail, departure while detail is held, Android layout, and a direct full-map
baseline. The final desktop screenshot after the atomic upgrade matches direct
loading of all five original 2K maps exactly in every PNG channel. Both images
are nonempty; camera, sun, rotation, cloud offset and render clock are fixed.

The same Planet, rotation and cloud-control object references remain active.
Failed detail retains all five 1K images; departure retires the engine and decoded
images without late publication. Android layout requests no desktop maps. The
desktop detail requests start after the identified complete preview presentation
opportunity. Preview opportunities were 542 / 442 / 539 / 584 ms across success,
failure, departure and Android-layout cases; the direct 2K baseline was 876 ms.
These warmed local-source observations do not prove cold network timing, physical
mobile performance or hitch-free upgrade. Raw output is
`test-results/earth-streaming.json`, with direct/streamed/failed-preview PNGs.
