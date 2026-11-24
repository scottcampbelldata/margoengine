import { validateMachine, type MachineDocument, type RegionDocument, type StateDocument, type TransitionDocument } from './document.js';
import { parseXMLDocument, type XMLElement } from '../../shared/xml-document.js';

const NS = 'http://www.w3.org/2005/07/scxml';
const EXT = 'urn:margoengine:fsm:1';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const SYMBOL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const ID = /^[A-Za-z_][\w.-]*$/;
const MAX = 1048576;
function fail(message: string): never { throw new TypeError(`Unsupported SCXML: ${message}; use the documented document subset or native machine JSON`); }
const extension = (element: XMLElement, name: string) => element.getAttributeNS(EXT, name);
const nameOf = (element: XMLElement) => (extension(element, 'name') ?? element.getAttribute('id')) || fail('state has no id/name');
const children = (element: XMLElement): XMLElement[] => Array.from(element.children);
const standard = (element: XMLElement, name: string) => element.namespaceURI === NS && element.localName === name;
const stateElement = (element: XMLElement) => standard(element, 'state') || standard(element, 'parallel');

/** SCXML import options. */
export interface SCXMLImportOptions {
  /**
   * @deprecated Ignored. SCXML is read by Margo's own strict XML reader in browsers, workers and Node alike, so no DOM
   * parser is needed and file text is never parsed as HTML.
   */
  parser?: unknown;
}

/** SCXML output options. */
export interface SCXMLExportOptions {
  /** Preserve native delay, duration, update, region history and arbitrary names with namespaced extensions. Default true. */
  extensions?: boolean;
}

function attributes(element: XMLElement, allowed: string[], extra: string[] = []): void {
  for (const attr of Array.from(element.attributes)) {
    if (attr.namespaceURI === XMLNS) continue;
    if (attr.namespaceURI === EXT && extra.includes(attr.localName)) {
      if (['wrapper', 'regionHistory', 'stay'].includes(attr.localName) && !['true', 'false'].includes(attr.value)) fail('invalid native boolean');
      if (attr.localName === 'transitions' && attr.value !== 'empty') fail('invalid native transitions marker');
      continue;
    }
    if (!attr.namespaceURI && allowed.includes(attr.name)) continue;
    fail(`attribute ${attr.name} on ${element.localName}`);
  }
}

function binding(text: string): string {
  const value = text.trim().replace(/\(\)\s*;?$/, '');
  if (!SYMBOL.test(value)) fail('executable expressions are not binding names');
  return value;
}

/**
 * Convert the SCXML document subset into a validated native machine document, without running scripts or guards.
 * Supports hierarchy, initial states, parallel regions, history targets, named hooks/guards and event transitions.
 * Native extensions round-trip fields that SCXML cannot express directly. Rejects DTDs and unsupported content.
 */
