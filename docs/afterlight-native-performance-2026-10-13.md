# Afterlight native Windows performance — 2026-10-13

The measured package candidate improves Afterlight on this laptop while preserving all three tested views exactly. It **does not meet a steady 60 FPS floor or a complete load under one second**. This is a local comparison against the JavaScript saved from the live site, not a production deployment or a physical Android result.

## Builds and scope

| Bundle | Raw bytes | Gzip bytes | SHA-256 |
| --- | ---: | ---: | --- |
| Live baseline, `index-uuvsyWZj.js` | 301,030 | 99,299 | `1d096ef1af9fc7b0d505d46e70d6e5bd1ee0de906590151f3e0b156977ce9fa1` |
| Local candidate, `index-c_L5U9OO.js` | 303,091 | 100,023 | `9059913c2279a631019f08cfc6e289d6f5d6f147fe2657131393e7dc3e91e65f` |

Gzip was measured with Node's default `gzipSync`, consistently for both files. The candidate is +2,061 raw / +724 gzip bytes across the whole app, including diagnostic changes. It includes PCSS disk constants, the stable Water HDR borrow, original exact Sky fog, timestamp feature negotiation and opt-in Stats timing. The rejected full Scatter culling candidate is absent. This snapshot precedes the later Afterlight staged-startup changes, so these startup numbers must not be attributed to that later implementation.

The live asset was downloaded at 06:45 UTC on October 13. The immutable candidate snapshot was saved at 07:31 UTC; the native comparison began at 07:36 UTC. Saved live and earlier baseline JavaScript remained available. The attempted archive of the previous **full** `site/dist` failed before the rebuild; that prior full output was replaced and is not claimed to have been archived. The new candidate output was successfully preserved under `test-results/site-final-native-candidate-2026-10-13T07-31-24-948Z`.

## Conditions and protocol

- Headed Microsoft Edge 154.0.4258.62 on the actual Intel Arc 140V (`intel`, `xe-2lpg`, fallback adapter false).
- Maximized native viewport and engine backing buffer: 1,432 × 768. Browser DPR is 2; rendering remains capped at DPR 1. Geometry and scene attachments retain 4× MSAA.
- Unchanged desktop workload: 73,728 terrain triangles, 110,000 grass candidates, 256 water segments and four 1,024² shadow cascades. Particle capacity is exactly Off or 1,000,000 as indicated.
- The ordinary application RAF loop ran continuously. Each fresh context warmed for 3.5 seconds, followed by six one-second observation windows. Bundle order was baseline → candidate → candidate → baseline for each particle tier.
- Camera remained identical from each measurement's beginning to end. Solar clock was frozen at 17.599931666666535 hours. Every one-second observation reported `document.visibilityState === 'visible'` and `document.hasFocus() === true`.
- Benchmark-only browser flags: `--start-maximized`, `--disable-features=CalculateNativeWinOcclusion`, `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`. These prevent test-window occlusion from throttling the comparison; they are not production requirements or evidence that occlusion causes the user's live issue.
- Existing user browser processes remained open. Counterbalancing limits clock and contention drift, but the measurements remain specific to this laptop and workload.
- Default cadence runs created no query sets, query-resolve buffers or profiler read buffers. GPU timestamps were collected in separate runs.

## Native cadence and frame tails

| Particles | Run | Mean FPS | Lowest one-second FPS | p95 ms | p99 ms | Maximum ms | Draws / dispatches |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Off | Baseline A1 | 44.06 | 42.66 | 25.70 | 26.00 | 33.30 | 134 / 13 |
| Off | Candidate B1 | 55.83 | 52.86 | 25.50 | 25.90 | 26.30 | 134 / 13 |
| Off | Candidate B2 | 59.70 | 56.85 | 17.70 | 25.90 | 26.20 | 134 / 13 |
| Off | Baseline A2 | 52.10 | 48.89 | 25.60 | 26.10 | 26.30 | 134 / 13 |
| 1,000,000 | Baseline A1 | 35.09 | 32.73 | 34.10 | 34.40 | 34.70 | 135 / 14 |
| 1,000,000 | Candidate B1 | 43.15 | 42.77 | 26.00 | 26.50 | 34.10 | 135 / 14 |
| 1,000,000 | Candidate B2 | 41.70 | 36.90 | 33.50 | 35.40 | 36.60 | 135 / 14 |
| 1,000,000 | Baseline A2 | 38.82 | 36.73 | 34.00 | 35.20 | 35.50 | 135 / 14 |

