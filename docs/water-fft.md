# Batch 234: spectral ocean

Scope: job 1, optional `@margoengine/water/fft`. No core or stage source changes.
The previous water root exported `Water` and its Gerstner/terrain-coupling types
only; no FFT entry existed. The new entry is not imported by that root.

## Research and synthesis

Research preceded implementation. Compared the spectral height/displacement
construction in Jerry Tessendorf, *Simulating Ocean Water*, SIGGRAPH course
notes 1999-2004 (2004 revision), sections 4.3-4.6, equations 36-45,
<https://people.cs.clemson.edu/~jtessen/reports/papers_files/coursenotes2004.pdf>,
with Klaus Hasselmann et al., *Measurements of Wind-Wave Growth and Swell Decay
during the Joint North Sea Wave Project (JONSWAP)*, 1973, section 2.4,
<https://airsea.ucsd.edu/wp-content/uploads/sites/10/2019/10/Jonswap-Hasselmann1973.pdf>,
and James W. Cooley and John W. Tukey, *An Algorithm for the Machine Calculation
of Complex Fourier Series*, 1965,
<https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Cooley65.pdf>.
The JONSWAP appendix B equations B3-B7 of Okey G. Nwogu and Zeki Demirbilek,
*BOUSS-2D: A Boussinesq Wave Model for Coastal Regions and Harbors*, 2001,
<https://coastalhydraulicslaboratoryfact.tpub.com/BOUSS-2D/BOUSS-2D0082.htm>,
cross-check the peak/fetch relations. The review also located Christopher J.
Horvath, *Empirical Directional Wave Spectra for Computer Graphics*, 2015,
<https://doi.org/10.1145/2791261.2791267>; its full text was unavailable and no
equation is attributed to it. No companion code or rival implementation was read.

Synthesis: GPU Gaussian h0, Tessendorf conjugate-pair time evolution and
deep-water dispersion; Phillips density or JONSWAP converted from d(omega)
to d(kx)d(kz), with a cos-squared angular density. Disjoint wavelength bands
avoid duplicate energy. Each retained field gets a separable unnormalised
inverse FFT; the seed coefficients already include the frequency-cell area.
Central periodic displacement derivatives give tangent normals and the horizontal
Jacobian, with exponential foam history. All six displacement/velocity components
come from the same evolving spectrum. This is a statistical linear ocean with
choppy mapping, not a nonlinear hydrodynamic solver.

W3C GPU for the Web Working Group, *WebGPU Shading Language*, 2026,
<https://www.w3.org/TR/WGSL/>, supplies the host-shareable layout, resource
interface and reserved identifiers. Initial compilation caught a reserved buffer
identifier; the physical browser test compiles every entry point as its regression.

Before correcting CPU snapshot metadata, compared David Goldberg, *What Every
Computer Scientist Should Know About Floating-Point Arithmetic*, 1991, the
representation and ulp discussion in the authorized reprint at
<https://docs.oracle.com/cd/E19957-01/806-3568/ncg_goldberg.html>, with WGSL's
binary32/host-shareable rules. Returning the authored binary64 height 100000.1
reported 1.5625 mm below the actual binary32 draw height. Snapshot height, patch
lengths and evaluated time now expose the exact uploaded binary32 values.
The strict metadata regression fails on the previous implementation, and the
physical readback checks these nonexact decimal inputs on both backends.

## Parity contract

The scoped rival row is GPU FFT spectrum, choppy displacement, cascades and
Jacobian foam, not the entire water/rendering suite. Public black-box reference
pages inspected: Babylon.js *Ocean demo in WebGPU*,
<https://popov72.github.io/OceanDemo/>, and Babylon.js *Lite Ocean*,
<https://www.babylonjs.com/lite-demos/demo-ocean.html>. The latter advertises three
cascades, spectrum evolution, a multistage 2D inverse FFT and merge. No scripts
or source were inspected. The running original Babylon ocean was captured
externally on the same RTX A6000/Edge 157 and inspected beside Margo's captures.
Its visible UI exposes resolution, horizontal lambda, wind, fetch and peak
enhancement and its surface shows long swell with short ripples. Margo demonstrates
the same scoped spectral features with an independent numerical oracle, plus
the requested Phillips alternative. This is a behaviour comparison, not a claim
of pixel identity between differently configured shaders. Rival sky, buoy model,
clipmap, secondary swell controls and terrain contact foam are outside this
specific FFT-spectrum row; those assets were not copied into Margo. Numerical
comparisons use the published equations directly. The private lane retains the
external screenshot/UI record in `test-results/batch234/rival-ocean.*`.