export function importSCXML(text: string, options: SCXMLImportOptions = {}): MachineDocument {
  void options;
  if (typeof text !== 'string' || text.length > MAX || new TextEncoder().encode(text).byteLength > MAX || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))
    fail('input is over 1 MiB or contains a DTD/entity declaration');
  const root = parseXMLDocument(text, { fail: reason => fail(`malformed XML, ${reason}`) }).documentElement;
  if (!standard(root, 'scxml')) fail('wrong root element or namespace');
  const ids = new Set<string>();
  const stack: [XMLElement, number][] = [[root, 0]];
  let count = 0;
  while (stack.length) {
    const [element, depth] = stack.pop()!;
    if (++count > 10000 || depth > 128) fail('document exceeds 10,000 elements or 128 nesting levels');
    const id = element.getAttribute('id');
    if (id !== null) { if (!ID.test(id) || ids.has(id)) fail('duplicate or invalid XML id'); ids.add(id); }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 7) fail('processing instructions');
      if ((child.nodeType === 3 || child.nodeType === 4) && child.textContent?.trim() && !standard(element, 'script'))
        fail(`unexpected text in ${element.localName}`);
    }
    for (const child of children(element)) stack.push([child, depth + 1]);
  }
  attributes(root, ['version', 'initial', 'datamodel', 'name'], ['initial', 'transitions']);
  if (root.getAttribute('version') !== '1.0') fail('version must be 1.0');
  if (root.hasAttribute('datamodel') && !['null', 'ecmascript'].includes(root.getAttribute('datamodel')!)) fail('unknown datamodel');

  function readRegion(container: XMLElement, includeContainer = false): RegionDocument {
    if (!includeContainer && standard(container, 'state'))
      attributes(container, ['id', 'initial'], ['name', 'wrapper', 'transitions']);
    const states: Record<string, StateDocument> = Object.create(null);
    const local = new Map<string, string>();
    const aliases = new Map<string, string>();
    const elements: [XMLElement, string, StateDocument][] = [];
    const pending: { transition: TransitionDocument; order: number; internal: boolean; stay: boolean }[] = [];
    const register = (element: XMLElement, parent?: string) => {
      const name = nameOf(element), id = element.getAttribute('id') ?? fail('state id is required');
      if (Object.hasOwn(states, name)) fail(`duplicate state name ${name}`);
      attributes(element, ['id', ...(standard(element, 'state') ? ['initial'] : [])], ['name', 'initial', 'history', 'update', 'transitions',
        ...(standard(element, 'parallel') ? ['regionHistory'] : ['wrapper'])]);
      const state: StateDocument = {};
      if (parent !== undefined) state.parent = parent;
      states[name] = state; local.set(id, name); elements.push([element, name, state]);
      if (standard(element, 'parallel')) {
        const regions: Record<string, RegionDocument> = Object.create(null);
        for (const region of children(element).filter(stateElement)) {
          const regionName = nameOf(region);
          if (Object.hasOwn(regions, regionName)) fail('duplicate region name');
          regions[regionName] = readRegion(region, extension(region, 'wrapper') !== 'true');
        }
        if (!Object.keys(regions).length) fail('parallel has no regions');
        state.regions = regions;
        const history = extension(element, 'regionHistory');
        if (history !== null) { if (!['true', 'false'].includes(history)) fail('invalid regionHistory'); state.regionHistory = history === 'true'; }
      } else for (const child of children(element).filter(stateElement)) register(child, name);
    };
    if (includeContainer) register(container);
    else for (const element of children(container).filter(stateElement)) register(element);
    const target = (id: string) => local.get(id) ?? aliases.get(id) ?? fail(`target ${id} crosses a region or is unknown`);
    const initial = (element: XMLElement, infer: boolean): string | undefined => {
      const nodes = children(element).filter(e => standard(e, 'initial'));
      if (nodes.length > 1 || (nodes.length && element.hasAttribute('initial'))) fail('initial attribute and element conflict');
      const native = extension(element, 'initial');
      if (native !== null && native !== 'none') fail('invalid native initial marker');
      if (native === 'none') return undefined;
      let id = element.getAttribute('initial');
      if (nodes.length) {
        attributes(nodes[0], []);
        const edges = children(nodes[0]);
        if (edges.length !== 1 || !standard(edges[0], 'transition')) fail('initial requires one transition');
        attributes(edges[0], ['target']);
        if (children(edges[0]).length) fail('initial executable content');
        id = edges[0].getAttribute('target');
      }
      if (!id && infer) id = children(element).find(stateElement)?.getAttribute('id') ?? null;
      return id ? target(id) : undefined;
    };
    // Register history pseudo-state aliases before resolving any transition or initial target.
    for (const [element, name, state] of elements) {
      const histories = children(element).filter(e => standard(e, 'history'));
      if (histories.length > 1) fail('more than one history per state');
      const native = extension(element, 'history');
      if (native !== null) {
        if (native !== 'shallow' && native !== 'deep') fail('invalid native history');
        state.history = native;
      }
      for (const history of histories) {
        attributes(history, ['id', 'type']);
        const id = history.getAttribute('id') ?? fail('history id is required');
        const type = history.getAttribute('type') ?? 'shallow';
        if (type !== 'shallow' && type !== 'deep') fail('invalid history type');
        state.history = type; aliases.set(id, name);
        const edges = children(history);
        if (edges.length !== 1 || !standard(edges[0], 'transition')) fail('history requires one default transition');
        attributes(edges[0], ['target']);
        if (children(edges[0]).length) fail('history executable content');
        state.initial = target(edges[0].getAttribute('target') ?? '');
      }
    }
    for (const [element, name, state] of elements) {
      const start = standard(element, 'parallel') ? undefined : initial(element, true);
      if (start !== undefined) {
        if (state.initial !== undefined && state.initial !== start) fail('history default differs from ordinary initial');
        state.initial = start;
      }
      const update = extension(element, 'update'); if (update !== null) state.update = update;
      const actions = new Set<string>();
      for (const child of children(element)) {
        if (stateElement(child) || standard(child, 'history') || standard(child, 'initial')) continue;
        if (standard(child, 'onentry') || standard(child, 'onexit')) {
          const hook = standard(child, 'onentry') ? 'enter' : 'exit';
          if (actions.has(hook)) fail('multiple hook blocks'); actions.add(hook);
          attributes(child, []);
          const scripts = children(child);
          if (scripts.length !== 1) fail('a hook requires one named action');
          const script = scripts[0];
          if (script.namespaceURI === EXT && script.localName === 'hook') {
            attributes(script, ['name']);
            if (children(script).length || script.textContent?.trim()) fail('hook content');
            state[hook] = script.getAttribute('name') ?? fail('hook has no name');
          } else if (standard(script, 'script')) {
            attributes(script, []); if (children(script).length) fail('nested script content');
            state[hook] = binding(script.textContent ?? '');
          } else fail('executable content is not a named hook');
        } else if (standard(child, 'transition')) {
          attributes(child, ['target', 'event', 'cond', 'type'], ['after', 'duration', 'guard', 'order', 'stay']);
          if (children(child).length) fail('transition executable content');
          if (child.hasAttribute('type') && !['internal', 'external'].includes(child.getAttribute('type')!)) fail('invalid transition type');
          const edge: TransitionDocument = { from: name, to: target(child.getAttribute('target') ?? '') };
          const event = child.getAttribute('event'), after = extension(child, 'after');
          if (event !== null) { if (!event || /\s|\*/.test(event)) fail('event lists or wildcards'); edge.event = event; }
          if (after !== null) edge.after = Number(after);
          const guard = extension(child, 'guard') ?? child.getAttribute('cond');
          if (guard !== null) edge.guard = extension(child, 'guard') !== null ? guard : binding(guard);
          const duration = extension(child, 'duration'); if (duration !== null) edge.duration = Number(duration);
          const order = extension(child, 'order');
          if (order !== null && (!/^\d+$/.test(order) || !Number.isSafeInteger(Number(order)))) fail('invalid transition order');
          pending.push({ transition: edge, order: order === null ? pending.length : Number(order), internal: child.getAttribute('type') === 'internal', stay: extension(child, 'stay') === 'true' });
        } else fail(`element ${child.localName} is outside the document subset`);
      }
    }
    // Region wrappers and scxml may contain only the hierarchy plus an initial element.
    if (!includeContainer) for (const child of children(container)) if (!stateElement(child) && !standard(child, 'initial')) fail('unsupported root/region content');
    const start = includeContainer ? nameOf(container) : initial(container, true);
    if (!start) fail('machine has no initial state');
    const region: RegionDocument = { states, initial: start };
    // Margo never leaves a state that stays on the path, as SCXML's internal type does. SCXML exits and re-enters the
    // source of a self or ancestor target, and of any external one (the default) to a descendant: refuse what would
    // run other hooks than the file means. Margo's own export marks a self or ancestor target with m:stay.
    const lineage = (name: string) => { const path: string[] = []; for (let at: string | undefined = name; at !== undefined; at = states[at].parent) path.push(at); return path; };
    for (const { transition: { from, to }, internal, stay } of pending) {
      if (stay && !(internal && (from === to || lineage(from).includes(to)))) fail('native stay marks only an internal transition to the source or its ancestor');
      if (stay) continue;
      if (from === to || lineage(from).includes(to)) fail(`transition from ${from} to itself or its ancestor ${to} would exit and re-enter ${to} in SCXML; target a child state, or use a native machine document`);
      if (!internal && lineage(to).includes(from)) fail(`external transition from ${from} to its descendant ${to} would exit and re-enter ${from}; add type="internal"`);
    }
    if (pending.length || extension(container, 'transitions') === 'empty') region.transitions = pending.sort((a, b) => a.order - b.order).map(p => p.transition);
    return region;
  }
  const document: MachineDocument = { version: 1, ...readRegion(root) };
  const issues = validateMachine(document);
  if (issues.length) fail(issues.map(i => `${i.path}: ${i.message}`).join('; '));
  return document;
}