Counterbalanced means: **Off 48.08 → 57.76 FPS (+20.1%)**; **1M 36.96 → 42.42 FPS (+14.8%)**. These are measured improvements, not guarantees for other devices. No candidate run maintained at least 60 FPS in every one-second window. Raw frame intervals came from the existing Stats ring, sampled once per second; no extra per-frame timing callback was inserted.

## Exact scene comparison

Fresh reduced-motion contexts stayed paused from startup, with particles Off and all shader clocks at zero elapsed simulation time. Both bundles used 17.57 hours and the same camera at each yaw. Each view received identical manual `delta: 0` renders followed by GPU queue completion. HUD/control elements, including changed Stats labels, were hidden without changing the scene layout.

| Camera yaw | Compared pixels | Changed RGB pixels | Maximum byte difference |
| --- | ---: | ---: | ---: |
| 0° | 1,099,776 | 0 | 0 |
| 90° | 1,099,776 | 0 | 0 |
| 180° | 1,099,776 | 0 | 0 |

This proves RGB equality for those three complete paused views. It does not claim that every possible camera/time/particle state was exhaustively compared.

## Separate opt-in GPU timing

The candidate was opened with `?gpuTiming`. It created exactly **one query set, one query-resolve buffer and one read buffer**. Both eight-second measurement windows allocated zero additional query sets or GPU buffers. Public Stats getters exposed the retained 128-slot pass array and full first-pass-to-last-pass elapsed span. Default runs created zero timing resources even when the device exposed `timestamp-query`.

| Particles | Complete samples | Timed passes | Median sum of passes | Median full GPU span | Median intervening commands/transitions |
| --- | ---: | ---: | ---: | ---: | ---: |
| Off | 27 | 27 | 13.43 ms | 18.02 ms | 4.85 ms |
| 1,000,000 | 23 | 29 | 18.87 ms | 22.74 ms | 3.80 ms |

The last column is the median of each sample's span minus its pass sum; it is not the difference of the two separately reported medians. Pass timestamp sums omit work between passes, so the 13.43 ms sum does **not** establish that the entire Off frame fits within 16.67 ms.

| GPU work | Off median | 1M median |
| --- | ---: | ---: |
| Main terrain/explorer PBR | 5.05 ms | 5.51 ms |
| Fixed settlement PBR | 2.03 ms | 2.23 ms |
| GPU grass draw | 1.11 ms | 1.18 ms |
| Atmospheric fog with per-sample depth | 1.11 ms | 1.11 ms |
| Water surface | 0.85 ms | 0.85 ms |
| Particle compute | Absent | 2.49 ms |
| Particle draw | Absent | 2.56 ms |

Timings use actual GPU timestamps, quantized in roughly 0.065536 ms increments on this adapter. Profiled cadence was 50.77 FPS Off and 42.55 FPS at 1M; these instrumented observations are separate from the default cadence results above. Main PBR, MSAA attachment transitions/depth copies and optional particle work remain material costs. No CPU-versus-GPU cause is inferred solely from FPS.

## Complete startup remains above one second

The ready timestamp was recorded synchronously when the application published `window.sandbox`, after its warm full-world render and awaited GPU queue completion. It is relative to navigation's performance time origin. The queue wait is measured separately and can include first-use compilation, queued initialization and rendering; it is not identified as pure raster time.

| Particles | Run | Complete scene ready | Final warm queue wait |
| --- | --- | ---: | ---: |
| Off | Baseline A1 | 1,525.7 ms | 987.7 ms |
| Off | Candidate B1 | 2,675.4 ms | 1,619.5 ms |
| Off | Candidate B2 | 2,226.4 ms | 1,290.0 ms |
| Off | Baseline A2 | 2,146.9 ms | 1,258.6 ms |
| 1,000,000 | Baseline A1 | 1,453.3 ms | 975.1 ms |
| 1,000,000 | Candidate B1 | 2,499.7 ms | 1,474.9 ms |
| 1,000,000 | Candidate B2 | 2,416.6 ms | 1,470.2 ms |
| 1,000,000 | Baseline A2 | 2,645.8 ms | 1,671.8 ms |

All four candidate complete-load observations missed one second. The unprofiled fresh-context startup also appears slower for this candidate in these runs; cadence gains therefore do not establish a load-time gain. Later staged-startup principal-view opportunities, headless tests and warmed-page loads must be reported separately.

