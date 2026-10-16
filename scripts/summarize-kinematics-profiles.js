import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const label = process.argv[2] ?? 'evaluate-into-hardware';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid profile label');
const prefix = `test-results/kinematics-constraints-profile-${label}`;
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sampled = await readJSON(`${prefix}.json`),
  unsampled = await readJSON(`${prefix}-gc-only.json`);
const comparisonPath = 'test-results/kinematics-constraints-profile-comparison.json';
const comparison = await readJSON(comparisonPath);
const burst = sampled.phases.find((phase) => phase.name === 'solver-burst');
comparison.sourceSHA256 = sampled.sourceSHA256;
comparison.browser = sampled.hardware;
const stageName =
  process.argv.find((value) => value.startsWith('--stage='))?.slice(8) ??
  (label.startsWith('search-reach-')
    ? 'Exact repeated-angle tag reuse and local reach norm'
    : label.startsWith('solve-arguments-')
      ? 'Private solve reach and search argument slots'
      : label.startsWith('segment-pose-')
        ? 'Internal volume segment and pose clearance scratch outputs'
        : 'Internal built-in volume evaluateInto scratch output');
comparison.solverBurstStages = comparison.solverBurstStages.filter((stage) => stage.stage !== stageName);
comparison.solverBurstStages.push({
  stage: stageName,
  ...(label.startsWith('solve-arguments-retained-')
    ? {
        implementationDetail:
          'Retain already-tagged IK candidate numbers through accepted angle history; Float64 slots contain reach bounds and search span.',
      }
    : {}),
  ...(label.startsWith('search-reach-')
    ? {
        implementationDetail:
          'Reuse the previous tagged angle only when the freshly computed candidate is exactly equal including signed zero, preserve every callback, and inline the guarded norm after exact root-direction selection.',
        numericalEvidence: 'test-results/kinematics-clamp-proof.json',
        compilerEvidence: 'test-results/v8-repeat-angle-final/summary.json',
        constructorEvidence: [
          'test-results/kinematics-constructors-search-reach.json',
          'test-results/kinematics-constructors-search-reach-mixed.json',
        ],
        browserBranchEvidence: 'test-results/kinematics-fixture-angle-browser.json',
        comparisonLimit:
          'Adjacent-stage percentages compare single sampled captures; this workload does not isolate the duplicate-candidate branch and statistical significance is not established.',
      }
    : {}),
  estimatedSolverBytes: burst.allocations.estimatedBytesByStackCategory.solver,
  estimatedBytesPerSolve: burst.allocations.estimatedBytesByStackCategory.solver / burst.result.solves,
  minorGC: burst.garbageCollection.minorMajorEvents,
  sampledReport: `${prefix}.json`,
  unsampledReport: `${prefix}-gc-only.json`,
  capturedPackageSHA256: sampled.sourceSHA256['packages/kinematics-constraints/dist/index.js'],
});
const first = comparison.solverBurstStages[0],
  previous = comparison.solverBurstStages.at(-2),
  current = comparison.solverBurstStages.at(-1);
comparison.sampledSolverByteReductionFromOriginalPercent =
  (1 - current.estimatedBytesPerSolve / first.estimatedBytesPerSolve) * 100;
comparison.sampledSolverByteReductionFromPreviousPercent =
  (1 - current.estimatedBytesPerSolve / previous.estimatedBytesPerSolve) * 100;
