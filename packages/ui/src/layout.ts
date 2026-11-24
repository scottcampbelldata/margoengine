import { rangeError, typeError } from '../../shared/errors.js';

/** A rectangle in UI units: `x` right, `y` down from the top left of the screen. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A size: a number of UI units, `'auto'` (fit the content), `'fill'` (take the free space along the parent's main
 * axis, or the whole cross axis) or a percentage of the parent's content box such as `'50%'`.
 */
export type Size = number | 'auto' | 'fill' | `${number}%`;
/** Spacing around or inside a box: one number, `[vertical, horizontal]` or `[top, right, bottom, left]`. */
export type Edges = number | readonly [number, number] | readonly [number, number, number, number];
/** Placement on the cross axis. `'stretch'` fills the cross axis when the size is `'auto'`. */
export type Align = 'start' | 'center' | 'end' | 'stretch';
/** Placement of the children along the main axis. */
export type Justify = 'start' | 'center' | 'end' | 'space-between' | 'space-around' | 'space-evenly';
/** Where an anchored child sits in its parent's content box. `'stretch'` fills both axes. */
export type Anchor =
  | 'stretch'
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'left'
  | 'center'
  | 'right'
  | 'bottom-left'
  | 'bottom'
  | 'bottom-right';

/** How a box lays out and is laid out. Every field is optional; defaults are noted per field. */
export interface LayoutStyle {
  /** How children are placed: `'column'` (default), `'row'`, `'stack'` (all anchored over each other) or `'grid'`. */
  direction?: 'row' | 'column' | 'stack' | 'grid';
  /** Space between children in `row`, `column` and `grid`: one number or `[column gap, row gap]`. Default 0. */
  gap?: number | readonly [number, number];
  /** Cross-axis placement of the children. Default `'stretch'` in a column and `'center'` in a row. */
  align?: Align;
  /** Main-axis placement of the children when none of them grows. Default `'start'`. */
  justify?: Justify;
  /** Space inside the box. Default 0. */
  padding?: Edges;
  /** Space outside the box. In a stack it is the distance from the anchored edges. Default 0. */
  margin?: Edges;
  /** Default `'auto'`. */
  width?: Size;
  /** Default `'auto'`. */
  height?: Size;
  /** Lower bound of the width in UI units. Default 0. */
  minWidth?: number;
  /** Upper bound of the width. Default unbounded. */
  maxWidth?: number;
  /** Lower bound of the height. Default 0. */
  minHeight?: number;
  /** Upper bound of the height. Default unbounded. */
  maxHeight?: number;
  /** Share of the free main-axis space this child takes. Default 0 (1 for `'fill'` on the main axis). */
  grow?: number;
  /** How readily this child gives up its size when the parent is too small. Default 1. */
  shrink?: number;
  /** Cross-axis placement of this child, overriding the parent's `align`. Default `'auto'` (the parent's). */
  alignSelf?: Align | 'auto';
  /** Anchor in the parent's content box. Children of a `'stack'` default to `'stretch'`; set it elsewhere with `position: 'absolute'`. */
  anchor?: Anchor;
  /** Take the child out of the flow and place it with `anchor` (and `margin`). Default `'flow'`. */
  position?: 'flow' | 'absolute';
  /** Extra shift in UI units after layout; does not affect other boxes. Default `[0, 0]`. */
  offset?: readonly [number, number];
  /** In a stack, ignore the parent's padding (and the safe area), so the child can fill the whole screen. Default false. */
  bleed?: boolean;
  /** Columns of a `'grid'`. Default 1. */
  columns?: number;
  /** Cell width of a `'grid'`. Default the widest child. */
  cellWidth?: number;
  /** Cell height of a `'grid'`. Default the tallest child. */
  cellHeight?: number;
  /** `'scroll'` lets the children exceed the box along the main axis and scroll; `'hidden'` clips. Default `'visible'`. */
  overflow?: 'visible' | 'hidden' | 'scroll';
  /**
   * In a `'row'`, children that do not fit move onto new lines below, as tag lists and toolbars reflow. Each line shares
   * its own free space (`grow`, `shrink`, `justify`) and is as tall as its tallest child, which `align` places
   * children within; the row gap of `gap` separates the lines, and `overflow: 'scroll'` scrolls them vertically.
   * Columns ignore it. Default false.
   */
  wrap?: boolean;
}