## Reproduction artifacts

The ignored `test-results` directory contains the immutable candidate, live JS, raw numeric reports and six scene PNGs:

- `afterlight-final-native-ab.mjs`: separate `off`, `million`, `stills` and `profile` phases; no overlapping GPU work.
- `afterlight-final-native-off.json` and `afterlight-final-native-million.json`: every interval, one-second rate, startup timestamp, foreground state and resource audit.
- `afterlight-final-native-stills.json` and `afterlight-final-{baseline,candidate}-yaw-{0.000,1.571,3.142}.png`: exact-view inputs and outputs.
- `afterlight-final-native-profile.json`: shader/pipeline metadata, per-pass samples, elapsed spans and allocation counters.
- `afterlight-final-native-digest.json`: annotated combined results.

The harness uses the installed bundled Playwright path on this host; another checkout must supply its own Playwright import and the saved bundles/snapshot. The tables, hashes, conditions and limitations above remain portable without the ignored artifacts. All browser contexts, GPU devices and preview servers were closed after testing.

## Rejected isolated 1× final presentation prototype

A later private prototype retained all 4× scene geometry, depth samples, HDR capture, bloom blur, water, fog and shadow work. It deferred the final AgX composition until the frame ended, wrote directly to the retained single-sample swapchain view and skipped the now-redundant outer 4× color resolve. Any later render pass flushed the original 4× AgX path first. This existed only in an ignored route override and browser fixture; **no production Core/Post source or distribution was changed**.

The isolated modified bundle SHA-256 was `e78ccfda2b054db47e0d01c4e74d48f4f772fde4c3efa5fe7a2cf4f008d30f88`. Its virtual Core/stage callback estimate was **20,005 gzip bytes**, 30 above the existing 19,975 bytes and outside the strict budget. A full source rebuild would have to repeat the gate before any acceptance.

All three paused native views remained exactly equal in RGB, including restoration to the original path. The actual built SceneFade with a fixed partially blended clock and a real later 4× depth-writing pass both took the fallback and remained exactly equal. A 1280×720 resize and a real `rebootDevice()` also preserved matched RGB; the wrapper audit recorded six fallbacks, zero stale callbacks and calls through a user encoder wrapper. These checks establish the tested visible results, not an exhaustive all-depth-samples equality claim.

Native timing used a separate fresh maximized context with `viewport: null`, unchanged 1432×768 backing buffer, particles Off and the same fixed camera. Both paths used the same prototype Core branch, so the optional callback check existed in both. Four sequential same-page runs produced:

| Path | Mean FPS | p95 frame interval | p99 frame interval | Maximum interval |
| --- | ---: | ---: | ---: | ---: |
| Original 4× A1 | 46.24 | 25.80 ms | 26.20 ms | 26.60 ms |
| Direct 1× B1 | 49.85 | 25.50 ms | 25.80 ms | 26.10 ms |
| Direct 1× B2 | 52.75 | 25.40 ms | 25.80 ms | 26.20 ms |
| Original 4× A2 | 55.89 | 25.50 ms | 25.90 ms | 26.50 ms |

Counterbalanced means were **51.07 → 51.30 FPS (+0.46%)**. The steadily rising cadence across all four runs shows clock/contention drift larger than the proposed gain. Every one-second foreground observation was visible and focused; all paths recorded 134 draws, 13 dispatches and zero query resources. This provides no meaningful whole-app gain and no 60 FPS floor.

A separate actual-shader, same-command-buffer GPU fixture alternated 10 original/direct pairs, with a dependent one-texel read after output. Original 4× AgX plus the terminal resolve took **0.459 ms median** versus **0.197 ms** for direct 1×, winning all 10 pairs and saving about **0.262 ms**. Full native-color readback also matched all 4,399,104 channels exactly. The small isolated GPU saving did not establish a material native cadence improvement, so this callback prototype is rejected under the current performance and size criteria.

## Resolve spans need a dependent read

Another separate diagnostic inserted dependency markers around the actual unchanged scene's two HDR color resolves, then measured AgX and terminal resolve separately using matching full-size native-color targets. A one-texel compute read consumed each resulting attachment; this includes its store/resolve/transition latency and adds synchronization. The source remained the immutable package candidate above.