const escapeXML = (value: string) => {
  if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) fail('value contains a character forbidden by XML 1.0');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;').replaceAll('\t', '&#9;');
};

/** Export a validated machine document; optional namespaced extensions preserve native-only fields without executing code. */
export function exportSCXML(document: MachineDocument, options: SCXMLExportOptions = {}): string {
  const ext = options.extensions !== false;
  const seen = new Set<object>();
  let elements = 0;
  const budget = (region: RegionDocument, depth: number): void => {
    if (depth > 64 || seen.has(region)) fail('cyclic or overly nested document'); seen.add(region);
    elements += 1 + Object.keys(region.states ?? {}).length + (region.transitions?.length ?? 0);
    if (elements > 10000) fail('output exceeds 10,000 elements');
    for (const state of Object.values(region.states ?? {})) for (const inner of Object.values(state?.regions ?? {})) budget(inner, depth + 1);
    seen.delete(region);
  };
  budget(document, 0);
  const issues = validateMachine(document);
  if (issues.length) fail(issues.map(i => `${i.path}: ${i.message}`).join('; '));
  const used = new Set<string>(); let serial = 0;
  const idFor = (name: string) => {
    if (ID.test(name) && !used.has(name)) { used.add(name); return name; }
    if (!ext) fail('non-XML or repeated state/region name; enable extensions');
    let id: string; do { id = `margo${serial++}`; } while (used.has(id)); used.add(id); return id;
  };
  const a = (name: string, value: string | number) => ` ${name}="${escapeXML(String(value))}"`;
  const lineageOf = (region: RegionDocument, name: string) => { const path: string[] = []; for (let at: string | undefined = name; at !== undefined; at = region.states[at].parent) path.push(at); return path; };
  const native = (name: string, value: string | number) => { if (!ext) fail(`${name} requires namespaced extensions; enable extensions`); return a(`m:${name}`, value); };
  function regionXML(region: RegionDocument, tag: string, attrs: string, depth: number): string {
    if (depth > 128) fail('overly nested document');
    const ids = new Map(Object.keys(region.states).map(name => [name, idFor(name)]));
    const ref = (name: string) => ids.get(name)!;
    let result = `<${tag}${attrs}${a('initial', ref(region.initial))}${region.transitions?.length === 0 && ext ? a('m:transitions', 'empty') : ''}>`;
    const write = (name: string, level: number): string => {
      if (depth + level + 3 > 128) fail('overly nested hierarchy');
      const state = region.states[name], childNames = Object.keys(region.states).filter(child => region.states[child].parent === name);
      if (state.regions && childNames.length) fail('parallel holder with separate hierarchical children');
      const type = state.regions ? 'parallel' : 'state';
      let out = `<${type}${a('id', ref(name))}${ref(name) !== name ? native('name', name) : ''}`;
      if (state.initial !== undefined) out += a('initial', ref(state.initial));
      else if (childNames.length) out += native('initial', 'none');
      if (state.history !== undefined) out += native('history', state.history);
      if (state.update !== undefined) out += native('update', state.update);
      if (state.regionHistory !== undefined) out += native('regionHistory', String(state.regionHistory));
      out += '>';
      for (const [key, action] of [['enter', 'onentry'], ['exit', 'onexit']] as const) if (state[key] !== undefined) {
        const hook = state[key]!;
        if (SYMBOL.test(hook)) out += `<${action}><script>${escapeXML(hook)}()</script></${action}>`;
        else { if (!ext) fail('hook name requires extensions'); out += `<${action}><m:hook${a('name', hook)}/></${action}>`; }
      }
      for (const [i, t] of (region.transitions ?? []).entries()) if (t.from === name) {
        out += `<transition${a('target', ref(t.to))}${a('type', 'internal')}`;
        if (t.event !== undefined) {
          if (/\s|\*/.test(t.event)) fail('event lists or wildcards'); out += a('event', t.event);
        }
        if (t.after !== undefined) out += native('after', t.after);
        if (t.duration !== undefined) out += native('duration', t.duration);
        if (t.guard !== undefined) out += SYMBOL.test(t.guard) ? a('cond', `${t.guard}()`) : native('guard', t.guard);
        if (ext) out += a('m:order', i);
        if (t.from === t.to || lineageOf(region, t.from).includes(t.to)) out += native('stay', 'true');
        out += '/>';
      }
      for (const child of childNames) out += write(child, level + 1);
      for (const [name, inner] of Object.entries(state.regions ?? {})) {
        const id = idFor(name);
        if (!ext) fail('native parallel region boundaries require extensions');
        out += regionXML(inner, 'state', a('id', id) + a('m:name', name) + a('m:wrapper', 'true'), depth + level + 2);
      }
      return out + `</${type}>`;
    };
    for (const name of Object.keys(region.states)) if (region.states[name].parent === undefined) result += write(name, 0);
    return result + `</${tag}>`;
  }
  const text = '<?xml version="1.0" encoding="UTF-8"?>\n' + regionXML(document, 'scxml', a('xmlns', NS) + (ext ? a('xmlns:m', EXT) : '') + a('version', '1.0'), 0);
  if (text.length > MAX || new TextEncoder().encode(text).byteLength > MAX) fail('output exceeds 1 MiB');
  if ((text.match(/<(?!!|\?|\/)/g) ?? []).length > 10000) fail('output exceeds 10,000 elements');
  return text;
}
