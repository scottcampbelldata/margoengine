import { Stage, createStage } from 'margoengine';

// The five-line stage app without a feature entry: it must reach no optional package at all, not even lazily, so
// webpack and Turbopack (which resolve every import() they meet) build it with no optional peer installed.
globalThis.stageOnly = { Stage, createStage };
