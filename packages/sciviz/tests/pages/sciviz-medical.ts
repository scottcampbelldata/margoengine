// Volume test page: Interactive Medical Volumetric & Volume Suite.
// Built cleanly on @margoengine/sciviz: direct ray-marching, multi-planar reconstruction (MPR),
// GPU marching-cubes isosurface extraction, and NIfTI/DICOM medical format decoding.
import {
  Figure,
  type ColormapName,
  type IsosurfaceLayer,
  type SliceLayer,
  type VolumeLayer,
} from '@margoengine/sciviz';
import { parseNIfTI } from '@margoengine/sciviz/formats';

import { loadNRRD, nrrdGrid } from '@margoengine/sciviz/nrrd';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('viewport');
const status = $<HTMLParagraphElement>('status');

// HUD elements
const hudVoxelInfo = $<HTMLDivElement>('hudVoxelInfo');
const hudRangeInfo = $<HTMLDivElement>('hudRangeInfo');
const hudModeInfo = $<HTMLDivElement>('hudModeInfo');
const hudSlicesInfo = $<HTMLDivElement>('hudSlicesInfo');
const hudIsoInfo = $<HTMLDivElement>('hudIsoInfo');

// Transfer function presets (opacity stops: [valueInUnitInterval, opacity])
const TF_PRESETS: Record<string, { colormap: ColormapName; opacity: [number, number][]; density: number }> = {
  mri: {
    colormap: 'gray',
    density: 1.2,
    opacity: [
      [0.0, 0.0],
      [0.1, 0.0],
      [0.22, 0.12],
      [0.55, 0.45],
      [0.85, 0.85],
      [1.0, 0.95],
    ],
  },
  bone: {
    colormap: 'ember',
    density: 1.6,
    opacity: [
      [0.0, 0.0],
      [0.45, 0.0],
      [0.55, 0.2],
      [0.75, 0.75],
      [1.0, 0.98],
    ],
  },
  angio: {
    colormap: 'magma',
    density: 1.8,
    opacity: [
      [0.0, 0.0],
      [0.6, 0.0],
      [0.7, 0.4],
      [0.85, 0.9],
      [1.0, 1.0],
    ],
  },
  pet: {
    colormap: 'coolwarm',
    density: 1.4,
    opacity: [
      [0.0, 0.0],
      [0.15, 0.05],
      [0.4, 0.2],
      [0.7, 0.7],
      [1.0, 0.95],
    ],
  },
};

interface LoadedVolume {
  data: Float32Array;
  dims: [number, number, number];
  bounds: [number, number, number, number, number, number];
  range: [number, number];
  name: string;
}

