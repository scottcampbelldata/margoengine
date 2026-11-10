import { pairedFrames, imageDifference } from '@margoengine/sciviz/bench';
import { comparisonData } from './data.mjs';
import { margoRenderer, SIZE } from './margo.mjs';
import { rivalRenderer } from './rivals.mjs';
import { installWorkCounters, countDelta } from '../../packages/sciviz/scripts/rival-contract.js';

async function hash(bytes) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(value)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function nonempty(frame) {
  let changed = 0;
  for (let i = 0; i < frame.rgba.length; i += 4)
    if (
      Math.abs(frame.rgba[i] - 15) > 2 ||
      Math.abs(frame.rgba[i + 1] - 20) > 2 ||
      Math.abs(frame.rgba[i + 2] - 28) > 2
    )
      changed++;
  if (!changed) throw new Error('Empty comparison frame');
  return changed;
}

window.runComparison = async ({ id, rival, scale, runs }) => {
  const signal = AbortSignal.timeout(180_000),
    timing = runs !== 1;
  const clock = () => (timing ? performance.now() : undefined);
  const dataStart = clock(),
    data = await comparisonData(id, scale, signal);
  const dataLoadMs = timing ? performance.now() - dataStart : undefined;
  let a, b;
  installWorkCounters();
  try {
    const firstA = clock();
    a = await margoRenderer(document.querySelector('#margo'), data, signal, rival === 'plotly', rival === 'cosmograph');
    const imageA = await a.frame(signal);
    const loadA = timing ? performance.now() - firstA : undefined;
    const firstB = clock();
    b = await rivalRenderer(rival, document.querySelector('#rival'), data, signal);
    const imageB = await b.frame(signal);
    const loadB = timing ? performance.now() - firstB : undefined;
    // Work counts are an independent untimed probe; restore public APIs before any timing samples.
    const beforeA = { ...window.__rivalCounts };
    await a.frame(signal);
    const workA = countDelta(beforeA, window.__rivalCounts);
    const beforeB = { ...window.__rivalCounts };
    await b.frame(signal);
    const workB = countDelta(beforeB, window.__rivalCounts);
    // Calls made while neither adapter renders: a rival's own animation loop shows here and in
    // the other engine's counts, and it keeps running during the other engine's timed samples.
    const beforeIdle = { ...window.__rivalCounts };
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const idle = countDelta(beforeIdle, window.__rivalCounts);
    window.__stopRivalCounters();
    const result = await pairedFrames(a, b, { runs, timing, signal });
    const repeatA = await a.frame(signal),
      repeatB = await b.frame(signal);
    const stable = { a: imageDifference(result.a, repeatA).identical, b: imageDifference(result.b, repeatB).identical };
    // Retain nondeterminism as a failure, never hide it behind an image tolerance.
    if (!stable.a || !stable.b) throw new Error(`Repeated frames differ: ${JSON.stringify(stable)}`);
    window.__comparisonDebug = { margo: a.memory(), rival: b.memory(), workA, workB };
    const report = {
      id,
      rival,
      scale,
      runs,
      smoke: !timing,
      source: data.source,
      inputs: {
        sourceRows: data.sourceRows,
        sourceDims: data.sourceDims,
        replicated: data.replicated,
        resampling: data.resampling,
        copies: data.copies,
        sourceNodes: data.sourceNodes,
        points: data.points?.length,
        values: data.values?.length,
        edges: data.edges?.length / 2,
        coordinates: data.coordinates,
      },
      operation:
        rival === 'plotly' ? 'PNG export and decode on both sides' : 'render and RGBA canvas copy on both sides',
      image: {
        width: SIZE,
        height: SIZE,
        difference: result.difference,
        stable,
        margoInk: nonempty(result.a),
        rivalInk: nonempty(result.b),
        margoSHA256: await hash(result.a.rgba),
        rivalSHA256: await hash(result.b.rgba),
      },
      work: { margo: workA, rival: workB, idleTwoAnimationFrames: idle },
      memory: {
        margo: a.memory(),
        rival: b.memory(),
        pageJSHeapBytes: performance.memory?.usedJSHeapSize ?? null,
        pageJSHeapScope: 'whole shared page, including both engines, source data and libraries',
      },
      ...(timing
        ? {
            timing: result.timing,
            load: { sharedInputMs: dataLoadMs, margoSetupFirstFrameMs: loadA, rivalSetupFirstFrameMs: loadB },
          }
        : {}),
      firstFrames: { margoInk: nonempty(imageA), rivalInk: nonempty(imageB) },
    };
    // Hold the last copied images for screenshots until the host explicitly releases them.
    window.releaseComparison = () => {
      b.dispose();
      a.dispose();
    };
    return report;
  } catch (error) {
    b?.dispose();
    a?.dispose();
    throw error;
  } finally {
    window.__stopRivalCounters?.();
  }
};