## Evidence and reproduction

`packages/water/test/fft-reference.js` independently performs a direct Fourier
sum, not the production butterfly algorithm. The physical GPU test compares all
three displacements and all three analytic time derivatives at every point,
for both spectra, two times and two disjoint cascades on a 16x16 grid. Absolute
error must be below 0.001 m or m/s; unit-normal error below 0.00001. It also checks
zero energy, deterministic paused frames, movement, backwards seeking,
device restoration and abort-before-read, under WebGPU validation scopes.
The Jacobian and every normal component are independently checked against the
direct-sum displacement derivatives. A stronger sea produces 208 negative
folding determinants; 29 cells retain foam after their compression has moved,
with history-formula error below 0.00000004 on both backends.

Physical evidence: NVIDIA RTX A6000, Edge 157, native WebGPU and the full
WebGL2 compatibility layer. All 6 components x 512 points x 2 spectra x 2
times pass; worst absolute errors are 0.000001946 native and 0.000001811 compat.
Both backends pass exact calm-state, paused-state and restoration comparisons.
Native WGSL compilation records 5 modules and no errors. Retained JSON results:
[WebGPU](whitepaper/results/batch234-water-fft-webgpu.json),
[compatibility](whitepaper/results/batch234-water-fft-compat.json).

Run after package builds (one shared slot per command):

```sh
node scripts/gpu-lock.mjs run --owner=codex-batch234 --wait-max=60 --max=3 -- node packages/water/test/fft.browser.mjs
node scripts/gpu-lock.mjs run --owner=codex-batch234 --wait-max=60 --max=3 -- node packages/water/test/fft.browser.mjs --compat
```

The 3 minute run limit excludes the queue wait. JSON and PNG results go to the
lane's `test-results/water-fft-*`. Test/demo wind comes from NOAA NDBC buoy
46042, 2023-01-01 00:00 UTC, 17.2 m/s from 314 degrees; the retained record and
public-domain attribution accompany the test. Fetch is authored, not measured.
No benchmark, speed-only assertion or exclusive GPU reservation is used.

## Sizes and limits

The optional entry grows from absent (0 B) to 7,334 B minified gzip; its new
7,590 B ceiling includes the standard 256 B headroom. The transform, derivatives
and draw share one lifecycle and field layout; splitting them would add setup
coordination and make the feature harder to use. No functionality is removed
for size. Core + stage measured 23,924 B both before and after the full rebuilt gate.
One Fourier frame uses `resolution² * cascades * 160` GPU buffer bytes, plus
uniforms, FFT stage constants and grid indices; explicitly requested readback
adds 48 bytes per point while pending. No persistent CPU transform runs.
All public options and defaults are in the package README and typed API.

## Landing checks

`npm run lint`, `npm run hygiene` and the complete `npm run verify` pass
(13,779 tests, zero failures or skips). Water's 33 unit tests pass. The six
existing water GPU scripts pass on both WebGPU and full WebGL2 compatibility
(12 runs), as does the new FFT script on each backend. All five water README
examples and all three umbrella README examples run successfully. API reports,
umbrella aliases, generated notices and LLM documentation are current. No test,
tolerance or timing budget was relaxed. Initial gate failures identified a
missing help anchor, extra claim title and stale generated alias/notice/doc
outputs; all were corrected in their owning inputs and the full gate then
passed. No speed run was made.

The full verify above is the pre-rebase feature checkpoint. Landing rebases
preserve both lanes' shared documentation and regenerate the API aggregate,
umbrella aliases, notices and LLM corpus. After the compatibility-layer rebase,
both FFT backends, all 12 existing water GPU runs, 33 water unit tests, all
8 README examples and the 41 focused integration tests pass again; sizes stay
7,334 B and 23,924 B. The subsequent main changes affect voxel-pathtracer and
compute registration; their declarations/umbrella are rebuilt before regeneration.
