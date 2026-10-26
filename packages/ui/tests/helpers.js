import { Ui } from '../dist/index.js';

/** Monospace measurer: every cluster is half an em wide. */
export const measurer = {
  advance: () => 0.5,
  kerning: () => 0,
  metrics: () => ({ ascent: 0.8, descent: 0.2 }),
};

/** A UI with deterministic text and no transitions. Default 800 by 600. */
export function makeUi(options = {}) {
  return new Ui({ width: 800, height: 600, measurer, reducedMotion: true, safeArea: [0, 0, 0, 0], ...options });
}

/** A plain layout node. */
export function node(style = {}, children = [], measure) {
  return { style, children, rect: { x: 0, y: 0, width: 0, height: 0 }, measure };
}

/** A leaf of fixed content size. */
export const box = (width, height, style = {}) => node(style, [], () => ({ width, height }));

export const near = (actual, expected, message) => {
  if (Math.abs(actual - expected) > 1e-6) throw new Error(`${message ?? 'value'}: expected ${expected}, got ${actual}`);
};

export const rectOf = (widget) => {
  const { x, y, width, height } = widget.rect;
  return [x, y, width, height];
};