/** What {@link arrange} needs from a box. {@link Widget} implements it; tests can use plain objects. */
export interface LayoutNode {
  readonly style: LayoutStyle;
  readonly children: readonly LayoutNode[];
  /** False takes the box out of the layout entirely. Default true. */
  readonly visible?: boolean;
  /**
   * Content size (without padding) of a leaf box wrapped to at most `maxWidth`.
   * Return the same size for the same width during one arrange call; repeated constraints share one measurement.
   */
  measure?(maxWidth: number): { width: number; height: number };
  /** Written by {@link arrange}. */
  rect: Rect;
  /** Scroll offset in UI units, clamped by {@link arrange}. */
  scrollX?: number;
  /** Scroll offset in UI units, clamped by {@link arrange}. */
  scrollY?: number;
  /** Written by {@link arrange}: the size of the children's extent along the scrolling axis. */
  contentWidth?: number;
  /** Written by {@link arrange}. */
  contentHeight?: number;
}

type Insets = readonly [number, number, number, number];
const ZERO: Insets = [0, 0, 0, 0];

/** Expand {@link Edges} to `[top, right, bottom, left]`. Throws a TypeError or RangeError for anything else. */
export function edges(value: Edges | undefined): Insets {
  if (value === undefined) return ZERO;
  const list = typeof value === 'number' ? [value] : value;
  if (!Array.isArray(list) || ![1, 2, 4].includes(list.length) || list.some((n) => typeof n !== 'number'))
    throw typeError('Edges are a number, [vertical, horizontal] or [top, right, bottom, left]', 'ui');
  if (list.some((n) => !Number.isFinite(n) || n < -1e6 || n > 1e6))
    throw rangeError('Edges must be finite numbers within 1e6 UI units', 'ui');
  if (list.length === 1) return [list[0], list[0], list[0], list[0]];
  if (list.length === 2) return [list[0], list[1], list[0], list[1]];
  return list as unknown as Insets;
}

/** Check a style, throwing a TypeError or RangeError that names the field. Returns it unchanged. */
export function validateStyle(style: LayoutStyle): LayoutStyle {
  const size = (name: string, value: unknown) => {
    if (value === undefined || value === 'auto' || value === 'fill') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) throw rangeError(`${name} must be finite and not negative`, 'ui');
      return;
    }
    if (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value)) return;
    throw typeError(`${name} is a number, 'auto', 'fill' or a percentage such as '50%'`, 'ui');
  };
  size('width', style.width);
  size('height', style.height);
  for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'cellWidth', 'cellHeight'] as const) {
    const value = style[key];
    if (value !== undefined && (typeof value !== 'number' || !(value >= 0)))
      throw rangeError(`${key} must be a number of at least 0`, 'ui');
  }
  for (const key of ['grow', 'shrink'] as const) {
    const value = style[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
      throw rangeError(`${key} must be a finite number of at least 0`, 'ui');
  }
  if (style.columns !== undefined && (!Number.isInteger(style.columns) || style.columns < 1))
    throw rangeError('columns must be an integer of at least 1', 'ui');
  const gap = style.gap;
  if (gap !== undefined) {
    const parts = typeof gap === 'number' ? [gap] : gap;
    if (!Array.isArray(parts) || parts.length > 2 || parts.some((n) => !Number.isFinite(n) || n < 0))
      throw rangeError('gap is a number of at least 0 or [column gap, row gap]', 'ui');
  }
  if (style.wrap !== undefined && typeof style.wrap !== 'boolean') throw typeError('wrap is true or false', 'ui');
  if (style.offset !== undefined && (style.offset.length !== 2 || style.offset.some((n) => !Number.isFinite(n))))
    throw rangeError('offset is [x, y] in finite UI units', 'ui');
  edges(style.padding);
  edges(style.margin);
  return style;
}

