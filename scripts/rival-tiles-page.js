// One quadtree, two selectors. 3d-tiles-renderer is driven from its README:
// TilesRenderer, setCamera, setResolution, errorTarget, update.
// This file does not read that library's source.
import { TilesRenderer } from '3d-tiles-renderer';
import * as THREE from 'three';
import { Tileset } from '@margoengine/tiles';
import { TILES_SCENE, sceneView, selectionChecksum, tilePath } from './rival-tiles-scene.mjs';

const ROUNDS = 7;

const fail = (error) => {
  window.__rival = { error: String(error && error.message ? error.message : error), stack: error && error.stack };
};

function contentPath(tile) {
  const seen = new Set();
  const queue = [tile];
  while (queue.length && seen.size < 300) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.keys(value)) {
      const child = value[key];
      const text = typeof child === 'string' ? child : child instanceof URL ? String(child) : '';
      const match = text.match(/tiles\/\d+\/\d+\/\d+\.glb/);
      if (match) return match[0];
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return undefined;
}

function depthsOf(paths) {
  const depths = {};
  for (const path of paths) {
    const level = path.split('/')[1];
    depths[level] = (depths[level] ?? 0) + 1;
  }
  return depths;
}

function planeSide(planes, sample) {
  for (let i = 0; i < 6; i++) {
    const signed =
      planes[i * 4] * sample[0] +
      planes[i * 4 + 1] * sample[1] +
      planes[i * 4 + 2] * sample[2] +
      planes[i * 4 + 3];
    if (signed < -1e-3) return false;
  }
  return true;
}

async function settleMargo(tileset, view) {
  let frame;
  for (let i = 0; i < 20000; i++) {
    frame = tileset.update(view);
    if (frame.pending === 0 && tileset.progress.loading === 0 && tileset.progress.queued === 0) return frame;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`margo selection did not settle; pending ${frame?.pending}`);
}

try {
  const camera = TILES_SCENE.camera;
  const view = sceneView();
  const base = `${location.origin}/rival-data/`;
  const tileset = await Tileset.load(`${base}tileset.json`, {
    maximumScreenSpaceError: TILES_SCENE.maximumScreenSpaceError,
  });
  const frame = await settleMargo(tileset, view);
  if (tileset.progress.failed !== 0) throw new Error(`margo failed loads ${tileset.progress.failed}`);
  const margoPaths = frame.selected.map((tile) => tilePath(tile.id));

  const perspective = new THREE.PerspectiveCamera(
    camera.fov,
    camera.width / camera.height,
    camera.near,
    camera.far,
  );
  perspective.position.set(camera.position[0], camera.position[1], camera.position[2]);
  perspective.up.set(camera.up[0], camera.up[1], camera.up[2]);
  perspective.lookAt(camera.target[0], camera.target[1], camera.target[2]);
  perspective.updateProjectionMatrix();
  perspective.updateMatrixWorld();
  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(perspective.projectionMatrix, perspective.matrixWorldInverse),
  );
  for (const sample of [camera.target, [0, 10, 0], [100, 10, 100], [0, 80, 800], camera.position]) {
    const theirs = frustum.containsPoint(new THREE.Vector3(sample[0], sample[1], sample[2]));
    if (planeSide(view.planes, sample) !== theirs) {
      throw new Error(`frustum mismatch at ${sample}: margo ${planeSide(view.planes, sample)} rival ${theirs}`);
    }
  }

  const rival = new TilesRenderer(`${base}tileset.json`);
  rival.errorTarget = TILES_SCENE.maximumScreenSpaceError;
  rival.setCamera(perspective);
  if (rival.setResolution(perspective, camera.width, camera.height) !== true) throw new Error('setResolution returned false');
  const root = new THREE.Scene();
  root.add(rival.group);
  const loadErrors = [];
  let loading = 0;
  rival.addEventListener('load-error', (event) => {
    loadErrors.push(`${event.url ?? ''} ${event.error && event.error.message ? event.error.message : event.error ?? ''}`);
  });
  rival.addEventListener('tiles-load-start', () => {
    loading++;
  });
  rival.addEventListener('tiles-load-end', () => {
    loading = Math.max(0, loading - 1);
  });
  let stable = 0;
  let lastCount = -1;
  let rivalTiles = [];
  const started = performance.now();
  for (let i = 0; i < 20000; i++) {
    perspective.updateMatrixWorld();
    rival.update();
    if (!rival.visibleTiles) throw new Error(`visibleTiles missing: ${Object.keys(rival).join(', ')}`);
    rivalTiles = [...rival.visibleTiles];
    if (loading === 0 && rivalTiles.length === lastCount && rivalTiles.length > 0) stable++;
    else stable = 0;
    lastCount = rivalTiles.length;
    if (stable >= 10 && performance.now() - started > 500) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (stable < 10) throw new Error(`rival selection did not settle; visible ${lastCount} loading ${loading}; errors ${loadErrors.slice(0, 3).join(' | ')}`);
  if (loadErrors.length) throw new Error(`rival load errors: ${loadErrors.slice(0, 5).join(' | ')}`);

  const rivalPaths = [];
  for (const tile of rivalTiles) {
    const path = contentPath(tile);
    if (!path) throw new Error(`rival tile has no content path; keys ${Object.keys(tile).join(', ')}`);
    rivalPaths.push(path);
  }
  const sample = rivalTiles[0];
  const sampleKeys = sample ? Object.keys(sample) : [];
  const sampleNumbers = {};
  if (sample) {
    for (const key of sampleKeys) if (typeof sample[key] === 'number') sampleNumbers[key] = sample[key];
  }
  const margoSet = new Set(margoPaths);
  const rivalSet = new Set(rivalPaths);
  const onlyMargo = [...margoSet].filter((path) => !rivalSet.has(path)).sort();
  const onlyRival = [...rivalSet].filter((path) => !margoSet.has(path)).sort();

  const roundsA = [];
  const roundsB = [];
  for (let i = 0; i < ROUNDS + 2; i++) {
    const runA = () => tileset.update(view);
    const runB = () => {
      perspective.updateMatrixWorld();
      rival.update();
    };
    const firstB = i % 2 === 1;
    const t0 = performance.now();
    if (firstB) runB();
    else runA();
    const mid = performance.now();
    if (firstB) runA();
    else runB();
    const end = performance.now();
    if (i >= 2) {
      (firstB ? roundsB : roundsA).push(mid - t0);
      (firstB ? roundsA : roundsB).push(end - mid);
    }
  }
  window.__rival = {
    margoCount: margoSet.size,
    rivalCount: rivalSet.size,
    margoChecksum: selectionChecksum(margoPaths),
    rivalChecksum: selectionChecksum(rivalPaths),
    margoDepths: depthsOf(margoPaths),
    rivalDepths: depthsOf(rivalPaths),
    onlyMargo: onlyMargo.length,
    onlyRival: onlyRival.length,
    onlyMargoSample: onlyMargo.slice(0, 8),
    onlyRivalSample: onlyRival.slice(0, 8),
    sampleKeys,
    sampleNumbers,
    minA: Math.min(...roundsA),
    minB: Math.min(...roundsB),
    roundsA,
    roundsB,
  };
} catch (error) {
  fail(error);
}