| Work | Dependent span median | Original pass-only median |
| --- | ---: | ---: |
| Actual pre-water HDR color resolve, five frames | 0.524 ms | 0.000 ms |
| Actual final HDR color resolve/depth retirement, five frames | 1.114 ms | 0.000 ms |
| AgX 4×, 10 pairs | 0.262 ms | 0.262 ms |
| AgX 1×, 10 pairs | 0.262 ms | 0.262 ms |
| Outer native-color 4× resolve, 10 pairs | 0.328 ms | 0.000 ms |

The final HDR descriptor also retires its attached HDR depth, so its span is not identified as pure color bandwidth. The final-HDR dependent spans ranged 0.655–1.245 ms. The zero empty-pass numbers fail to capture the corresponding downstream work; the pass sums alone therefore underestimate it. These separately synchronized medians cannot be summed to assign all 4.85 ms of the earlier full-frame gap. AgX sample-count shading itself showed no median gain in the separate split fixture; the measurable terminal saving came from avoiding the extra attachment/resolve path.

Raw fixtures and output are `post-terminal-native-prototype.mjs`, `post-terminal-prototype-browser.js`, `afterlight-final-native-presentation-prototype.json`, `post-resolve-spans-native.mjs` and `afterlight-final-native-resolve-spans.json` in ignored `test-results`. All GPU resources, contexts and servers were closed before the hardware slot was released.

## Provisionally retained exact-zero shadow contribution guard

The next optional Shadows prototype kept the public `shadowVisibility` function byte-for-byte unchanged. It wrapped only the existing `direct * shadowVisibility(position, normal)` operation:

```wgsl
fn shadowLit(direct:vec3f,position:vec3f,normal:vec3f)->vec3f {
  if(all(direct==vec3f(0))){return direct;}
  return direct*shadowVisibility(position,normal);
}
```

This uses exact equality, with no epsilon and no changed tap pattern, bias, slope correction, normals, material, light or nonzero multiplication order. Core, Terrain and both Scatter renderers use the BRDF `direct` vector before radiance/intensity multiplication. glTF-pro already includes radiance/intensity in `direct`. The adapter leaves later ambient, emissive, clustered and React environment terms intact. NaN direct components do not compare equal to zero and keep the original call; arbitrary undefined WGSL arithmetic is not given a new guarantee.

PCSS performs **up to 16 blocker texture loads**, then **up to 32 comparison-sampler taps when blockers exist**. Out-of-cascade/out-of-map/no-blocker paths already return early. The 48-tap maximum is not an unconditional cost paid by every fragment.

Actual unchanged PCSS GPU fixtures varied four real cascade orientations, normals, exact-zero contribution coverage, signed-zero components and a degenerate-normal stripe. Both 1× and 4× runs matched every HDR channel exactly in all four 1,048,576-pixel cases, with no nonfinite outputs or GPU errors. At 4×, paired dependent span medians were:

| Fraction with nonzero contribution | Original span | Guard span | Guard faster pairs |
| --- | ---: | ---: | ---: |
| 0% | 2.490 ms | 0.983 ms | 10 / 10 |
| 25% | 2.490 ms | 1.049 ms | 10 / 10 |
| 75% | 2.556 ms | 2.097 ms | 10 / 10 |
| 100% | 2.753 ms | 2.556 ms | 9 / 10 |

The fully nonzero shading-only medians both read 2.163 ms; that resolution-limited tie does not establish zero overhead on every device. Each coverage scenario also used a different cascade orientation, so the table is a set of paired conditions, not a fitted coverage scaling law. The 1× all-zero span was 2.032 → 0.131 ms. Those large synthetic savings cannot be assigned to the island's unknown real zero-contribution coverage.

The private Afterlight native ABBA matched all three paused views and their restored originals exactly. Its unprofiled rates were original 47.37 / 55.66 FPS and guard 51.82 / 45.81 FPS: counterbalanced means **51.52 → 48.81 FPS**. It did not establish a whole-app gain or a 60 FPS floor. Separate pooled GPU ABBA gave mean window medians Main PBR 7.274 → 5.800 ms, settlement 3.408 → 2.359 ms and full span 26.411 → 21.103 ms. Unchanged water and fog also became faster during the guard windows, so those raw 5.308 ms span savings include clock/memory-state effects and are not attributed entirely to gating. Every profile window reused its one pool with zero steady query or GPU-buffer allocations.