// Procedural anatomical 3D brain phantom (128 x 128 x 128)
function generateAnatomicalPhantom(n = 128): LoadedVolume {
  const data = new Float32Array(n * n * n);
  const bounds: [number, number, number, number, number, number] = [-100, 100, -110, 110, -90, 90];
  let min = Infinity;
  let max = -Infinity;

  for (let z = 0; z < n; z++) {
    const zn = (z / (n - 1) - 0.5) * 2; // [-1, 1]
    for (let y = 0; y < n; y++) {
      const yn = (y / (n - 1) - 0.5) * 2;
      for (let x = 0; x < n; x++) {
        const xn = (x / (n - 1) - 0.5) * 2;
        const idx = z * n * n + y * n + x;

        // Ellipsoidal coordinate
        const rSkull = (xn * xn) / (0.82 * 0.82) + (yn * yn) / (0.95 * 0.95) + (zn * zn) / (0.88 * 0.88);
        const rBrain = (xn * xn) / (0.75 * 0.75) + (yn * yn) / (0.88 * 0.88) + (zn * zn) / (0.78 * 0.78);

        let val = 0;

        // Skull cortical bone
        if (rSkull <= 1.0 && rBrain > 0.95) {
          val = 0.85 + 0.15 * Math.random(); // Dense bone
        } else if (rBrain <= 0.95) {
          // Brain parenchyma with gyri / sulci convolutions
          const angle = Math.atan2(yn, xn);
          const r = Math.sqrt(xn * xn + yn * yn + zn * zn);
          const gyri =
            0.12 * Math.sin(16 * angle) * Math.cos(10 * zn) + 0.08 * Math.cos(24 * r) + 0.06 * Math.sin(14 * xn);

          // Deep white vs grey matter
          const distToCenter = Math.sqrt(rBrain);
          const parenchyma = 0.35 + 0.3 * (1 - distToCenter) + gyri;

          // Lateral ventricles (butterfly cavities with cerebrospinal fluid = low density)
          const ventX = Math.abs(xn) - 0.16;
          const ventY = yn - 0.05;
          const ventZ = zn;
          const rVent = (ventX * ventX) / 0.015 + (ventY * ventY) / 0.08 + (ventZ * ventZ) / 0.03;
          if (rVent < 1.0) {
            val = 0.05; // CSF cavity
          } else {
            val = Math.max(0.15, Math.min(0.75, parenchyma));
          }

          // Focal lesion / contrast-enhanced tumor (hypermetabolic hotspot in left hemisphere)
          const lx = xn - 0.28;
          const ly = yn - 0.18;
          const lz = zn - 0.15;
          const rLesionSq = lx * lx + ly * ly + lz * lz;
          if (rLesionSq < 0.02) {
            const intensity = Math.exp(-rLesionSq / 0.006);
            val = Math.max(val, 0.45 + 0.55 * intensity);
          }
        }

        data[idx] = val;
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
  }

  return {
    data,
    dims: [n, n, n],
    bounds,
    range: [min, max],
    name: 'Anatomical Neuro Phantom',
  };
}

// Load real NIfTI dataset
async function loadNiftiFixture(): Promise<LoadedVolume> {
  const res = await fetch('/packages/sciviz/tests/fixtures/zstat1.nii.gz');
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching zstat1.nii.gz`);
  const buf = await res.arrayBuffer();
  const nifti = await parseNIfTI(buf);
  const data = nifti.data instanceof Float32Array ? nifti.data : new Float32Array(nifti.data);
  return {
    data,
    dims: nifti.dims,
    bounds: nifti.bounds,
    range: nifti.range,
    name: 'NIfTI fMRI Statistical Map',
  };
}

// The real multi-slice head used by the official example, also exercised here.
async function loadHeadFixture(): Promise<LoadedVolume> {
  const grid = nrrdGrid(await loadNRRD(new URL('../../../../examples/assets/sciviz/head.nrrd', import.meta.url)));
  return { ...grid, data: Float32Array.from(grid.data), name: 'OpenNeuro T1w MRI (CC0)' };
}

// App State
let figure: Figure | undefined;
let activeVolume: LoadedVolume | undefined;
let volumeLayer: VolumeLayer | undefined;
let isoLayer: IsosurfaceLayer | undefined;
let activeSliceAxis: 'x' | 'y' | 'z' | null = null;
let sliceLayer: SliceLayer | undefined;
let currentColorbar: ReturnType<Figure['colorbar']> | undefined;
let currentPreset = 'mri';

async function init() {
  try {
    status.textContent = 'Creating WebGPU scientific figure…';
    figure = await Figure.create(canvas, {
      axes: true,
      titles: { x: 'X (mm)', y: 'Y (mm)', z: 'Z (mm)' },
      aspect: [1, 1, 0.85],
    });

    await serial(() => loadAndDisplay('phantom'));
    setupEventListeners();
    canvas.dataset.ready = 'true';
  } catch (err) {
    status.textContent = `Initialization failed: ${(err as Error).message}`;
  }
}

async function loadAndDisplay(sourceType: string) {
  if (!figure) return;
  status.textContent = `Loading ${sourceType} dataset…`;

  // Fetch before publishing a replacement; errors leave the displayed data intact.
  const loaded =
    sourceType === 'nifti'
      ? await loadNiftiFixture()
      : sourceType === 'head'
        ? await loadHeadFixture()
        : generateAnatomicalPhantom(128);
  sliceLayer?.dispose();
  sliceLayer = undefined;
  if (isoLayer) figure.remove(isoLayer);
  isoLayer = undefined;
  currentColorbar?.dispose();
  activeVolume = loaded;

  const preset = TF_PRESETS[currentPreset] || TF_PRESETS.mri;
  const colormap = $<HTMLSelectElement>('colormapSelect').value as ColormapName;
  const renderMode = $<HTMLSelectElement>('renderModeSelect').value as 'composite' | 'mip';
  const density = Number($<HTMLInputElement>('densityRange').value);

  const oldVolume = volumeLayer;
  const at = (value: number) => (value - activeVolume!.range[0]) / (activeVolume!.range[1] - activeVolume!.range[0]);
  const opacity: [number, number][] =
    sourceType === 'nifti'
      ? [
          [0, 0.7],
          [at(-3), 0],
          [at(3), 0],
          [1, 0.85],
        ]
      : preset.opacity;
  volumeLayer = figure.volume(activeVolume.data, {
    dims: activeVolume.dims,
    bounds: activeVolume.bounds,
    range: activeVolume.range,
    colormap,
    opacity,
    density,
    mode: renderMode,
  });

  if (oldVolume) volumeLayer = figure.replace(oldVolume, volumeLayer);

  currentColorbar = figure.colorbar(colormap, activeVolume.range, { label: 'Intensity' });

  // Update HUD
  hudVoxelInfo.textContent = `Grid: ${activeVolume.dims.join(' × ')} (${activeVolume.data.length.toLocaleString('en')} voxels)`;
  hudRangeInfo.textContent = `Scalar Range: [${activeVolume.range[0].toFixed(2)}, ${activeVolume.range[1].toFixed(2)}]`;
  hudModeInfo.textContent = `Mode: ${renderMode === 'mip' ? 'Maximum Intensity (MIP)' : 'Composite Ray-Marching'}`;

  // Apply cutaway if set
  applyCutaway();

  // Re-apply slice if active
  if (activeSliceAxis) {
    applySlice();
  }

  // Update isosurface if checked (already inside the serial queue)
  await buildIsosurface();

  await figure.ready();
  status.textContent = `Ready: ${activeVolume.name} (${activeVolume.dims.join('×')}) displayed.`;
}

function applyCutaway() {
  if (!volumeLayer) return;
  const cutVal = Number($<HTMLInputElement>('cutRange').value);
  const cutValTag = $<HTMLSpanElement>('cutVal');
  if (cutVal >= 100) {
    volumeLayer.clip = [];
    cutValTag.textContent = 'Off';
  } else {
    // Normal [-1, 0, 0] cuts along coronal plane
    const offset = cutVal / 100;
    volumeLayer.clip = [{ normal: [-1, 0, 0], offset }];
    cutValTag.textContent = `${cutVal}%`;
  }
}

function applySlice() {
  if (!volumeLayer || !activeSliceAxis) {
    sliceLayer?.dispose();
    sliceLayer = undefined;
    hudSlicesInfo.textContent = 'Active Slices: None';
    return;
  }
  const posVal = Number($<HTMLInputElement>('slicePosRange').value) / 100;
  $<HTMLSpanElement>('slicePosVal').textContent = `${(posVal * 100).toFixed(0)}%`;

  if (sliceLayer) {
    sliceLayer.position = posVal;
  } else {
    sliceLayer = volumeLayer.slice(activeSliceAxis, posVal);
  }
  hudSlicesInfo.textContent = `Active Slices: ${activeSliceAxis.toUpperCase()} @ ${(posVal * 100).toFixed(0)}%`;
}

// Dataset loads and isosurface extractions run one at a time. Overlapping runs built two isosurfaces when the
// threshold slider moved quickly (one left behind on screen), and a dataset switch could remove the layer an
// extraction was still writing.
let work: Promise<void> = Promise.resolve();
function serial(task: () => Promise<void>): Promise<void> {
  work = work.then(task).catch((err: unknown) => {
    status.textContent = `Update failed: ${(err as Error).message}`;
  });
  return work;
}

// Slider moves while an extraction is waiting add nothing: the waiting run reads the slider when it starts.
let isoQueued = false;
function updateIsosurface(): Promise<void> {
  if (isoQueued) return work;
  isoQueued = true;
  return serial(async () => {
    isoQueued = false;
    await buildIsosurface();
  });
}

async function buildIsosurface() {
  if (!figure || !activeVolume) return;
  const isEnabled = $<HTMLInputElement>('isoCheck').checked;
  const isoRow = $<HTMLDivElement>('isoRow');
  isoRow.style.display = isEnabled ? 'flex' : 'none';

  if (!isEnabled) {
    if (isoLayer) {
      figure.remove(isoLayer);
      isoLayer = undefined;
    }
    $<HTMLSpanElement>('isoTriangles').textContent = '0 Δ';
    hudIsoInfo.textContent = 'Isosurface: Disabled';
    return;
  }

  const pct = Number($<HTMLInputElement>('isoThreshold').value) / 100;
  const level = activeVolume.range[0] + (activeVolume.range[1] - activeVolume.range[0]) * pct;
  $<HTMLSpanElement>('isoVal').textContent = level.toFixed(2);

  const colormap = $<HTMLSelectElement>('colormapSelect').value as ColormapName;

  if (isoLayer) {
    await isoLayer.update(level);
  } else {
    isoLayer = await figure.isosurface(activeVolume.data, level, {
      dims: activeVolume.dims,
      bounds: activeVolume.bounds,
      range: activeVolume.range,
      colormap,
    });
  }

  const triCount = isoLayer.triangles;
  $<HTMLSpanElement>('isoTriangles').textContent = `${triCount.toLocaleString('en')} Δ`;
  hudIsoInfo.textContent = `Isosurface: ${triCount.toLocaleString('en')} Δ @ ${level.toFixed(2)}`;
}

function setupEventListeners() {
  // Dataset change
  $('datasetSelect').addEventListener('change', (e) => {
    void serial(() => loadAndDisplay((e.target as HTMLSelectElement).value));
  });

  // TF Presets
  const chips = document.querySelectorAll<HTMLButtonElement>('#tfPresets .chip');
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      for (const c of chips) c.classList.remove('active');
      chip.classList.add('active');
      const presetKey = chip.dataset.preset || 'mri';
      currentPreset = presetKey;
      const preset = TF_PRESETS[presetKey];
      if (preset && volumeLayer) {
        $<HTMLSelectElement>('colormapSelect').value = preset.colormap;
        $<HTMLInputElement>('densityRange').value = String(preset.density);
        $<HTMLSpanElement>('densityVal').textContent = `${preset.density}x`;
        void serial(() => loadAndDisplay($<HTMLSelectElement>('datasetSelect').value));
      }
    });
  }

  // Colormap change
  $('colormapSelect').addEventListener('change', () => {
    void serial(() => loadAndDisplay($<HTMLSelectElement>('datasetSelect').value));
  });

  // Render mode change
  $('renderModeSelect').addEventListener('change', (e) => {
    const mode = (e.target as HTMLSelectElement).value as 'composite' | 'mip';
    if (volumeLayer) {
      volumeLayer.mode = mode;
      hudModeInfo.textContent = `Mode: ${mode === 'mip' ? 'Maximum Intensity (MIP)' : 'Composite Ray-Marching'}`;
    }
  });

  // Optical density change
  $('densityRange').addEventListener('input', (e) => {
    const val = Number((e.target as HTMLInputElement).value);
    $<HTMLSpanElement>('densityVal').textContent = `${val.toFixed(1)}x`;
    if (volumeLayer) volumeLayer.density = val;
  });

  // MPR Slices buttons
  const sliceBtns = [
    { btn: $('btnAxial'), axis: 'z' as const, label: 'Axial (Z)' },
    { btn: $('btnCoronal'), axis: 'y' as const, label: 'Coronal (Y)' },
    { btn: $('btnSagittal'), axis: 'x' as const, label: 'Sagittal (X)' },
  ];

  for (const item of sliceBtns) {
    item.btn.addEventListener('click', () => {
      if (activeSliceAxis === item.axis) {
        // Toggle off
        activeSliceAxis = null;
        item.btn.classList.remove('active');
        $('slicePosRow').style.display = 'none';
        applySlice();
      } else {
        // Switch to this slice
        activeSliceAxis = item.axis;
        for (const b of sliceBtns) b.btn.classList.remove('active');
        item.btn.classList.add('active');
        $('slicePosRow').style.display = 'flex';
        $('slicePosLabel').textContent = `${item.label}:`;
        sliceLayer?.dispose();
        sliceLayer = undefined;
        applySlice();
      }
    });
  }

  $('slicePosRange').addEventListener('input', () => {
    applySlice();
  });

  // Cutaway slider
  $('cutRange').addEventListener('input', () => {
    applyCutaway();
  });

  // Isosurface controls
  $('isoCheck').addEventListener('change', () => {
    void updateIsosurface();
  });
  $('isoThreshold').addEventListener('input', () => {
    void updateIsosurface();
  });

  // PNG Export
  $('btnExportPNG').addEventListener('click', async () => {
    if (!figure) return;
    status.textContent = 'Generating publication-resolution snapshot…';
    try {
      const blob = await figure.toPNG();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `neuroscan-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      status.textContent = 'Volume snapshot exported successfully.';
    } catch (err) {
      status.textContent = `Export failed: ${(err as Error).message}`;
    }
  });

  window.addEventListener('pagehide', () => figure?.dispose(), { once: true });
}

init();

export { figure, work, activeVolume, volumeLayer, isoLayer };
