// Synthetic wind test page: Geophysical Vortex & Fluid Dynamics Observatory.
// Built cleanly on @margoengine/sciviz: 4th-order Runge-Kutta streamlines, 3D quiver vector fields,
// isobaric height fields with contours, and spatiotemporal timeline playback.
import { Figure, type ColormapName, type LineLayer, type SurfaceLayer } from '@margoengine/sciviz';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('viewport');
const status = $<HTMLParagraphElement>('status');

// HUD
const hudModelInfo = $<HTMLDivElement>('hudModelInfo');
const hudStreamlinesInfo = $<HTMLDivElement>('hudStreamlinesInfo');
const hudVelocityRange = $<HTMLDivElement>('hudVelocityRange');
const hudPressureInfo = $<HTMLDivElement>('hudPressureInfo');
const hudTimeInfo = $<HTMLDivElement>('hudTimeInfo');

// Grid configuration
const NX = 24;
const NY = 24;
const NZ = 16;
const BOUNDS: [number, number, number, number, number, number] = [-10, 10, -10, 10, 0, 8];

// Surface configuration
const SURF_NX = 64;
const SURF_NY = 64;

interface FieldResult {
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  speedMax: number;
  quiver: { x: number[]; y: number[]; z: number[]; u: number[]; v: number[]; w: number[] };
  surfaceHeights: Float32Array;
  coreDepression: number;
}