To resolve that conflict, a final fixture captured the actual native 1432×768 HDR4× beauty descriptors, geometry draw commands, resources, camera and light. It copied the real initial color/depth before each captured pass, rebuilt bind groups for each cloned auto-layout pipeline, stripped old timestamp writes and alternated ten original/guard pairs on one command buffer. The combined case retained original intervening grass/rock geometry and excluded fog/final retirement; source-copy preparation was outside each timed section. Dependent reads included attachment transition work.

| Captured real work | Original median | Guard median | Median within-pair saving | Faster / slower pairs |
| --- | ---: | ---: | ---: | ---: |
| Main terrain/explorer PBR | 7.668 ms | 7.602 ms | 0.393 ms | 7 / 3 |
| Actual settlement draw | 2.949 ms | 2.556 ms | 0.524 ms | 9 / 1 |
| Combined geometry, including intervening grass/rocks | 13.763 ms | 12.780 ms | 0.983 ms | 9 / 1 |

The within-pair saving is the median of each matched original-minus-guard observation, not the difference between separate medians. All three outputs matched **1,099,776 HDR pixels and all 4,399,104 depth samples** bit for bit. No HDR values were nonfinite; the combined output had 3,581,621 covered depth samples. This confirms an approximately one-millisecond GPU benefit for this captured geometry subset, while leaving whole-app cadence and the 60 FPS floor unresolved.

After this matched-command proof, the guard was provisionally retained in optional Shadows source pending the final consuming-app byte check. The applied source omits one blank WGSL line from the private prototype, giving **20,181 raw / 6,622 gzip → 20,321 raw / 6,659 gzip**, or **+140 raw / +37 gzip**. It is not byte-neutral. Core/stage remains 19,975 gzip and was not modified by this work. The baseline virtual bundle hash is `304d8b7445866d0e6fc8aaebf607e65da3412792f12f45715903477fce2199f6`; the applied bundle hash is `1b62b420aa4fce6ca0fb773b448b2b5bdd9f5631378375afcf8dce17fe1738fd`. The helper is at `packages/shadows/src/shader.ts:47`; the receiver replacements are at `packages/shadows/src/index.ts:55` and `:56`. The production package builds and all seven focused tests pass, including exact Float32 tap constants, receiver bindings/caching, lifecycle and the public visibility signature. No generated Float32 offset serialization change was used as bundle recovery.

Raw evidence includes `pcss-zero-direct-microbench-{1,4}.json`, `afterlight-final-native-depth-lit-lit.json`, `afterlight-final-native-shadow-lit-profile.json`, `afterlight-final-native-shadow-lit-actual-replay.json`, the earlier `optional-depth-lit-byte-estimates-shadows.json` prototype estimate and the final `planet-shadow-committed-byte-check.json` applied-source estimate. Two fixture repairs are preserved: the first combined capture accidentally included final retirement, making its depth result trivial; the revised fixture initially called `getMappedRange` twice on overlapping bytes. Final proof excludes retirement, checks covered depth, and uses two typed views of one returned ArrayBuffer.

## Rejected removal of the final private HDR depth retirement attachment

Source tracing found that the shared final resolve copies both 1× max-depth and every outer depth sample before attaching the private HDR depth only to load/discard it. The descriptor-only candidate omitted that final private attachment and retained both depth-copy shaders, formats, precision and samples. No production code was changed.

An actual 4× native-resolve fixture matched all 1,048,576 HDR pixels, all 4,194,304 outer depth samples and resolved max-depth, including partial coverage, clear background and values above one. Both full dependent span medians were **0.983 ms**, with four candidate wins, four losses and two ties. It failed to establish a useful GPU gain, so no further native FPS run was justified. Write-false estimates reduced Post/TAA by 27 gzip bytes and Water/Tonemap by 26 each; those hypothetical byte savings were not retained or used to offset the Shadows guard.

Evidence is `msaa-final-depth-retirement-microbench.json` and `optional-depth-lit-byte-estimates.json`. All experiment browsers, devices and servers were closed before hardware release.

## Temporary desktop 4× / 1× scene sampling diagnostic

The retained staged-startup build was tested separately at 10:01–10:06 UTC. Its immutable snapshot is `test-results/site-retained-streaming-20261013T095448496Z`. The entry `index-CHJHdspM.js` is 285,869 raw bytes, SHA-256 `e4ae61ab290913ab95d40dc0a9a8391a3d6af4696c6bbc0c070137d8bfb60484`; this later build includes the retained shadow guard and single particle-state buffer.