const isRow = (node: LayoutNode) => node.style.direction === 'row';
const percent = (size: Size | undefined): number | undefined =>
  typeof size === 'string' && size.endsWith('%') ? Number.parseFloat(size) / 100 : undefined;
const explicit = (size: Size | undefined, avail: number): number | undefined =>
  typeof size === 'number'
    ? size
    : percent(size) !== undefined && Number.isFinite(avail)
      ? percent(size)! * avail
      : undefined;
const clamp = (value: number, min: number | undefined, max: number | undefined) =>
  Math.max(min ?? 0, Math.min(max ?? Infinity, value));
const gaps = (style: LayoutStyle): [number, number] =>
  typeof style.gap === 'number' ? [style.gap, style.gap] : [style.gap?.[0] ?? 0, style.gap?.[1] ?? style.gap?.[0] ?? 0];
const flowChildren = (node: LayoutNode): LayoutNode[] =>
  node.children.filter(
    (c) => c.visible !== false && c.style.position !== 'absolute' && node.style.direction !== 'stack',
  );
const floating = (node: LayoutNode): LayoutNode[] =>
  node.children.filter(
    (c) => c.visible !== false && (c.style.position === 'absolute' || node.style.direction === 'stack'),
  );
const horizontal = (m: Insets) => m[1] + m[3];
const vertical = (m: Insets) => m[0] + m[2];

type SizeCache = Map<LayoutNode, Map<number, Size2>>;

interface Size2 {
  width: number;
  height: number;
}

/** Width of `node` (border box) when `avail` is the most it may take: explicit, or its content plus padding. */
function contentOf(cache: SizeCache, node: LayoutNode, innerWidth: number): Size2 {
  let sizes = cache.get(node);
  const previous = sizes?.get(innerWidth);
  if (previous) return previous;
  const content = measureContent(cache, node, innerWidth);
  if (!sizes) cache.set(node, (sizes = new Map()));
  sizes.set(innerWidth, content);
  return content;
}

function measureContent(cache: SizeCache, node: LayoutNode, innerWidth: number): Size2 {
  const style = node.style,
    flow = flowChildren(node),
    over = floating(node);
  if (!flow.length && !over.length) {
    const size = node.measure?.(innerWidth);
    return { width: size?.width ?? 0, height: size?.height ?? 0 };
  }
  const [gx, gy] = gaps(style);
  if (style.direction === 'stack' || (!flow.length && over.length)) {
    let width = 0,
      height = 0;
    for (const child of over) {
      const m = edges(child.style.margin),
        size = sizeOf(cache, child, innerWidth - horizontal(m));
      width = Math.max(width, size.width + horizontal(m));
      height = Math.max(height, size.height + vertical(m));
    }
    return { width, height };
  }
  if (style.direction === 'grid') {
    const cols = style.columns ?? 1,
      sizes = flow.map((c) => {
        const m = edges(c.style.margin),
          size = sizeOf(cache, c, innerWidth);
        return { width: size.width + horizontal(m), height: size.height + vertical(m) };
      }),
      cellW = style.cellWidth ?? Math.max(0, ...sizes.map((s) => s.width)),
      cellH = style.cellHeight ?? Math.max(0, ...sizes.map((s) => s.height)),
      rows = Math.ceil(flow.length / cols);
    return { width: cols * cellW + (cols - 1) * gx, height: rows * cellH + Math.max(0, rows - 1) * gy };
  }
  const row = isRow(node);
  if (row && style.wrap && Number.isFinite(innerWidth)) {
    const lines = wrapLines(flexItems(cache, node, flow, innerWidth, Infinity), innerWidth, gx);
    let width = 0,
      height = 0;
    for (const line of lines) {
      width = Math.max(width, distribute(line, innerWidth, gx, true, false));
      height += lineHeight(cache, line, Infinity);
    }
    return { width, height: height + gy * (lines.length - 1) };
  }
  let main = 0,
    cross = 0;
  for (const child of flow) {
    const m = edges(child.style.margin),
      size = sizeOf(cache, child, innerWidth - (row ? 0 : horizontal(m)));
    main += (row ? size.width + horizontal(m) : size.height + vertical(m)) + (row ? gx : gy);
    cross = Math.max(cross, row ? size.height + vertical(m) : size.width + horizontal(m));
  }
  main -= row ? gx : gy;
  return row ? { width: main, height: cross } : { width: cross, height: main };
}