// Compute atmospheric/geophysical fluid vector field at time t
function computeVectorField(model: string, t: number): FieldResult {
  const total = NX * NY * NZ;
  const u = new Float32Array(total);
  const v = new Float32Array(total);
  const w = new Float32Array(total);

  const qx: number[] = [];
  const qy: number[] = [];
  const qz: number[] = [];
  const qu: number[] = [];
  const qv: number[] = [];
  const qw: number[] = [];

  let speedMax = 0;

  // Meander coordinates for time t
  const cx = 1.2 * Math.sin(0.8 * t);
  const cy = 0.8 * Math.cos(0.6 * t);

  for (let k = 0; k < NZ; k++) {
    const z = BOUNDS[4] + (k / (NZ - 1)) * (BOUNDS[5] - BOUNDS[4]);
    for (let j = 0; j < NY; j++) {
      const y = BOUNDS[2] + (j / (NY - 1)) * (BOUNDS[3] - BOUNDS[2]);
      for (let i = 0; i < NX; i++) {
        const x = BOUNDS[0] + (i / (NX - 1)) * (BOUNDS[1] - BOUNDS[0]);
        const idx = k * NX * NY + j * NX + i;

        let ui = 0;
        let vi = 0;
        let wi = 0;

        if (model === 'tornado') {
          // Atmospheric Mesocyclone / Tornado Vortex
          const rx = x - cx;
          const ry = y - cy;
          const r = Math.sqrt(rx * rx + ry * ry);
          const theta = Math.atan2(ry, rx);

          // Modified Burgers-Rott vortex:
          // Tangential swirl: rises linearly in core, decays as 1/r outside
          const coreRadius = 2.2;
          const gamma = 75; // Circulation strength
          const vTheta = (gamma * r) / (r * r + coreRadius * coreRadius);

          // Inward radial convergence in low altitude boundary layer
          const uRadial = -12 * (r / 10) * Math.exp(-z / 2.0);

          // Strong central vertical updraft
          const wUpdraft = 45 * Math.exp(-(r * r) / (3.2 * 3.2)) * (1 - Math.exp(-z / 1.5));

          // Ambient environmental shear wind along x
          const uShear = 6 * Math.log(1 + z / 0.5);

          ui = -vTheta * Math.sin(theta) + uRadial * Math.cos(theta) + uShear;
          vi = vTheta * Math.cos(theta) + uRadial * Math.sin(theta);
          wi = wUpdraft;
        } else if (model === 'karman') {
          // von Kármán vortex street: periodic alternate shedding downstream of cylinder at x=-6
          const baseFlow = 20;
          ui = baseFlow;
          vi = 0;
          wi = 2 * Math.sin((x - t * 4) * 0.5) * Math.exp(-z / 3);

          // Alternating vortices
          for (let s = -2; s <= 2; s++) {
            // Upper vortex row (counter-clockwise)
            const xv1 = s * 6 + ((t * 3) % 6) - 4;
            const yv1 = 2.2;
            const r1sq = (x - xv1) ** 2 + (y - yv1) ** 2;
            const swirl1 = 30 * Math.exp(-r1sq / 3.0);
            ui += -swirl1 * ((y - yv1) / (Math.sqrt(r1sq) + 0.5));
            vi += swirl1 * ((x - xv1) / (Math.sqrt(r1sq) + 0.5));

            // Lower vortex row (clockwise)
            const xv2 = s * 6 + 3 + ((t * 3) % 6) - 4;
            const yv2 = -2.2;
            const r2sq = (x - xv2) ** 2 + (y - yv2) ** 2;
            const swirl2 = -30 * Math.exp(-r2sq / 3.0);
            ui += -swirl2 * ((y - yv2) / (Math.sqrt(r2sq) + 0.5));
            vi += swirl2 * ((x - xv2) / (Math.sqrt(r2sq) + 0.5));
          }
        } else {
          // Dipole eddy pair (cyclone and anticyclone)
          const d = 3.5;
          const r1sq = (x - cx) ** 2 + (y - cy - d / 2) ** 2;
          const r2sq = (x - cx) ** 2 + (y - cy + d / 2) ** 2;
          const swirl1 = 40 * Math.exp(-r1sq / 4.0);
          const swirl2 = -40 * Math.exp(-r2sq / 4.0);

          ui = -swirl1 * (y - cy - d / 2) - swirl2 * (y - cy + d / 2);
          vi = swirl1 * (x - cx) + swirl2 * (x - cx);
          wi = 10 * (Math.exp(-r1sq / 4.0) - Math.exp(-r2sq / 4.0)) * Math.sin((z / 8) * Math.PI);
        }

        u[idx] = ui;
        v[idx] = vi;
        w[idx] = wi;

        const spd = Math.sqrt(ui * ui + vi * vi + wi * wi);
        if (spd > speedMax) speedMax = spd;

        // Sample quiver on every second cell
        if (i % 2 === 0 && j % 2 === 0 && k % 2 === 0) {
          qx.push(x);
          qy.push(y);
          qz.push(z);
          qu.push(ui);
          qv.push(vi);
          qw.push(wi);
        }
      }
    }
  }

  // Compute surface height field with pressure depression
  const surfaceHeights = new Float32Array(SURF_NX * SURF_NY);
  let coreDepression = 0;

  for (let j = 0; j < SURF_NY; j++) {
    const y = BOUNDS[2] + (j / (SURF_NY - 1)) * (BOUNDS[3] - BOUNDS[2]);
    for (let i = 0; i < SURF_NX; i++) {
      const x = BOUNDS[0] + (i / (SURF_NX - 1)) * (BOUNDS[1] - BOUNDS[0]);
      const rsq = (x - cx) ** 2 + (y - cy) ** 2;

      // Pressure depression at eye: cyclostrophic balance Δp ~ -rho * vTheta^2
      const depression = -2.8 / (1 + rsq / 4.5);
      // Gentle terrain topography
      const terrain = 0.4 * Math.sin(x / 3) * Math.cos(y / 3);

      const val = depression + terrain;
      surfaceHeights[j * SURF_NX + i] = val;
      if (depression < coreDepression) coreDepression = depression;
    }
  }

  return {
    u,
    v,
    w,
    speedMax,
    quiver: { x: qx, y: qy, z: qz, u: qu, v: qv, w: qw },
    surfaceHeights,
    coreDepression: coreDepression * 18.5, // in hPa
  };
}

// App State
let figure: Figure | undefined;
let streamlineLayer: LineLayer | undefined;
let quiverLayer: LineLayer | undefined;
let surfaceLayer: SurfaceLayer | undefined;
let colorbar: ReturnType<Figure['colorbar']> | undefined;
let isPlaying = false;
let currentFrame = 0;
let animTimer: number | undefined;

async function init() {
  try {
    status.textContent = 'Creating WebGPU vector physics figure…';
    figure = await Figure.create(canvas, {
      axes: true,
      titles: { x: 'X (km)', y: 'Y (km)', z: 'Altitude (km)' },
      aspect: [1, 1, 0.6],
    });

    await updateVisualization(0);
    setupEventListeners();
    canvas.dataset.ready = 'true';
  } catch (err) {
    status.textContent = `Initialization error: ${(err as Error).message}`;
  }
}