An ignored browser route override changes only the existing scene-sample helper and fixes the engine DPR cap at 1 in **both** paths. Exactly one helper and one DPR expression match. The overridden entry hash is `a1b5a90869f3d303d834c51fe928ebc87ab3d6367b88cf2471c40380040c1ac2`. Holding DPR at 1 in both modes avoids accidentally increasing the pixel count when the default sample-dependent cap changes. No production Core, package or quality default changes.

Conditions: headed Edge 154.0.4258.62, nonfallback Intel `xe-2lpg`, native viewport/backing buffer 1,432 × 768, browser DPR 2 and engine DPR 1. Desktop user agent, 73,728 terrain triangles, 110,000 grass candidates, water resolution 256, four 1,024² shadow cascades and selected particle capacity retain desktop settings. Sampling changes use a real device reboot and retirement of the previous device. Each tier runs sequential 4× → 1× → 1× → 4× windows, warmed for 3.5 seconds. Ordinary cadence measures six seconds; the separate opt-in pooled profile measures eight. Every foreground observation is visible and focused. Existing external browser workloads remain open.

### Default cadence and camera-confounded Off comparison

| Particles | Window | Samples | Mean FPS | Lowest one-second FPS | p95 / p99 interval | Maximum interval |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Off | A1 | 4 | 48.55 | 20.91 | 20.00 / 51.70 ms | 663.00 ms |
| Off | B1 | 1 | 60.03 | 59.79 | 17.70 / 18.30 ms | 18.50 ms |
| Off | B2 | 1 | 59.27 | 55.93 | 18.30 / 25.20 ms | 29.90 ms |
| Off | A2 | 4 | 54.69 | 52.90 | 24.00 / 25.50 ms | 53.10 ms |
| 1,000,000 | A1 | 4 | 55.48 | 54.82 | 33.50 / 34.60 ms | 35.10 ms |
| 1,000,000 | B1 | 1 | 59.91 | 58.99 | 17.40 / 18.90 ms | 34.00 ms |
| 1,000,000 | B2 | 1 | 54.23 | 46.68 | 33.60 / 34.40 ms | 34.70 ms |
| 1,000,000 | A2 | 4 | 44.46 | 42.93 | 28.00 / 29.00 ms | 31.20 ms |

Off B1's camera moved from `[-12, 5.6195493, 50.7738113]` to `[-24.2413712, 5.4812131, 42.3081131]`. Off B2 starts at a different camera, `[-18.5084209, 6.1136031, 49.0263557]`, and changes slightly during measurement. Its observed counterbalanced means, 51.62 → 59.65 FPS, are therefore **camera-confounded and do not establish the sampling gain**. The external-input cause was not recorded. These observations remain in the experiment history. A corrected private harness suppresses trusted pointer/key input and asserts camera equality; it has not yet run.

All four 1M cadence cameras match. Their counterbalanced means are 49.97 → 57.07 FPS, but original 4× also falls from 55.48 to 44.46 FPS over the experiment. The 1× path still has a 46.68 FPS one-second window and intervals above 33 ms. Neither tier proves the requested sustained floor. Default cadence creates no query sets or timing buffers and allocates no additional GPU buffers during these windows.

### Separate fixed-camera GPU profile

All eight profile windows preserve the exact camera position `[-12, 5.6195493, 50.7738113]`, target `[-12, 2.3131351, 37]`, and frozen solar time 17.599931666666535 hours. All eight expected windows finish with no reported page/GPU errors. The current device reuses one query set and two retained 2,048-byte buffers; every measurement window creates zero query sets or GPU buffers.

| Particles | Window | Samples | Complete GPU samples | Pass count | Median pass sum | Median full span | Median per-sample span-minus-sum | Profiled FPS |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Off | A1 | 4 | 33 | 27 | 9.044 ms | 12.583 ms | 3.473 ms | 60.06 |
| Off | B1 | 1 | 32 | 21 | 6.750 ms | 10.224 ms | 3.473 ms | 60.02 |
| Off | B2 | 1 | 33 | 21 | 7.143 ms | 10.682 ms | 3.473 ms | 60.01 |
| Off | A2 | 4 | 34 | 27 | 9.306 ms | 12.845 ms | 3.539 ms | 59.95 |
| 1,000,000 | A1 | 4 | 33 | 29 | 12.780 ms | 15.860 ms | 3.080 ms | 60.05 |
| 1,000,000 | B1 | 1 | 32 | 23 | 9.175 ms | 11.534 ms | 2.425 ms | 60.02 |
| 1,000,000 | B2 | 1 | 32 | 23 | 9.110 ms | 11.534 ms | 2.425 ms | 60.08 |
| 1,000,000 | A2 | 4 | 29 | 29 | 14.418 ms | 17.695 ms | 3.408 ms | 52.76 |

