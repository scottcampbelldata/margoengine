// Synthetic star test page: Deep-Sky Galactic Survey & Multi-Modal Analytics Dashboard.
// Built cleanly on @margoengine/sciviz: million-star 3D point cloud with Eye-Dome Lighting (EDL),
// spatial lasso cross-filtering, 2D Freedman-Diaconis distribution histograms,
// date-and-log scale photometric time series, and OKLab Hertzsprung-Russell heatmaps.
import { Figure, type ScatterLayer } from '@margoengine/sciviz';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas3d = $<HTMLCanvasElement>('canvas3d');
const canvasHist = $<HTMLCanvasElement>('canvasHist');
const canvasHeatmap = $<HTMLCanvasElement>('canvasHeatmap');
const canvasCurve = $<HTMLCanvasElement>('canvasCurve');
const status = $<HTMLParagraphElement>('status');

// HUD
const hudTotalStars = $<HTMLDivElement>('hudTotalStars');
const hudSelectedStars = $<HTMLDivElement>('hudSelectedStars');
const hudVelocityDisp = $<HTMLDivElement>('hudVelocityDisp');
const hudHoverInfo = $<HTMLDivElement>('hudHoverInfo');

// Galactic Star Catalog in memory
interface Catalog {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vr: Float32Array; // Radial Doppler velocity (km/s)
  colorIndex: Float32Array; // B - V color index (mag)
  count: number;
}

let catalog: Catalog | undefined;
let fig3d: Figure | undefined;
let figHist: Figure | undefined;
let figHeatmap: Figure | undefined;
let figCurve: Figure | undefined;
let scatterLayer: ScatterLayer | undefined;
let colorbar3d: ReturnType<Figure['colorbar']> | undefined;