// One update at a time. A request that arrives while a frame is being built (the play loop, the time slider, a
// control change) replaces any request still waiting, and runs when the current frame is done, so builds never
// overlap and the newest request always wins.
let updating: Promise<void> | undefined;
let wantedFrame: number | undefined;

function updateVisualization(frameIdx: number): Promise<void> {
  wantedFrame = frameIdx;
  updating ??= (async () => {
    try {
      while (wantedFrame !== undefined) {
        const next = wantedFrame;
        wantedFrame = undefined;
        await buildFrame(next);
      }
    } finally {
      updating = undefined;
    }
  })();
  return updating;
}

async function buildFrame(frameIdx: number) {
  if (!figure) return;
  currentFrame = frameIdx;
  const timeSec = (frameIdx / 10).toFixed(1);
  $<HTMLSpanElement>('timeVal').textContent = `${timeSec} s`;
  $<HTMLInputElement>('timeScrubber').value = String(frameIdx);

  const model = $<HTMLSelectElement>('modelSelect').value;
  const colormap = $<HTMLSelectElement>('colormapSelect').value as ColormapName;
  const showStreamlines = $<HTMLInputElement>('streamlinesCheck').checked;
  const showQuiver = $<HTMLInputElement>('quiverCheck').checked;
  const showSurface = $<HTMLInputElement>('surfaceCheck').checked;
  const seedsCount = Number($<HTMLSelectElement>('seedsSelect').value);
  const direction = $<HTMLSelectElement>('directionSelect').value as 'both' | 'forward' | 'backward';
  const lineWidth = Number($<HTMLInputElement>('lineWidthRange').value);
  const quiverScale = Number($<HTMLInputElement>('quiverScaleRange').value);
  const contourCount = Number($<HTMLInputElement>('contourCount').value);

  const field = computeVectorField(model, frameIdx * 0.1);

  // Replace each trace only when its successor exists, keeping a frame visible during async work.
  const old = { streamlineLayer, quiverLayer, surfaceLayer, colorbar };
  let nextStreamlines: LineLayer | undefined;
  let nextQuiver: LineLayer | undefined;
  let nextSurface: SurfaceLayer | undefined;

  // 1. Add Streamlines if checked
  if (showStreamlines) {
    nextStreamlines = await figure.streamlines(
      {
        u: field.u,
        v: field.v,
        w: field.w,
        dims: [NX, NY, NZ],
        bounds: BOUNDS,
      },
      {
        seeds: seedsCount,
        direction,
        step: 0.18,
        maxSteps: 800,
        colormap,
        range: [0, field.speedMax],
        width: lineWidth,
      },
    );
    if (old.streamlineLayer) figure.replace(old.streamlineLayer, nextStreamlines);
  }

  // 2. Add Quiver Vector Arrows if checked
  if (showQuiver) {
    nextQuiver = await figure.quiver(
      {
        x: field.quiver.x,
        y: field.quiver.y,
        z: field.quiver.z,
        u: field.quiver.u,
        v: field.quiver.v,
        w: field.quiver.w,
      },
      {
        scale: quiverScale,
        colormap,
        range: [0, field.speedMax],
        head: 0.35,
        width: 1.5,
      },
    );
    if (old.quiverLayer) figure.replace(old.quiverLayer, nextQuiver);
  }

  // 3. Add Surface with Contours if checked
  if (showSurface) {
    nextSurface = figure.surface(field.surfaceHeights, {
      nx: SURF_NX,
      ny: SURF_NY,
      x: [BOUNDS[0], BOUNDS[1]],
      y: [BOUNDS[2], BOUNDS[3]],
      colormap,
      contours: contourCount,
      opacity: 0.85,
    });
    if (old.surfaceLayer) figure.replace(old.surfaceLayer, nextSurface);
  }
  if (old.streamlineLayer && !nextStreamlines) figure.remove(old.streamlineLayer);
  if (old.quiverLayer && !nextQuiver) figure.remove(old.quiverLayer);
  if (old.surfaceLayer && !nextSurface) figure.remove(old.surfaceLayer);
  old.colorbar?.dispose();
  streamlineLayer = nextStreamlines;
  quiverLayer = nextQuiver;
  surfaceLayer = nextSurface;

  // Colorbar
  colorbar = figure.colorbar(colormap, [0, field.speedMax], { label: 'Wind Velocity (m/s)' });

  // Update HUD
  hudModelInfo.textContent = `Regime: ${model === 'tornado' ? 'Atmospheric Mesocyclone' : model === 'karman' ? 'von Kármán Street' : 'Dipole Eddies'}`;
  hudStreamlinesInfo.textContent = `Streamlines: ${showStreamlines ? `RK4 (${direction}, ${seedsCount}³)` : 'Disabled'}`;
  hudVelocityRange.textContent = `Velocity Peak: ${field.speedMax.toFixed(1)} m/s`;
  hudPressureInfo.textContent = `Core Depression: ${field.coreDepression.toFixed(1)} hPa`;
  hudTimeInfo.textContent = `Simulation Frame: ${frameIdx} / 60 (t = ${timeSec} s)`;

  await figure.ready();
  status.textContent = `Synthetic wind test page ready: computed ${model} flow field (${field.speedMax.toFixed(1)} m/s max velocity).`;
}

