/**
 * Screens described in markup and a style sheet, so designers can edit a menu or a HUD without code:
 * `<panel class="hud"><label id="gold">1,250</label></panel>` plus `.hud { direction: row; gap: 12 }`.
 * The markup is a small XML subset (elements, attributes, text, comments, the five named and numeric character
 * references); the style sheet is rules of type, `#id` and `.class` selectors with descendant and `>` child
 * combinators, applied by specificity and then source order, with attributes on the element winning over the sheet.
 */
import { fault, typeError } from '../../shared/errors.js';
import { Label, Panel } from './basic.js';
import { List, Menu, type ListEntry, type MenuItem } from './collections.js';
import { Button, Slider, Toggle } from './controls.js';
import { HealthBar, ProgressBar } from './meters.js';
import type { UiEvent, Widget } from './widget.js';

/** An element of parsed markup. */
export interface MarkupElement {
  tag: string;
  attributes: Record<string, string>;
  children: MarkupElement[];
  /** The element's own text, whitespace collapsed. */
  text: string;
  line: number;
  column: number;
}

/** One declaration of a style rule. */
export interface StyleDeclaration {
  property: string;
  value: string;
  line: number;
}

/** A parsed style rule: one selector of a list, with its specificity and place in the sheet. */
export interface StyleRule {
  selector: string;
  specificity: readonly [number, number, number];
  order: number;
  declarations: StyleDeclaration[];
  /** @internal */
  parts: SelectorPart[];
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
}
/** @internal A compound and the combinator that joins it to the compound on its left. */
export interface SelectorPart {
  compound: Compound;
  combinator: ' ' | '>' | null;
}

/** Options for {@link buildScreen}. */
export interface ScreenOptions {
  /** Style sheet text, or several applied in order (a later sheet wins a tie). */
  styles?: string | readonly string[];
  /** Handlers named by `on-click`, `on-change` and `on-select` attributes. */
  actions?: Readonly<Record<string, (event: UiEvent) => void>>;
}

/** Options for {@link loadScreen}: the same as {@link ScreenOptions}, with style sheet URLs and an abort signal. */
export interface LoadScreenOptions extends Omit<ScreenOptions, 'styles'> {
  /** Style sheet URLs, fetched beside the markup. */
  styles?: string | readonly string[];
  signal?: AbortSignal;
}

/** The widgets a markup file built. */
export interface Screen {
  /** The top-level widgets, in markup order: add them to a `Ui` or a panel. */
  readonly widgets: readonly Widget[];
  /** The widget with an `id` attribute. */
  get(id: string): Widget | undefined;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function where(source: string, at: number): { line: number; column: number } {
  let line = 1,
    start = 0;
  for (let i = source.indexOf('\n'); i >= 0 && i < at; i = source.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, column: at - start + 1 };
}
/** Throw a TypeError naming the line and column of `at` in a markup file, or with `what` 'Style', a style sheet. */
function fail(source: string, at: number, message: string, what: 'Markup' | 'Style' = 'Markup'): never {
  const { line, column } = where(source, at);
  throw typeError(`${what} line ${line}, column ${column}: ${message}`, 'ui');
}
function decode(source: string, text: string, at: number): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);|&/g, (match, ref: string | undefined) => {
    if (!ref) fail(source, at, "a bare '&' must be written &amp;");
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // XML 1.0 section 2.2, production [2] Char: tab, newline, return and the planes without surrogates or U+FFFE/F.
      const char =
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff);
      if (!char) fail(source, at, `${match} is not an XML character; write a code point XML 1.0 allows`);
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref];
    if (named === undefined)
      fail(source, at, `unknown reference ${match}; use &lt; &gt; &amp; &quot; &apos; or a number`);
    return named;
  });
}

const NAME = /[A-Za-z_][\w.-]*/y;
const SPACE = /\s*/y;

/**
 * Parse markup into elements.
 * @throws TypeError naming the line and column of the first error (unclosed or mismatched tags, a bad attribute).
 */