comparison.finalPhases = sampled.phases.map((phase) => {
  const gc = unsampled.phases.find((item) => item.name === phase.name);
  return {
    name: phase.name,
    solves: phase.result.solves ?? null,
    frames: phase.result.frames ?? null,
    estimatedBytes: phase.allocations.estimatedBytes,
    estimatedBytesPerObservedFrame: phase.allocations.estimatedBytesPerObservedFrame ?? null,
    estimatedSolverStackBytesPerSolve: phase.allocations.estimatedSolverStackBytesPerSolve ?? null,
    bytesBySource: phase.allocations.estimatedBytesByStackCategory,
    minorGCWithSampler: phase.garbageCollection.minorMajorEvents,
    minorGCWithoutSampler: gc.garbageCollection.minorMajorEvents,
    heapRangeWithoutSampler: gc.heap.rangeBytes,
    retainedDeltaAfterCollectionWithoutSampler: gc.heap.retainedDeltaAfterForcedCollectionBytes,
  };
});
if (comparison.compilerEvidence.remainingProvenBoxedOperation) {
  comparison.compilerEvidence.previousProvenBoxedOperation = comparison.compilerEvidence.remainingProvenBoxedOperation;
}
delete comparison.compilerEvidence.remainingProvenBoxedOperation;
comparison.compilerEvidence.currentStatus = label.startsWith('search-reach-')
  ? 'Exact duplicate candidates can reuse their retained number tag; fresh non-Smi candidates still cross the public numeric callback boundary. Reach normalization preserves the previous fast/scaled arithmetic. Byte estimates are statistical and do not prove every compiler tier allocation-free.'
  : label.startsWith('solve-arguments-retained-')
    ? 'Reach limits and search span use private Float64 input slots; accepted angle history retains the already-tagged callback argument. Byte estimates remain statistical and must be read with the paired GC-only capture.'
    : label.startsWith('solve-arguments-')
      ? 'Reach limits and search center/span now use private Float64 input slots in addition to scalar output scratch. Byte estimates remain statistical and must be read with the paired GC-only capture.'
      : label.startsWith('segment-pose-')
        ? 'Built-in projection, segment checks and internal pose checks now write scalar distances to reused storage. Remaining allocation attribution requires further compiler evidence; byte estimates are not an exact operation census.'
        : 'Built-in projection now writes distance to caller-owned scratch. Remaining allocation attribution requires further compiler evidence; byte estimates are not an exact operation census.';
if (label.startsWith('search-reach-')) {
  comparison.constructorEvidenceHistory = [
    ...new Set(
      [
        ...(comparison.constructorEvidenceHistory ?? []),
        comparison.constructorEvidence,
        'test-results/kinematics-constructors-solve-arguments-retained.json',
        'test-results/kinematics-constructors-solve-arguments-retained-mixed.json',
      ].filter(
        (path) => typeof path === 'string' && !/kinematics-constructors-search-reach(?:-mixed)?\.json$/.test(path),
      ),
    ),
  ];
  comparison.constructorEvidence = 'test-results/kinematics-constructors-search-reach.json';
  comparison.constructorEvidenceMixed = 'test-results/kinematics-constructors-search-reach-mixed.json';
  comparison.compilerEvidence.currentReport = 'test-results/v8-repeat-angle-final/summary.json';
  comparison.compilerEvidence.priorReports = [
    ...new Set(
      [
        ...(comparison.compilerEvidence.priorReports ?? []),
        comparison.compilerEvidence.postSummary,
        'test-results/v8-tagged-pole-final/summary.json',
        'test-results/v8-solve-slots-final/summary.json',
      ].filter(Boolean),
    ),
  ];
  comparison.compilerEvidence.browserBranchReplay = 'test-results/kinematics-fixture-angle-browser.json';
  comparison.compilerEvidence.measuredBurstAttributionLimit =
    'Separate Edge replay after the identical10000-solve warmup counted100000 retained-center callbacks and zero fresh candidate calls in the100000-solve burst. Residual sampled burst bytes cannot be assigned to a dynamic fresh-candidate floor; exact cold/JIT allocation attribution remains unproven.';
}
comparison.notes = comparison.notes.filter((note) => !note.startsWith('No exact') && !note.startsWith('The current'));
comparison.notes.push(
  `No exact bytes/frame or zero-GC claim is established; the current stage still exhibits ${burst.garbageCollection.minorMajorEvents} minor collections during the ${burst.result.solves.toLocaleString('en-US')}-solve warmed burst.`,
);
await writeFile(comparisonPath, JSON.stringify(comparison, null, 2) + '\n');

const drag = sampled.phases.find((phase) => phase.name === 'demo-trusted-pointer-drag');
const raw = await readJSON(drag.artifacts.allocations),
  grouped = new Map();