/** The border-box size of `node` when at most `availWidth` is available (Infinity when unbounded). */
function sizeOf(cache: SizeCache, node: LayoutNode, availWidth: number, forcedWidth?: number): Size2 {
  const s = node.style,
    p = edges(s.padding);
  let width = forcedWidth ?? explicit(s.width, availWidth);
  const fixedWidth = width !== undefined;
  const innerWidth = Math.max(0, (width ?? availWidth) - horizontal(p));
  const content = contentOf(cache, node, innerWidth);
  width = clamp(fixedWidth ? width! : content.width + horizontal(p), s.minWidth, s.maxWidth);
  let height = explicit(s.height, Infinity);
  height = clamp(height ?? content.height + vertical(p), s.minHeight, s.maxHeight);
  return { width, height };
}

/** Height of `node` when laid out `width` wide. */
function heightAt(cache: SizeCache, node: LayoutNode, width: number): number {
  return sizeOf(cache, node, width, width).height;
}

/**
 * Lay out the tree below `root` into `box` and write every node's `rect` (absolute UI units, y down). The algorithm
 * is a small flexbox: children of a row or column take their base size, then free space is shared by `grow` and
 * a shortage by `shrink`, then `justify` and `align` place them. A stack anchors its children, and a grid fills cells
 * row by row. Measurements are memoized only within this call, so edits are visible on the next call.
 */
export function arrange(root: LayoutNode, box: Rect): void {
  place(new Map(), root, box.x, box.y, box.width, box.height);
}

function place(cache: SizeCache, node: LayoutNode, x: number, y: number, width: number, height: number): void {
  node.rect = { x, y, width, height };
  const s = node.style,
    p = edges(s.padding),
    inner: Rect = {
      x: x + p[3],
      y: y + p[0],
      width: Math.max(0, width - horizontal(p)),
      height: Math.max(0, height - vertical(p)),
    };
  node.contentWidth = inner.width;
  node.contentHeight = inner.height;
  const flow = flowChildren(node);
  if (s.direction === 'grid') placeGrid(cache, node, flow, inner);
  else if (flow.length) placeFlex(cache, node, flow, inner);
  for (const child of floating(node)) placeAnchored(cache, node, child, inner, { x, y, width, height });
  for (const child of node.children) {
    if (child.visible === false) child.rect = { x, y, width: 0, height: 0 };
    const o = child.style.offset;
    if (o && child.visible !== false) translate(child, o[0], o[1]);
  }
}

/** Move a laid-out subtree by (dx, dy) UI units, for placing a box after the layout. */
export function translate(node: LayoutNode, dx: number, dy: number): void {
  if (!dx && !dy) return;
  node.rect = { ...node.rect, x: node.rect.x + dx, y: node.rect.y + dy };
  for (const child of node.children) translate(child, dx, dy);
}

function placeGrid(cache: SizeCache, node: LayoutNode, flow: LayoutNode[], inner: Rect): void {
  const s = node.style,
    [gx, gy] = gaps(s),
    cols = s.columns ?? 1,
    sizes = flow.map((c) => {
      const m = edges(c.style.margin),
        size = sizeOf(cache, c, inner.width);
      return { width: size.width + horizontal(m), height: size.height + vertical(m) };
    }),
    cellW = s.cellWidth ?? Math.max(0, ...sizes.map((z) => z.width)),
    cellH = s.cellHeight ?? Math.max(0, ...sizes.map((z) => z.height)),
    rows = Math.ceil(flow.length / cols),
    total = rows * cellH + Math.max(0, rows - 1) * gy;
  const scroll = scrollOf(node, total, inner.height, 'y');
  node.contentHeight = total;
  flow.forEach((child, i) => {
    const m = edges(child.style.margin),
      cx = inner.x + (i % cols) * (cellW + gx),
      cy = inner.y + Math.floor(i / cols) * (cellH + gy) - scroll;
    const w = cellW - horizontal(m),
      h = cellH - vertical(m);
    place(cache, child, cx + m[3], cy + m[0], Math.max(0, w), Math.max(0, h));
  });
}