export function parseMarkup(source: string): MarkupElement[] {
  if (typeof source !== 'string') throw typeError('parseMarkup takes the markup text', 'ui');
  const roots: MarkupElement[] = [],
    stack: MarkupElement[] = [];
  let i = 0;
  const skip = () => {
    SPACE.lastIndex = i;
    SPACE.exec(source);
    i = SPACE.lastIndex;
  };
  const name = (what: string): string => {
    NAME.lastIndex = i;
    const m = NAME.exec(source);
    if (!m) fail(source, i, `expected ${what}`);
    i = NAME.lastIndex;
    return m[0];
  };
  const addText = (raw: string, at: number) => {
    const text = decode(source, raw, at).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const parent = stack.at(-1);
    if (!parent) fail(source, at, 'text outside an element');
    parent.text = parent.text ? `${parent.text} ${text}` : text;
  };
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      addText(source.slice(i), i);
      break;
    }
    if (lt > i) addText(source.slice(i, lt), i);
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) fail(source, i, 'a comment is not closed with -->');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0) fail(source, i, 'a <? declaration is not closed with ?>');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', i)) fail(source, i, 'document type declarations and CDATA are not supported');
    if (source[i + 1] === '/') {
      const at = i;
      i += 2;
      const tag = name('a closing tag name');
      skip();
      if (source[i] !== '>') fail(source, i, `expected > to close </${tag}`);
      i++;
      const open = stack.pop();
      if (!open) fail(source, at, `</${tag}> closes nothing`);
      if (open.tag !== tag) fail(source, at, `</${tag}> closes <${open.tag}> from line ${open.line}`);
      continue;
    }
    const at = i;
    i++;
    const tag = name('a tag name'),
      attributes: Record<string, string> = {};
    for (;;) {
      skip();
      if (source.startsWith('/>', i) || source[i] === '>') break;
      if (i >= source.length) fail(source, at, `<${tag}> is not closed with >`);
      const attrAt = i,
        key = name('an attribute name');
      skip();
      if (source[i] !== '=') fail(source, i, `attribute ${key} needs ="value"`);
      i++;
      skip();
      const quote = source[i];
      if (quote !== '"' && quote !== "'") fail(source, i, `the value of ${key} must be in quotes`);
      const end = source.indexOf(quote, i + 1);
      if (end < 0) fail(source, i, `the value of ${key} is not closed`);
      if (key in attributes) fail(source, attrAt, `attribute ${key} is given twice`);
      attributes[key] = decode(source, source.slice(i + 1, end), i);
      i = end + 1;
    }
    const { line, column } = where(source, at);
    const element: MarkupElement = { tag, attributes, children: [], text: '', line, column };
    (stack.at(-1)?.children ?? roots).push(element);
    if (source[i] === '/') i += 2;
    else {
      i++;
      stack.push(element);
    }
  }
  const open = stack.pop();
  if (open) fail(source, source.length, `<${open.tag}> from line ${open.line} is not closed`);
  return roots;
}

/**
 * Parse a style sheet into rules, one per selector of each rule's selector list.
 * @throws TypeError naming the line of the first error (an unsupported selector, a declaration without a colon).
 */
