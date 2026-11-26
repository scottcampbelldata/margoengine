// `@margoengine/physics/flip`: grid-particle liquids (FLUID-03 of docs/physics-solvers.md): water that splashes,
// overturns and pours, APIC particles on a MAC grid with a free surface (FlipSolver), and green water on a hull's deck in
// a box that rides its body (DeckWaterSolver).
export { FlipSolver, type FlipParams, type LiquidSea, type LiquidSolid } from './solver.js';
export { DeckWaterSolver, type DeckWaterOptions, type DeckWaterParams } from './deck-water.js';
export { AIR, LIQUID, SOLID, project, THETA_FLOOR, type GridShape } from './grid.js';
export { PARTICLE_WORDS, sampleVelocity, toGrid, toParticles, wallFaces } from './transfer.js';