function scrollOf(node: LayoutNode, content: number, view: number, axis: 'x' | 'y'): number {
  if (node.style.overflow !== 'scroll') return 0;
  const key = axis === 'x' ? 'scrollX' : 'scrollY',
    max = Math.max(0, content - view),
    value = Math.max(0, Math.min(max, node[key] ?? 0));
  node[key] = value;
  return value;
}

interface Item {
  child: LayoutNode;
  m: Insets;
  base: number;
  min: number;
  max: number;
  grow: number;
  shrink: number;
  size: number;
}

const alignOf = (node: LayoutNode): Align => node.style.align ?? (isRow(node) ? 'center' : 'stretch');

/** Flex items of `flow` with their base sizes along `node`'s main axis. */
function flexItems(cache: SizeCache, node: LayoutNode, flow: LayoutNode[], innerMain: number, innerCross: number): Item[] {
  const row = isRow(node),
    parentAlign = alignOf(node);
  return flow.map((child) => {
    const cs = child.style,
      m = edges(cs.margin),
      mainStyle = row ? cs.width : cs.height,
      mainMargin = row ? horizontal(m) : vertical(m),
      crossMargin = row ? vertical(m) : horizontal(m);
    let base: number;
    const px = explicit(mainStyle, innerMain);
    if (px !== undefined) base = px;
    else if (mainStyle === 'fill') base = 0;
    else if (row) base = sizeOf(cache, child, Math.max(0, innerMain - mainMargin)).width;
    else {
      const align = cs.alignSelf && cs.alignSelf !== 'auto' ? cs.alignSelf : parentAlign;
      const cw =
        explicit(cs.width, innerCross) ??
        (align === 'stretch' || cs.width === 'fill' ? innerCross - crossMargin : undefined);
      base =
        cw === undefined
          ? sizeOf(cache, child, innerCross - crossMargin).height
          : heightAt(cache, child, clamp(cw, cs.minWidth, cs.maxWidth));
    }
    return {
      child,
      m,
      base: clamp(base, row ? cs.minWidth : cs.minHeight, row ? cs.maxWidth : cs.maxHeight),
      min: (row ? cs.minWidth : cs.minHeight) ?? 0,
      max: (row ? cs.maxWidth : cs.maxHeight) ?? Infinity,
      grow: cs.grow ?? (mainStyle === 'fill' ? 1 : 0),
      shrink: cs.shrink ?? 1,
      size: 0,
    };
  });
}