export function parseStyleSheet(source: string, order = 0): StyleRule[] {
  if (typeof source !== 'string') throw typeError('parseStyleSheet takes the style sheet text', 'ui');
  // Comments become spaces of the same length, so positions (and so line numbers) stay true.
  const text = source.replace(/\/\*[\s\S]*?(\*\/|$)/g, (c) => c.replace(/[^\n]/g, ' '));
  const rules: StyleRule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) {
      if (text.slice(i).trim()) fail(source, i, 'a selector without a { block }', 'Style');
      break;
    }
    const close = text.indexOf('}', open);
    if (close < 0) fail(source, open, 'a rule is not closed with }', 'Style');
    const selectors = text.slice(i, open);
    if (selectors.includes('}')) fail(source, i + selectors.indexOf('}'), 'a } without a rule', 'Style');
    const declarations: StyleDeclaration[] = [];
    let at = open + 1;
    for (const part of text.slice(open + 1, close).split(';')) {
      if (part.trim()) {
        const colon = part.indexOf(':'),
          line = where(source, at + part.search(/\S/)).line;
        if (colon < 0) fail(source, at, `declaration '${part.trim()}' needs property: value`, 'Style');
        const property = part.slice(0, colon).trim(),
          value = part.slice(colon + 1).trim();
        if (!/^[a-z][a-z0-9-]*$/i.test(property)) fail(source, at, `'${property}' is not a property name`, 'Style');
        if (!value) fail(source, at, `${property} has no value`, 'Style');
        declarations.push({ property, value, line });
      }
      at += part.length + 1;
    }
    let from = i;
    for (const raw of selectors.split(',')) {
      const selector = raw.trim().replace(/\s+/g, ' ');
      if (!selector) fail(source, from, 'an empty selector', 'Style');
      const parts = parseSelector(selector, source, from);
      const specificity: [number, number, number] = [0, 0, 0];
      for (const { compound } of parts) {
        if (compound.id) specificity[0]++;
        specificity[1] += compound.classes.length;
        if (compound.tag) specificity[2]++;
      }
      rules.push({ selector, specificity, order: order + rules.length, declarations, parts });
      from += raw.length + 1;
    }
    i = close + 1;
  }
  return rules;
}