function visit(node) {
  const frame = node.callFrame;
  if (node.selfSize && /\/examples\/kinematics-constraints\.html/.test(frame.url)) {
    const key = `${frame.functionName}:${frame.lineNumber}:${frame.columnNumber}`;
    const item = grouped.get(key) ?? {
      functionName: frame.functionName,
      estimatedBytes: 0,
      capturedFunctionLocation: { url: frame.url, line: frame.lineNumber + 1, column: frame.columnNumber + 1 },
    };
    item.estimatedBytes += node.selfSize;
    grouped.set(key, item);
  }
  for (const child of node.children) visit(child);
}
visit(raw.head);
const demoLines = (await readFile('examples/kinematics-constraints.html', 'utf8')).split(/\r?\n/);
const sourceLine = (name) => {
  const line = demoLines.findIndex((value) => value.includes(`function ${name}(`));
  return line < 0 ? null : line + 1;
};
const outer = {
  sampledReport: `${prefix}.json`,
  unsampledReport: `${prefix}-gc-only.json`,
  sourceSHA256: sampled.sourceSHA256,
  browser: sampled.hardware,
  durationFrames: drag.result.frames,
  trustedPointerMoves: drag.result.trustedMoves,
  estimatedBytes: drag.allocations.estimatedBytes,
  estimatedBytesPerFrame: drag.allocations.estimatedBytes / drag.result.frames,
  estimatedBytesByStackCategory: drag.allocations.estimatedBytesByStackCategory,
  demoFunctionSelfBytes: [...grouped.values()]
    .sort((a, b) => b.estimatedBytes - a.estimatedBytes)
    .map((item) => ({
      ...item,
      currentHTMLFunctionLine: sourceLine(item.functionName),
      estimatedBytesPerFrame: item.estimatedBytes / drag.result.frames,
    })),
  candidateOperations: [
    {
      functionName: 'updatePose',
      lines: [247, 248],
      observation:
        'Two marker VectorRef.set calls receive computed numeric components; sampled self bytes are attributed to the enclosing function, not proven at these operators.',
    },
    {
      functionName: 'updateRod',
      lines: [207, 208, 209],
      observation:
        'Position, scale and rotation VectorRef.set calls receive computed numeric values. Cached VectorRef instances already exist on each Mesh; property access creates no wrapper.',
    },
    {
      functionName: 'pointerTarget',
      lines: [342],
      observation:
        'Ray arithmetic and numeric calls occur on trusted pointer input. Function-start samples do not isolate a particular arithmetic operation.',
    },
    {
      functionName: 'intersectDragSurface',
      lines: [318],
      observation:
        'Five numeric arguments and a scalar return cross this boundary. A void scratch output could be tested separately; allocation reduction is not established by this capture.',
    },
    {
      functionName: 'step',
      lines: [285],
      observation:
        'Raw marker transform is written each render frame although this trusted pointer workload updates input at roughly 20 Hz. Skipping unchanged transforms is a possible demo-only experiment.',
    },
  ],
  limits: [
    'Sampling interval 4096 bytes produces statistical estimates; reported bytes/frame are not exact.',
    'CDP call-frame line numbers identify function definitions, not individual allocating instructions. Operator-level proof requires compiler diagnostics or a controlled ablation.',
    'Frames include rendering, HUD and pointer work. Per-move bytes must not be interpreted as isolated pointer-handler cost.',
    'Frozen core lifecycle and finite-value guards remain unchanged. No direct engine-store writes are proposed.',
    'Retained post-collection differences from one workload do not establish a long-term memory leak.',
  ],
};
await writeFile('test-results/kinematics-constraints-outer-allocations.json', JSON.stringify(outer, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      solverBurstStages: comparison.solverBurstStages,
      reductionFromPreviousPercent: comparison.sampledSolverByteReductionFromPreviousPercent,
      outerTop: outer.demoFunctionSelfBytes.slice(0, 6),
    },
    null,
    2,
  ),
);