function playSimulation() {
  if (isPlaying) return;
  isPlaying = true;
  $<HTMLButtonElement>('btnPlay').style.background = '#2a615a';

  const step = () => {
    if (!isPlaying) return;
    currentFrame = (currentFrame + 1) % 60;
    updateVisualization(currentFrame).then(
      () => {
        if (isPlaying) {
          // fixed-wait: playback cadence after the completed frame, not a GPU readiness wait.
          animTimer = window.setTimeout(step, 80);
        }
      },
      (err: unknown) => {
        pauseSimulation();
        status.textContent = `Playback stopped: ${(err as Error).message}`;
      },
    );
  };
  step();
}

function pauseSimulation() {
  isPlaying = false;
  clearTimeout(animTimer);
  $<HTMLButtonElement>('btnPlay').style.background = '';
}

function setupEventListeners() {
  $('modelSelect').addEventListener('change', () => void updateVisualization(currentFrame));
  $('colormapSelect').addEventListener('change', () => void updateVisualization(currentFrame));
  $('streamlinesCheck').addEventListener('change', () => void updateVisualization(currentFrame));
  $('quiverCheck').addEventListener('change', () => void updateVisualization(currentFrame));
  $('surfaceCheck').addEventListener('change', () => void updateVisualization(currentFrame));
  $('seedsSelect').addEventListener('change', () => void updateVisualization(currentFrame));
  $('directionSelect').addEventListener('change', () => void updateVisualization(currentFrame));
  $('lineWidthRange').addEventListener('input', (e) => {
    $<HTMLSpanElement>('lineWidthVal').textContent = `${(e.target as HTMLInputElement).value} px`;
    void updateVisualization(currentFrame);
  });
  $('quiverScaleRange').addEventListener('input', (e) => {
    $<HTMLSpanElement>('quiverScaleVal').textContent =
      `${(Number((e.target as HTMLInputElement).value) * 100).toFixed(0)}%`;
    void updateVisualization(currentFrame);
  });
  $('contourCount').addEventListener('input', (e) => {
    $<HTMLSpanElement>('contourVal').textContent = (e.target as HTMLInputElement).value;
    void updateVisualization(currentFrame);
  });

  // Timeline
  $('timeScrubber').addEventListener('input', (e) => {
    pauseSimulation();
    void updateVisualization(Number((e.target as HTMLInputElement).value));
  });

  $('btnPlay').addEventListener('click', playSimulation);
  $('btnPause').addEventListener('click', pauseSimulation);

  // SVG Export
  $('btnExportSVG').addEventListener('click', async () => {
    if (!figure) return;
    status.textContent = 'Generating vector SVG diagram…';
    try {
      const svg = await figure.toSVG();
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aeroflow-${Date.now()}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      status.textContent = 'Vector SVG exported successfully.';
    } catch (err) {
      status.textContent = `SVG export failed: ${(err as Error).message}`;
    }
  });

  // PNG Export
  $('btnExportPNG').addEventListener('click', async () => {
    if (!figure) return;
    status.textContent = 'Generating publication PNG snapshot…';
    try {
      const blob = await figure.toPNG();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aeroflow-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      status.textContent = 'PNG snapshot exported successfully.';
    } catch (err) {
      status.textContent = `PNG export failed: ${(err as Error).message}`;
    }
  });

  window.addEventListener(
    'pagehide',
    () => {
      pauseSimulation();
      figure?.dispose();
    },
    { once: true },
  );
}

init();

export { figure, updateVisualization };