Arithmetic means of the two window medians are full-span **Off 12.714 → 10.453 ms** and **1M 16.777 → 11.534 ms**. These are counterbalanced whole-path observations, not isolated resolve costs. The gap column aggregates each sample's actual gap, rather than subtracting independent medians. Timestamps are quantized in approximately 0.065536 ms increments.

Pass identities follow captured real shader/pipeline metadata; indices change when 1× removes copy/resolve work. Main terrain/explorer, settlement, grass/fieldstones, particle compute/draw, water surface and AgX shader hashes each match between sample modes. Fog changes to the existing single-sample depth variant. Each table cell lists both chronological window medians.

| Actual GPU work | Off 4× A1 / A2 | Off 1× B1 / B2 | 1M 4× A1 / A2 | 1M 1× B1 / B2 |
| --- | --- | --- | --- | --- |
| Main terrain/explorer PBR | 3.342 / 3.408 ms | 2.294 / 2.425 ms | 3.342 / 3.342 ms | 1.901 / 1.769 ms |
| Fixed settlement PBR | 1.114 / 1.114 ms | 1.376 / 1.442 ms | 1.114 / 1.180 ms | 1.114 / 1.049 ms |
| Grass PBR | 0.721 / 0.721 ms | 0.393 / 0.459 ms | 0.721 / 0.721 ms | 0.328 / 0.328 ms |
| Fieldstone PBR | 0.262 / 0.262 ms | 0.262 / 0.262 ms | 0.262 / 0.262 ms | 0.197 / 0.197 ms |
| Exact depth-aware fog | 0.852 / 0.852 ms | 0.131 / 0.131 ms | 0.721 / 0.786 ms | 0.131 / 0.131 ms |
| Water surface | 0.590 / 0.590 ms | 0.590 / 0.590 ms | 0.524 / 0.655 ms | 0.459 / 0.459 ms |
| Main particle simulation | Absent | Absent | 2.228 / 2.490 ms | 1.311 / 1.311 ms |
| Main particle draw | Absent | Absent | 1.835 / 1.901 ms | 2.359 / 2.359 ms |
| Final AgX | 0.197 / 0.197 ms | 0.262 / 0.262 ms | 0.131 / 0.197 ms | 0.197 / 0.197 ms |

The unchanged particle compute shader becomes faster although its dispatch does not use multisampling; the 1× particle draw and Off settlement draw become slower. Cache/resource/clock/population-state effects therefore remain in these observations; this is not pure fragment sample scaling. The latest 4× Off profile already reaches about 60 Hz despite earlier unprofiled 4× results. This does not prove physical bandwidth alone causes the live slowdown or an immutable hardware ceiling. It does identify a material cost associated with the multisample scene path and attachments.

### Population, resources and quality limits

Every 1M profile window reads the actual indirect buffer **outside** timing: `[6, 1000000, 0, 0, 0]`. One million live billboards are submitted in both modes. Normal particle evolution stays active; identical particle ages/positions across device-reboot windows are not claimed.

Live texture descriptor storage estimates fall **227,381,264 → 91,009,040 bytes**, or 136,372,224 bytes fewer (approximately 130.05 MiB), and 31 → 28 textures. This nominal format/sample estimate assumes eight bytes for `depth32float-stencil8`; it is not physical VRAM or a measured bandwidth rate. Declared buffer storage is unchanged between modes: 19,563,872 bytes Off, 87,564,148 bytes at 1M. Profiling adds only two 2,048-byte buffers. After every reboot, zero audited texture/buffer objects from retired devices remain undestroyed. Actual current beauty pipelines/scene targets use the requested sample count, including rebuilt bloom, water and fog.

The prepared three-view 4×/1× still comparison has **not run**. Changed edge/depth sampling is not bit-exact parity. This diagnostic is therefore unaccepted as a permanent quality default. Core/Stage remains unchanged at 19,975 gzip bytes. Corrected cadence, stills, longer clock-stable runs, cold principal-view startup and physical Android remain outstanding.