const COMPOUND = /^(\*|[A-Za-z][\w-]*)?((?:[#.][A-Za-z_][\w-]*)*)$/;
function parseSelector(selector: string, source: string, at: number): SelectorPart[] {
  const tokens = selector
    .replace(/\s*>\s*/g, ' > ')
    .split(' ')
    .filter(Boolean);
  const parts: SelectorPart[] = [];
  let combinator: ' ' | '>' | null = null;
  for (const token of tokens) {
    if (token === '>') {
      if (!parts.length || combinator === '>')
        fail(source, at, `'${selector}': > needs a selector on each side`, 'Style');
      combinator = '>';
      continue;
    }
    const m = COMPOUND.exec(token);
    if (!m)
      fail(
        source,
        at,
        `'${selector}': only type, #id and .class selectors joined by spaces or > are supported, not '${token}'`,
        'Style',
      );
    const tag = m[1] && m[1] !== '*' ? m[1] : null,
      id = m[2].match(/#[\w-]+/g),
      classes = (m[2].match(/\.[\w-]+/g) ?? []).map((c) => c.slice(1));
    if (id && id.length > 1) fail(source, at, `'${selector}' names two ids`, 'Style');
    parts.push({
      compound: { tag, id: id ? id[0].slice(1) : null, classes },
      combinator: parts.length ? (combinator ?? ' ') : null,
    });
    combinator = null;
  }
  if (combinator) fail(source, at, `'${selector}' ends with >`, 'Style');
  return parts;
}

const matchesCompound = (c: Compound, e: MarkupElement): boolean => {
  if (c.tag && c.tag !== e.tag) return false;
  if (c.id && c.id !== e.attributes.id) return false;
  if (!c.classes.length) return true;
  const own = (e.attributes.class ?? '').split(/\s+/);
  return c.classes.every((name) => own.includes(name));
};
/** Whether `rule` selects `element`, whose ancestors are `path` (nearest last). */
function matches(rule: StyleRule, element: MarkupElement, path: readonly MarkupElement[]): boolean {
  const parts = rule.parts;
  const from = (k: number, e: MarkupElement, depth: number): boolean => {
    if (!matchesCompound(parts[k].compound, e)) return false;
    if (k === 0) return true;
    if (parts[k].combinator === '>') return depth > 0 && from(k - 1, path[depth - 1], depth - 1);
    for (let d = depth - 1; d >= 0; d--) if (from(k - 1, path[d], d)) return true;
    return false;
  };
  return from(parts.length - 1, element, path.length);
}

// Properties by the kind of value they take; kebab-case in markup and sheets, camelCase in the options.
const STRINGS = new Set([
  'id',
  'text',
  'label',
  'description',
  'tooltip',
  'icon',
  'title',
  'variant',
  'display',
  'background',
  'color',
  'direction',
  'align',
  'justify',
  'anchor',
  'position',
  'overflow',
  'alignSelf',
  'pointerEvents',
  'detail',
]);
const NUMBERS = new Set([
  'grow',
  'shrink',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'columns',
  'cellWidth',
  'cellHeight',
  'radius',
  'value',
  'min',
  'max',
  'step',
  'selected',
]);
const BOOLEANS = new Set([
  'visible',
  'enabled',
  'border',
  'shadow',
  'bleed',
  'wrap',
  'checked',
  'showValue',
  'smooth',
  'trail',
  'outline',
  'disabled',
]);
const SIZES = new Set(['width', 'height']);
const LISTS: Record<string, readonly number[]> = { padding: [1, 2, 4], margin: [1, 2, 4], gap: [1, 2], offset: [2] };
const EVENTS: Record<string, string> = { 'on-click': 'onClick', 'on-change': 'onChange', 'on-select': 'onSelect' };

const camel = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;

function convert(property: string, value: string, context: string): unknown {
  const key = camel(property);
  const bad = (what: string): never => {
    throw typeError(`${context}: ${property} takes ${what}, not '${value}'`, 'ui');
  };
  if (STRINGS.has(key)) return value;
  if (key === 'size') return NUMBER.test(value) ? Number(value) : value;
  if (NUMBERS.has(key)) return NUMBER.test(value) ? Number(value) : bad('a number');
  if (BOOLEANS.has(key)) return value === 'true' ? true : value === 'false' ? false : bad('true or false');
  if (SIZES.has(key)) return NUMBER.test(value) ? Number(value) : value;
  const counts = LISTS[key];
  if (counts) {
    const parts = value.split(/\s+/);
    if (!counts.includes(parts.length) || !parts.every((p) => NUMBER.test(p)))
      bad(`${counts.join(' or ')} number${counts.at(-1) === 1 ? '' : 's'}`);
    const numbers = parts.map(Number);
    return numbers.length === 1 ? numbers[0] : numbers;
  }
  throw typeError(`${context}: unknown property ${property}; check its spelling against the widget's options`, 'ui');
}

type Build = (
  options: Record<string, unknown>,
  element: MarkupElement,
  items: Array<Record<string, unknown>>,
) => Widget;
const TEXT = (options: Record<string, unknown>, element: MarkupElement) =>
  element.text && options.text === undefined ? { ...options, text: element.text } : options;
const WIDGETS: Record<string, Build> = {
  panel: (o) => new Panel(o),
  row: (o) => new Panel({ direction: 'row', ...o }),
  column: (o) => new Panel({ direction: 'column', ...o }),
  label: (o, e) => new Label(TEXT(o, e)),
  button: (o, e) => new Button(TEXT(o, e)),
  toggle: (o, e) => new Toggle(TEXT(o, e)),
  slider: (o, e) => new Slider(TEXT(o, e)),
  progress: (o, e) => new ProgressBar(TEXT(o, e)),
  health: (o, e) => new HealthBar(TEXT(o, e)),
  list: (o, _e, items) => new List({ ...o, items: items as unknown as ListEntry[] }),
  menu: (o, _e, items) => new Menu({ ...o, items: items as unknown as MenuItem[] }),
};
const CONTAINERS = new Set(['panel', 'row', 'column']);

/**
 * Build the widgets of a markup screen, styled by `options.styles`.
 *
 * Elements: `panel`, `row` and `column` (panels laid out that way) hold other elements; `label`, `button`, `toggle`,
 * `slider`, `progress` and `health` take their text from their content; `list` and `menu` take `<item>` children
 * (`<item detail="20 g">Rope</item>`). Attributes and declarations are the widgets' options in kebab-case
 * (`min-width`, `show-value`); a list takes spaces (`padding: 8 16`). `class` names classes for the sheet,
 * `on-click`, `on-change` and `on-select` name a handler in `options.actions`.
 *
 * @throws TypeError naming the line of the first error: unknown element, property or action, or a bad value.
 * @example
 * const screen = buildScreen('<panel class="hud"><label id="gold">0</label></panel>', {
 *   styles: '.hud { direction: row; anchor: top-left; margin: 16 }',
 * });
 * ui.add(...screen.widgets);
 */
export function buildScreen(markup: string, options: ScreenOptions = {}): Screen {
  const sheets =
    options.styles === undefined ? [] : typeof options.styles === 'string' ? [options.styles] : options.styles;
  if (!Array.isArray(sheets) || !sheets.every((s) => typeof s === 'string'))
    throw typeError('styles is style sheet text or an array of them', 'ui');
  const actions = options.actions ?? {};
  const rules: StyleRule[] = [];
  for (const sheet of sheets) rules.push(...parseStyleSheet(sheet, rules.length));
  // The cascade: lower specificity first, then source order, so the last applied wins.
  rules.sort((a, b) => {
    for (let k = 0; k < 3; k++) if (a.specificity[k] !== b.specificity[k]) return a.specificity[k] - b.specificity[k];
    return a.order - b.order;
  });
  const byId = new Map<string, Widget>();
  const optionsOf = (element: MarkupElement, path: MarkupElement[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const rule of rules)
      if (matches(rule, element, path))
        for (const d of rule.declarations)
          out[camel(d.property)] = convert(d.property, d.value, `Style line ${d.line} (${rule.selector})`);
    for (const [name, value] of Object.entries(element.attributes)) {
      const context = `Markup line ${element.line}, <${element.tag}>`;
      if (name === 'class') continue;
      const event = EVENTS[name];
      if (event) {
        const handler = actions[value];
        if (typeof handler !== 'function')
          throw typeError(`${context}: ${name}="${value}" names no function in actions`, 'ui');
        out[event] = handler;
      } else out[camel(name)] = convert(name, value, context);
    }
    return out;
  };
  const build = (element: MarkupElement, path: MarkupElement[]): Widget => {
    const make = WIDGETS[element.tag];
    if (!make)
      throw typeError(
        `Markup line ${element.line}: unknown element <${element.tag}>; use ${Object.keys(WIDGETS).join(', ')}`,
        'ui',
      );
    const options = optionsOf(element, path),
      inner = [...path, element];
    const items: Array<Record<string, unknown>> = [];
    const kids: Widget[] = [];
    for (const child of element.children) {
      if (child.tag === 'item' && (element.tag === 'list' || element.tag === 'menu')) {
        const item = optionsOf(child, inner);
        item.label ??= child.text;
        if (element.tag === 'menu' && item.onSelect) {
          const select = item.onSelect as (event: UiEvent) => void;
          item.onSelect = () => select({ type: 'select', target: widget });
        }
        items.push(item);
      } else if (CONTAINERS.has(element.tag)) kids.push(build(child, inner));
      else throw typeError(`Markup line ${child.line}: <${element.tag}> cannot hold <${child.tag}>`, 'ui');
    }
    if (element.text && CONTAINERS.has(element.tag))
      throw typeError(`Markup line ${element.line}: <${element.tag}> holds elements, not text; use a <label>`, 'ui');
    const widget: Widget = make(options, element, items);
    if (kids.length) widget.add(...kids);
    const id = element.attributes.id;
    if (id) {
      if (byId.has(id)) throw typeError(`Markup line ${element.line}: id ${id} is used twice`, 'ui');
      byId.set(id, widget);
    }
    return widget;
  };
  const widgets = parseMarkup(markup).map((root) => build(root, []));
  return { widgets, get: (id: string) => byId.get(id) };
}

/**
 * Fetch a markup file and its style sheets (relative to the page) and build the screen.
 * @throws TypeError as {@link buildScreen}; rejects with the signal's reason when aborted, or on a failed fetch.
 */
export async function loadScreen(url: string | URL, options: LoadScreenOptions = {}): Promise<Screen> {
  const { styles, signal, ...rest } = options;
  const text = async (u: string | URL) => {
    const response = await fetch(u, { signal });
    if (!response.ok)
      throw fault('failed', `Could not fetch ${String(u)}: HTTP ${response.status}; check the URL`, 'ui');
    return response.text();
  };
  const urls = styles === undefined ? [] : typeof styles === 'string' ? [styles] : [...styles];
  const [markup, ...sheets] = await Promise.all([text(url), ...urls.map(text)]);
  signal?.throwIfAborted();
  return buildScreen(markup, { ...rest, styles: sheets });
}