// Deterministic fast PRNG (xorshift32)
function createRng(seed = 1337) {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

// Generate realistic spiral galaxy population
function generateGalaxyCatalog(count = 1_200_000): Catalog {
  const rng = createRng(202611);
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  const z = new Float32Array(count);
  const vr = new Float32Array(count);
  const colorIndex = new Float32Array(count);

  const bulgeFraction = 0.28;
  const bulgeCount = Math.floor(count * bulgeFraction);

  // 1. Central Bulge (high-velocity dispersion spheroid, de Vaucouleurs-like)
  for (let i = 0; i < bulgeCount; i++) {
    const u1 = rng();
    const u2 = rng();
    const u3 = rng();
    const rBulge = 2.4 * Math.pow(-Math.log(Math.max(1e-6, u1)), 0.65);
    const theta = u2 * 2 * Math.PI;
    const phi = Math.acos(2 * u3 - 1);

    const xi = rBulge * Math.sin(phi) * Math.cos(theta);
    const yi = rBulge * Math.sin(phi) * Math.sin(theta);
    const zi = rBulge * Math.cos(phi) * 0.75; // Spheroid oblateness

    x[i] = xi;
    y[i] = yi;
    z[i] = zi;

    // High velocity dispersion, isotropic Gaussian
    const g1 = Math.sqrt(-2 * Math.log(Math.max(1e-6, rng()))) * Math.cos(2 * Math.PI * rng());
    vr[i] = g1 * 115; // km/s dispersion

    // Older, redder stellar population (K, M giants)
    colorIndex[i] = 0.8 + 0.6 * rng();
  }

  // 2. Disk & Logarithmic Spiral Arms
  const armPitch = 0.22;
  const numArms = 2;

  for (let i = bulgeCount; i < count; i++) {
    const armIdx = i % numArms;
    const armOffset = (armIdx * 2 * Math.PI) / numArms;

    // Exponential disk radial distribution
    const r = 2.5 + 14 * Math.sqrt(rng());
    const spiralAngle = Math.log(r / 2.5) / armPitch + armOffset;

    // Dispersion around the arm ridge
    const armSpread = 0.7 * (1 + r / 15);
    const dTheta = (rng() - 0.5) * armSpread;
    const finalAngle = spiralAngle + dTheta;

    const xi = r * Math.cos(finalAngle);
    const yi = r * Math.sin(finalAngle);
    // Thin disk scale height
    const scaleHeight = 0.35 * Math.exp(r / 20);
    const zi = (rng() - 0.5 + rng() - 0.5) * scaleHeight;

    x[i] = xi;
    y[i] = yi;
    z[i] = zi;

    // Flat rotation curve v_rot ≈ 220 km/s with velocity dispersion
    const vRot = 220;
    const vRotX = -vRot * Math.sin(finalAngle);
    const vRotY = vRot * Math.cos(finalAngle);
    const disp = (rng() - 0.5) * 35;

    // Observer line-of-sight velocity (from (x=0, y=-8.2 kpc, z=0.02 kpc))
    const dx = xi;
    const dy = yi + 8.2;
    const dist = Math.sqrt(dx * dx + dy * dy);
    vr[i] = vRotX * (dx / dist) + vRotY * (dy / dist) + disp;

    // Disk stars: blue young OB associations in arms, yellow/white in interarm
    const isInArm = Math.abs(dTheta) < 0.25;
    colorIndex[i] = isInArm ? rng() * 0.4 - 0.1 : 0.3 + 0.7 * rng();
  }

  return { x, y, z, vr, colorIndex, count };
}

async function init() {
  try {
    status.textContent = 'Generating 1,200,000-star survey catalog…';
    catalog = generateGalaxyCatalog(1_200_000);

    // Initialize 3D Viewport
    status.textContent = 'Initializing 3D galaxy view with Eye-Dome Lighting…';
    fig3d = await Figure.create(canvas3d, {
      titles: { x: 'X (kpc)', y: 'Y (kpc)', z: 'Z (kpc)' },
      aspect: [1, 1, 0.4],
      pointBudget: 1_200_000,
      tooltips: true,
    });

    // Initialize 2D Charts
    status.textContent = 'Initializing 2D scientific analytics charts…';
    figHist = await Figure.create(canvasHist, {
      mode: '2d',
      titles: { x: 'Doppler Radial Velocity (km/s)', y: 'P(v)' },
      margin: { top: 12, right: 16, bottom: 36, left: 52 },
    });

    figHeatmap = await Figure.create(canvasHeatmap, {
      mode: '2d',
      titles: { x: 'B - V Color Index (mag)', y: 'Abs Magnitude M_v' },
      margin: { top: 12, right: 16, bottom: 36, left: 52 },
    });

    figCurve = await Figure.create(canvasCurve, {
      mode: '2d',
      scale: { x: 'date', y: 'log' },
      titles: { y: 'Flux (mJy)' },
      margin: { top: 12, right: 16, bottom: 36, left: 56 },
      legend: 'top-right',
    });

    await update3DLayer();
    await updateHistogram(null);
    await buildHeatmap();
    await buildLightCurve();

    setupEventListeners();
    status.textContent = 'Synthetic star test page ready.';
    canvas3d.dataset.ready = 'true';
  } catch (err) {
    status.textContent = `Initialization failed: ${(err as Error).message}`;
  }
}

// Runs one update at a time. A call made while one is running waits, and only the newest waiting call runs, so
// quick control changes never build two layers at once or leave a stray one behind.
function latestOnly<A extends unknown[]>(run: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let busy: Promise<void> | undefined;
  let next: A | undefined;
  return (...args) => {
    next = args;
    busy ??= (async () => {
      try {
        while (next) {
          const current = next;
          next = undefined;
          await run(...current);
        }
      } finally {
        busy = undefined;
      }
    })();
    return busy;
  };
}

const update3DLayer = latestOnly(build3DLayer);

async function build3DLayer() {
  if (!fig3d || !catalog) return;
  const colorBy = $<HTMLSelectElement>('colorBySelect').value;
  const isEdl = $<HTMLInputElement>('edlCheck').checked;

  // The old cloud and colour bar stay until the new cloud exists; removing them first showed an empty plot while
  // the 1.2 million points were uploaded.
  const oldScatter = scatterLayer;
  const oldColorbar = colorbar3d;

  const colorData = colorBy === 'temp' ? catalog.colorIndex : catalog.vr;
  const colormap = colorBy === 'temp' ? 'plasma' : 'coolwarm';
  const range: [number, number] = colorBy === 'temp' ? [-0.2, 1.4] : [-250, 250];

  scatterLayer = await fig3d.scatter(
    {
      x: catalog.x,
      y: catalog.y,
      z: catalog.z,
      color: colorData,
    },
    {
      colormap,
      range,
      size: 2.2,
      edl: isEdl,
      name: 'Stellar Cloud',
    },
  );

  if (oldScatter) scatterLayer = fig3d.replace(oldScatter, scatterLayer);
  oldColorbar?.dispose();
  colorbar3d = fig3d.colorbar(colormap, range, {
    label: colorBy === 'temp' ? 'B - V Color Index' : 'Doppler Velocity (km/s)',
  });

  hudTotalStars.textContent = `Catalog: ${catalog.count.toLocaleString('en')} stars`;
  await fig3d.ready();
}

let histLayer: ReturnType<Figure['histogram']> extends Promise<infer L> ? L : never;
const updateHistogram = latestOnly(buildHistogram);

async function buildHistogram(selectedIndices: ArrayLike<number> | null) {
  if (!figHist || !catalog) return;
  const oldHist = histLayer;

  const subset =
    selectedIndices && selectedIndices.length > 10
      ? Float32Array.from(selectedIndices, (idx) => catalog!.vr[idx])
      : catalog.vr.subarray(0, 100_000); // 100k sample for global histogram

  // Calculate mean and dispersion
  let sum = 0;
  for (let i = 0; i < subset.length; i++) sum += subset[i];
  const mean = sum / subset.length;
  let varSum = 0;
  for (let i = 0; i < subset.length; i++) varSum += (subset[i] - mean) ** 2;
  const sigma = Math.sqrt(varSum / subset.length);

  hudVelocityDisp.textContent = `Velocity Dispersion σ_v: ${sigma.toFixed(1)} km/s (Mean: ${mean.toFixed(1)} km/s)`;
  $<HTMLSpanElement>('histBadge').textContent = `N = ${subset.length.toLocaleString('en')}`;

  histLayer = await figHist.histogram(subset, {
    bins: 'auto',
    density: true,
    color: '#9c66ff',
    name: 'Doppler Velocity',
  });
  if (oldHist) histLayer = figHist.replace(oldHist, histLayer);

  await figHist.ready();
}

async function buildHeatmap() {
  if (!figHeatmap) return;
  // Hertzsprung-Russell Color-Magnitude Diagram Density Heatmap (48 x 32)
  const nx = 48;
  const ny = 32;
  const density = new Float32Array(nx * ny);

  // Synthesize stellar evolutionary branches:
  // 1. Main Sequence: diagonal from (hot, bright) to (cool, faint)
  for (let i = 0; i < 2400; i++) {
    const t = i / 2400;
    const bv = -0.2 + t * 1.6; // B - V in [-0.2, 1.4]
    const mv = -4 + t * 16 + (Math.random() - 0.5) * 1.2; // Abs magnitude
    const xi = Math.floor(((bv - -0.4) / 2.0) * nx);
    const yi = Math.floor(((mv - -6) / 22) * ny);
    if (xi >= 0 && xi < nx && yi >= 0 && yi < ny) {
      density[yi * nx + xi] += 1;
    }
  }

  // 2. Red Giant Branch: right side (cool, bright)
  for (let i = 0; i < 800; i++) {
    const bv = 0.8 + Math.random() * 0.6;
    const mv = -2 + Math.random() * 4;
    const xi = Math.floor(((bv - -0.4) / 2.0) * nx);
    const yi = Math.floor(((mv - -6) / 22) * ny);
    if (xi >= 0 && xi < nx && yi >= 0 && yi < ny) {
      density[yi * nx + xi] += 1.5;
    }
  }

  // 3. White Dwarfs: left side (hot, faint)
  for (let i = 0; i < 350; i++) {
    const bv = -0.1 + Math.random() * 0.4;
    const mv = 10 + Math.random() * 3.5;
    const xi = Math.floor(((bv - -0.4) / 2.0) * nx);
    const yi = Math.floor(((mv - -6) / 22) * ny);
    if (xi >= 0 && xi < nx && yi >= 0 && yi < ny) {
      density[yi * nx + xi] += 1.2;
    }
  }

  let maxD = 0;
  for (let k = 0; k < density.length; k++) if (density[k] > maxD) maxD = density[k];

  await figHeatmap.heatmap(density, {
    nx,
    ny,
    x: [-0.4, 1.6],
    y: [-6, 16],
    colormap: 'magma',
    range: [0, maxD],
  });

  figHeatmap.colorbar('magma', [0, maxD], { label: 'Star Count' });
  await figHeatmap.ready();
}

async function buildLightCurve() {
  if (!figCurve) return;
  // Cepheid Variable Photometric Time Series over 30 days
  const start = Date.UTC(2026, 9, 1);
  const daysCount = 60;
  const dates: number[] = [];
  const vFlux: number[] = [];
  const jFlux: number[] = [];

  const periodDays = 5.37; // Delta Cephei pulsation period

  for (let i = 0; i < daysCount; i++) {
    const t = start + i * 0.5 * 86_400_000;
    const phase = ((i * 0.5) % periodDays) / periodDays;

    // Asymmetric sawtooth pulsation light curve
    const pulseV = Math.exp(-3 * phase) * 2.2 + 0.3 * Math.sin(2 * Math.PI * phase) + 1.2;
    const pulseJ = Math.exp(-2.5 * phase) * 1.4 + 0.2 * Math.sin(2 * Math.PI * phase) + 2.0;

    dates.push(t);
    vFlux.push(pulseV * 45 + (Math.random() - 0.5) * 2);
    jFlux.push(pulseJ * 70 + (Math.random() - 0.5) * 2);
  }

  await figCurve.line({ x: dates, y: vFlux }, { color: '#ffd885', width: 2.2, name: 'V-Band (Optical)' });
  await figCurve.line({ x: dates, y: jFlux }, { color: '#64b5f6', width: 2.2, name: 'J-Band (Infrared)' });
  await figCurve.ready();
}

function setupEventListeners() {
  // Star count selector
  $('starCountSelect').addEventListener('change', async (e) => {
    const count = Number((e.target as HTMLSelectElement).value);
    status.textContent = `Regenerating catalog with ${count.toLocaleString('en')} stars…`;
    catalog = generateGalaxyCatalog(count);
    await update3DLayer();
    await updateHistogram(null);
    status.textContent = `Updated: ${count.toLocaleString('en')} stars active.`;
  });

  // Color by selector
  $('colorBySelect').addEventListener('change', () => {
    void update3DLayer();
  });

  // Drag mode: Orbit, Box, Lasso
  $('dragModeSelect').addEventListener('change', (e) => {
    const mode = (e.target as HTMLSelectElement).value as 'orbit' | 'box' | 'lasso';
    if (fig3d) {
      fig3d.dragMode = mode;
      const wrap = $('viewportWrap');
      if (mode !== 'orbit') {
        wrap.classList.add('selection-active');
        status.textContent = `Draw a ${mode} on the 3D galaxy to cross-filter stars into 2D Doppler histograms.`;
      } else {
        wrap.classList.remove('selection-active');
        status.textContent = 'Orbit camera mode active.';
      }
    }
  });

  // EDL toggle
  $('edlCheck').addEventListener('change', () => {
    void update3DLayer();
  });

  // Reset selection
  $('btnResetSelection').addEventListener('click', () => {
    hudSelectedStars.textContent = 'Selection: All Stars (Global Population)';
    void updateHistogram(null);
  });

  // Selection Event Listener
  if (fig3d) {
    fig3d.addEventListener('selection', (event) => {
      const detail = event.detail;
      if (!detail.points || detail.points.length === 0) return;
      const indices = detail.points[0].indices;
      hudSelectedStars.textContent = `Selection: ${indices.length.toLocaleString('en')} cluster stars`;
      void updateHistogram(indices);
    });

    // Hover Event Listener
    fig3d.addEventListener('hover', (event) => {
      const hit = event.detail;
      if (hit && catalog) {
        const idx = hit.index;
        const x = catalog.x[idx].toFixed(2);
        const y = catalog.y[idx].toFixed(2);
        const z = catalog.z[idx].toFixed(2);
        const vr = catalog.vr[idx].toFixed(1);
        const bv = catalog.colorIndex[idx].toFixed(2);
        hudHoverInfo.textContent = `Star #${idx}: pos=(${x}, ${y}, ${z}) kpc | v_r=${vr} km/s | B-V=${bv}`;
      } else {
        hudHoverInfo.textContent = 'Hover: Inspect celestial body';
      }
    });
  }

  // Export 3D snapshot
  $('btnExport3D').addEventListener('click', async () => {
    if (!fig3d) return;
    status.textContent = 'Exporting 3D astronomical snapshot…';
    try {
      const blob = await fig3d.toPNG();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `astrometrics-galaxy-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      status.textContent = 'Snapshot saved.';
    } catch (err) {
      status.textContent = `Export failed: ${(err as Error).message}`;
    }
  });

  window.addEventListener(
    'pagehide',
    () => {
      fig3d?.dispose();
      figHist?.dispose();
      figHeatmap?.dispose();
      figCurve?.dispose();
    },
    { once: true },
  );
}

init();

export { fig3d, figHist, figHeatmap, figCurve, update3DLayer, updateHistogram };