The largest retained 4× beauty pass is Main PBR, about 3.37 ms here. At 1× with 1M, the largest pass is the real billboard draw, 2.36 ms. A narrow optional-VFX experiment can collapse only quads conservatively proven wholly behind the eye while retaining the existing live-ID list, public indirect count and every visible shader operation. Its prepared candidate is larger and unmeasured: same-queue HDR/depth parity, extreme/crossing-plane cases, ordinary full-compaction timing and consumer-byte acceptance are required. Moving settlement ahead of terrain is another unmeasured captured-command experiment; merely changing graph order is invalid because Main clears color/depth. Exact clear transfer and output equality are required, with no production Core change.

Local reproduction: `node test-results/afterlight-retained-sampling-ab.mjs cadence`, then a separate `profile` invocation. The harness contains this host's bundled Playwright import and immutable snapshot path; portable inputs, conditions, measurements and limitations are recorded above. Raw cadence SHA-256: `539556f70f6bdabe34385cb261fc36cb9ed499e936288b155a5188b26078523f`; raw profile: `25b75f3ff6e4727945f48604ae49b70440e85512b2418b31b7de19713db4615d`. Corrected runs must write distinct reports and preserve these originals.

### Corrected input-isolated cadence — 11:48–11:49 UTC

`node test-results/afterlight-retained-sampling-fixed-camera-ab.mjs cadence` subsequently passes all eight windows. Its init script suppresses trusted pointer/key/wheel input before application listeners. Every one-second observation, each window's start/end and every window across both tiers have the exact camera and orbit listed above. No input events actually needed suppression in this run. This repeats the same immutable retained build, **before** the subsequent first-reflection startup change; that later change must receive its own load proof. No additional full GPU profile was run.

| Particles | Window | Samples | Mean FPS | Lowest one-second FPS | p95 / p99 interval | Maximum interval | Intervals above 33.333 ms |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| Off | A1 | 4 | 57.40 | 53.00 | 19.30 / 33.70 ms | 34.40 ms | 9 |
| Off | B1 | 1 | 60.08 | 59.22 | 17.50 / 18.00 ms | 19.10 ms | 0 |
| Off | B2 | 1 | 59.99 | 59.62 | 17.50 / 18.00 ms | 18.10 ms | 0 |
| Off | A2 | 4 | 52.68 | 45.86 | 33.60 / 34.90 ms | 56.00 ms | 21 |
| 1,000,000 | A1 | 4 | 55.94 | 49.41 | 33.20 / 34.30 ms | 35.00 ms | 13 |
| 1,000,000 | B1 | 1 | 59.94 | 59.35 | 17.20 / 17.90 ms | 18.10 ms | 0 |
| 1,000,000 | B2 | 1 | 60.05 | 59.42 | 17.20 / 17.50 ms | 17.70 ms | 0 |
| 1,000,000 | A2 | 4 | 59.04 | 57.81 | 18.20 / 34.10 ms | 34.40 ms | 5 |

Counterbalanced means: **Off 55.04 → 60.04 FPS** and **1M 57.49 → 60.00 FPS**. All four 1× windows are close to a 60 Hz presentation cadence, with no >33.333 ms intervals and substantially tighter tails than the corresponding 4× windows. The exact-camera correction makes this evidence stronger than the prior Off comparison. Original-path drift still remains, in opposite directions for the two particle tiers, so these finite six-second windows do not establish an immutable bandwidth ceiling or long-duration/device-independent guarantee. Sub-60 one-second values include finite-window accounting around a ~60 Hz loop; the observed p95/p99/max intervals are retained rather than rounding away pacing variation.

All default query/timing resources remain zero. Every timed window has zero GPU-buffer/query allocations, zero reported page/GPU errors and zero undestroyed retired-device textures/buffers. All contexts, devices, browser and preview server close successfully, exit code 0. The distinct corrected raw report is `test-results/afterlight-retained-sampling-fixed-camera-cadence.json`, SHA-256 `3237a13e0c41884f91fde65219bda557d7b8ca1f07224e6e47ad3c5dcc19fdb1`. This supports continuing package-level sample-path attribution; AA quality, longer runs, physical Android and the overall load/size acceptance remain unproven. No default-quality change is retained.
