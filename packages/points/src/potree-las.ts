// The LAS reader Potree 1.x LAS and LAZ nodes load on first use. Potree 2.0 nodes never need it, so potree loads it
// lazily; this module is that lazy target, because ./las.js itself is imported statically by the COPC reader and the
// writers, where an import() of it would split nothing (tests/dist-dynamic-imports.test.js).
export { parseLAS } from './las.js';