/** Break a wrapping row's items into lines no wider than `innerMain`; an item wider than that has a line to itself. */
function wrapLines(items: Item[], innerMain: number, gap: number): Item[][] {
  const lines: Item[][] = [];
  let line: Item[] = [],
    width = 0;
  for (const it of items) {
    const w = it.base + horizontal(it.m);
    if (line.length && width + gap + w > innerMain + 1e-9) {
      lines.push(line);
      line = [];
      width = 0;
    }
    width += (line.length ? gap : 0) + w;
    line.push(it);
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Height of a wrapped line: its tallest child at the width it was given, margins included. */
function lineHeight(cache: SizeCache, line: Item[], innerHeight: number): number {
  let height = 0;
  for (const it of line) {
    const cs = it.child.style,
      own = explicit(cs.height, innerHeight) ?? heightAt(cache, it.child, it.size);
    height = Math.max(height, clamp(own, cs.minHeight, cs.maxHeight) + vertical(it.m));
  }
  return height;
}

/**
 * Share the free main-axis space (`grow`) or the shortage (`shrink`) among `items`; returns the space they use.
 * Follows CSS Flexible Box Layout Level 1, section 9.7 "Resolving Flexible Lengths": shrink weights are scaled by
 * the base size, factors summing below 1 take only that fraction of the free space, and an item clamped by its min
 * or max is frozen while the space it could not take goes round the others again.
 */
function distribute(items: Item[], innerMain: number, gap: number, row: boolean, scrolling: boolean): number {
  const margins = (it: Item) => (row ? horizontal(it.m) : vertical(it.m));
  const outer = items.reduce((sum, it) => sum + margins(it), 0) + gap * (items.length - 1);
  const natural = items.reduce((sum, it) => sum + it.base, outer);
  const initial = scrolling ? Math.max(0, innerMain - natural) : innerMain - natural;
  const growing = initial > 0;
  const factor = (it: Item) => (growing ? it.grow : it.shrink);
  for (const it of items) it.size = it.base;
  // Step 2: with no free space, or a zero factor, an item keeps its base size.
  const frozen = new Set(items.filter((it) => initial === 0 || !(factor(it) > 0)));
  while (frozen.size < items.length) {
    const open = items.filter((it) => !frozen.has(it));
    // Step 4b: the free space left after frozen sizes and open base sizes, capped by a factor sum below 1.
    let free = innerMain - items.reduce((sum, it) => sum + (frozen.has(it) ? it.size : it.base), outer);
    const factors = open.reduce((sum, it) => sum + factor(it), 0);
    if (factors < 1 && Math.abs(initial * factors) < Math.abs(free)) free = initial * factors;
    // Step 4c: grow by the grow ratio, shrink by the scaled shrink factor (shrink times base size).
    const weight = (it: Item) => (growing ? it.grow : it.shrink * it.base);
    const total = open.reduce((sum, it) => sum + weight(it), 0);
    const targets = open.map((it) => it.base + (total > 0 ? (free * weight(it)) / total : 0));
    let violation = 0;
    open.forEach((it, i) => {
      it.size = Math.max(it.min, Math.min(it.max, targets[i]));
      violation += it.size - targets[i];
    });
    // Step 4d: no clamp freezes everything; otherwise freeze the min (positive) or max (negative) violators.
    open.forEach((it, i) => {
      const moved = it.size - targets[i];
      if (Math.abs(violation) < 1e-9 || (violation > 0 && moved > 0) || (violation < 0 && moved < 0)) frozen.add(it);
    });
  }
  return items.reduce((sum, it) => sum + it.size, outer);
}

function placeFlex(cache: SizeCache, node: LayoutNode, flow: LayoutNode[], inner: Rect): void {
  const s = node.style,
    row = isRow(node),
    [gx, gy] = gaps(s),
    gap = row ? gx : gy,
    innerMain = row ? inner.width : inner.height,
    items = flexItems(cache, node, flow, innerMain, row ? inner.height : inner.width);
  if (row && s.wrap) {
    // Each line is a row of its own; the lines stack down by the row gap and scroll vertically.
    const lines = wrapLines(items, innerMain, gx),
      used = lines.map((line) => distribute(line, innerMain, gx, true, false)),
      heights = lines.map((line) => lineHeight(cache, line, inner.height)),
      total = heights.reduce((sum, h) => sum + h, 0) + gy * (lines.length - 1),
      scroll = scrollOf(node, total, inner.height, 'y');
    node.contentHeight = total;
    let y = inner.y - scroll;
    lines.forEach((line, i) => {
      placeLine(cache, node, line, { x: inner.x, y, width: inner.width, height: heights[i] }, used[i], 0);
      y += heights[i] + gy;
    });
    return;
  }
  const used = distribute(items, innerMain, gap, row, s.overflow === 'scroll');
  const scroll = scrollOf(node, used, innerMain, row ? 'x' : 'y');
  if (row) node.contentWidth = used;
  else node.contentHeight = used;
  placeLine(cache, node, items, inner, used, scroll);
}

/** Place one line of sized items along `node`'s main axis inside `inner`, by `justify` and `align`. */
function placeLine(cache: SizeCache, node: LayoutNode, items: Item[], inner: Rect, used: number, scroll: number): void {
  const s = node.style,
    row = isRow(node),
    [gx, gy] = gaps(s),
    gap = row ? gx : gy,
    innerMain = row ? inner.width : inner.height,
    innerCross = row ? inner.height : inner.width,
    parentAlign = alignOf(node),
    margins = (it: Item) => (row ? horizontal(it.m) : vertical(it.m)),
    free = Math.max(0, innerMain - used);
  let start = 0,
    between = gap;
  const n = items.length;
  switch (s.justify ?? 'start') {
    case 'center':
      start = free / 2;
      break;
    case 'end':
      start = free;
      break;
    case 'space-between':
      if (n > 1) between = gap + free / (n - 1);
      break;
    case 'space-around':
      start = free / n / 2;
      between = gap + free / n;
      break;
    case 'space-evenly':
      start = free / (n + 1);
      between = gap + free / (n + 1);
      break;
  }
  let cursor = start - scroll;
  for (const it of items) {
    const cs = it.child.style,
      align = cs.alignSelf && cs.alignSelf !== 'auto' ? cs.alignSelf : parentAlign,
      crossMargin = row ? vertical(it.m) : horizontal(it.m),
      crossStyle = row ? cs.height : cs.width,
      crossMin = row ? cs.minHeight : cs.minWidth,
      crossMax = row ? cs.maxHeight : cs.maxWidth,
      space = Math.max(0, innerCross - crossMargin);
    let cross: number;
    const fixed = explicit(crossStyle, innerCross);
    if (fixed !== undefined) cross = fixed;
    else if (crossStyle === 'fill' || align === 'stretch') cross = space;
    else cross = row ? heightAt(cache, it.child, it.size) : sizeOf(cache, it.child, space).width;
    if (row && fixed === undefined && crossStyle !== 'fill' && align !== 'stretch') cross = heightAt(cache, it.child, it.size);
    cross = clamp(cross, crossMin, crossMax);
    const crossPos = align === 'center' ? (space - cross) / 2 : align === 'end' ? space - cross : 0;
    const mainStart = (row ? inner.x : inner.y) + cursor + (row ? it.m[3] : it.m[0]),
      crossStart = (row ? inner.y : inner.x) + crossPos + (row ? it.m[0] : it.m[3]);
    if (row) place(cache, it.child, mainStart, crossStart, it.size, cross);
    else place(cache, it.child, crossStart, mainStart, cross, it.size);
    cursor += it.size + margins(it) + between;
  }
}

function placeAnchored(cache: SizeCache, parent: LayoutNode, child: LayoutNode, inner: Rect, outer: Rect): void {
  const cs = child.style,
    m = edges(cs.margin),
    anchor: Anchor = cs.anchor ?? 'stretch',
    box = cs.bleed && parent.style.direction === 'stack' ? outer : inner,
    availW = Math.max(0, box.width - horizontal(m)),
    availH = Math.max(0, box.height - vertical(m));
  const stretch = anchor === 'stretch';
  const fillW = cs.width === 'fill' || (stretch && (cs.width === undefined || cs.width === 'auto'));
  const fillH = cs.height === 'fill' || (stretch && (cs.height === undefined || cs.height === 'auto'));
  let width = fillW ? availW : (explicit(cs.width, box.width) ?? sizeOf(cache, child, availW).width);
  width = clamp(width, cs.minWidth, cs.maxWidth);
  let height = fillH ? availH : explicit(cs.height, box.height);
  height = clamp(height ?? heightAt(cache, child, width), cs.minHeight, cs.maxHeight);
  const left = anchor.includes('left'),
    right = anchor.includes('right'),
    top = anchor.includes('top'),
    bottom = anchor.includes('bottom');
  const px = left ? 0 : right ? availW - width : stretch ? 0 : (availW - width) / 2,
    py = top ? 0 : bottom ? availH - height : stretch ? 0 : (availH - height) / 2;
  place(cache, child, box.x + m[3] + px, box.y + m[0] + py, width, height);
}
