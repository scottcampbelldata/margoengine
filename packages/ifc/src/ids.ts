/// <reference lib="esnext.disposable" preserve="true" />
// IDS 1.0 (buildingSMART Information Delivery Specification): reads and writes .ids XML, and checks an open IFC model
// against it. Written clean room from the IDS 1.0 schema (Schema/ids.xsd), user manual (specifications, entity,
// attribute, classification, property, material and partOf facets, restrictions, units) and implementers'
// documentation (developer guide, tolerance, DataTypes, IFC2X3 occurrence-type mapping table) at
// https://github.com/buildingSMART/IDS, and checked against its published test cases.
import { LoaderError } from '@margoengine/loaders/common';
import { parseXMLDocument, type XMLElement } from '../../shared/xml-document.js';
import { newBCFGuid, type BCFCamera, type BCFTopic, type BCFViewpoint } from './bcf.js';
import { readIFCData, type IFCData, type IFCProperty, type IFCPropertySet, type IFCValue } from './data.js';
import { checkAbort, checkModel, deletedLines, native, type IFCModel } from './open.js';
import { nearlyEqual as nearly } from './tolerance.js';
import { unitTypeOfMeasure, siUnit } from './units.js';

const IDS_NS = 'http://standards.buildingsmart.org/IDS';
const XS_NS = 'http://www.w3.org/2001/XMLSchema';

/** An `xs:restriction`: one or more of an enumeration, patterns, bounds and lengths over a base type. */
export interface IDSRestriction {
  /** The XML base type, such as `xs:string`, `xs:double` or `xs:integer`. */
  base: string;
  enumeration?: string[];
  /** XML Schema regular expressions; a value matches when it matches any of them. */
  pattern?: string[];
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  length?: number;
  minLength?: number;
  maxLength?: number;
}
/** A facet parameter: a simple value or a restriction. */
export type IDSValue = { simpleValue: string } | { restriction: IDSRestriction };
/** How a requirement applies: present and matching, absent or not matching, or matching when present. */
export type IDSCardinality = 'required' | 'optional' | 'prohibited';

/** Entity facet: the IFC class (exact, upper case) and optionally its predefined type. */
export interface IDSEntityFacet {
  facet: 'entity';
  /** The IFC class in upper case, such as `IFCWALL`. */
  name: IDSValue;
  predefinedType?: IDSValue;
}
/** Attribute facet: an IFC attribute by name, filled in, optionally with a value. */
export interface IDSAttributeFacet {
  facet: 'attribute';
  name: IDSValue;
  value?: IDSValue;
}
/** Classification facet: a classification system and/or reference code (a code matches its sub-references). */
export interface IDSClassificationFacet {
  facet: 'classification';
  system?: IDSValue;
  value?: IDSValue;
  uri?: string;
}
/** Property facet: a property or quantity by set and name, optionally with its data type and value. */
export interface IDSPropertyFacet {
  facet: 'property';
  propertySet: IDSValue;
  baseName: IDSValue;
  /** IFC data type in upper case, such as `IFCLABEL` or `IFCLENGTHMEASURE`. */
  dataType?: string;
  /** In the IDS units table's SI unit for `dataType`. */
  value?: IDSValue;
  uri?: string;
}
/** Material facet: any material, or one whose name, category or layer, profile or constituent name matches. */
export interface IDSMaterialFacet {
  facet: 'material';
  value?: IDSValue;
  uri?: string;
}
/** IDS 1.0 partOf relations. */
export type IDSRelation =
  | 'IFCRELAGGREGATES'
  | 'IFCRELASSIGNSTOGROUP'
  | 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
  | 'IFCRELNESTS'
  | 'IFCRELVOIDSELEMENT IFCRELFILLSELEMENT';
/** PartOf facet: a whole (an entity facet) reached by one relation, or any, recursively. */
export interface IDSPartOfFacet {
  facet: 'partOf';
  entity: IDSEntityFacet;
  relation?: IDSRelation;
}
/** Any of the six IDS 1.0 facets. */
export type IDSFacet =
  | IDSEntityFacet
  | IDSAttributeFacet
  | IDSClassificationFacet
  | IDSPropertyFacet
  | IDSMaterialFacet
  | IDSPartOfFacet;
/** A requirement facet: a facet with its cardinality and the author's instructions. */
export type IDSRequirement = IDSFacet & { cardinality: IDSCardinality; instructions?: string };

/** One specification: which entities it applies to and what they must carry. */
export interface IDSSpecification {
  name: string;
  /** Schemas the specification applies to: `IFC2X3`, `IFC4`, `IFC4X3_ADD2`. */
  ifcVersion: string[];
  identifier?: string;
  description?: string;
  instructions?: string;
  /**
   * Applicability occurrences, as ids.xsd's defaults read them when absent (1 and 1). `maxOccurs` 0 is prohibited;
   * otherwise `minOccurs` 0 is optional and 1 (or more) required. IDS 1.0 writes required as 1 and `unbounded`; a
   * `maxOccurs` of 1 reads the same.
   */
  minOccurs: number;
  maxOccurs: number | 'unbounded';
  applicability: IDSFacet[];
  requirements: IDSRequirement[];
  /** The requirements element's description. */
  requirementsDescription?: string;
}
/** The IDS document header. */
export interface IDSInfo {
  title: string;
  copyright?: string;
  version?: string;
  description?: string;
  author?: string;
  /** `YYYY-MM-DD`. */
  date?: string;
  purpose?: string;
  milestone?: string;
}
/** A parsed IDS document. */
export interface IDSDocument {
  info: IDSInfo;
  specifications: IDSSpecification[];
}

type IDSErrorCode = 'syntax' | 'range' | 'aborted';
const fail = (code: IDSErrorCode, message: string): never => {
  throw new LoaderError('IDS', code, message);
};

// Reading.

const kids = (e: XMLElement, name: string, ns = IDS_NS) =>
  e.children.filter((c) => c.localName === name && c.namespaceURI === ns);
const kid = (e: XMLElement, name: string) => kids(e, name)[0];
const textOf = (e: XMLElement | undefined) => (e ? e.textContent : undefined);

function readValue(e: XMLElement | undefined, where: string): IDSValue | undefined {
  if (!e) return;
  const simple = kid(e, 'simpleValue');
  if (simple) return { simpleValue: simple.textContent };
  const r = kids(e, 'restriction', XS_NS)[0];
  if (!r) return fail('syntax', `${where} needs a simpleValue or an xs:restriction; add one`);
  const restriction: IDSRestriction = { base: r.getAttribute('base') ?? 'xs:string' };
  for (const c of r.children) {
    if (c.namespaceURI !== XS_NS) continue;
    const value = c.getAttribute('value');
    if (value === null) {
      if (c.localName === 'annotation') continue;
      return fail('syntax', `${where}: xs:${c.localName} needs a value attribute; add one`);
    }
    const name = c.localName;
    if (name === 'enumeration' || name === 'pattern') (restriction[name] ??= []).push(value);
    else if (name === 'minInclusive' || name === 'maxInclusive' || name === 'minExclusive' || name === 'maxExclusive')
      restriction[name] = value;
    else if (name === 'length' || name === 'minLength' || name === 'maxLength') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0)
        return fail('syntax', `${where}: xs:${name} must be a non-negative integer; fix the value`);
      restriction[name] = n;
    } else if (name !== 'annotation' && name !== 'totalDigits' && name !== 'fractionDigits' && name !== 'whiteSpace')
      return fail(
        'syntax',
        `${where}: xs:${name} is not an IDS restriction; use enumeration, pattern, bounds or lengths`,
      );
  }
  return { restriction };
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) fail('syntax', `${what} is missing; add it as ids.xsd requires`);
  return value as T;
}

function readEntity(e: XMLElement): IDSEntityFacet {
  const facet: IDSEntityFacet = {
    facet: 'entity',
    name: need(readValue(kid(e, 'name'), 'entity name'), 'entity name'),
  };
  const predefined = readValue(kid(e, 'predefinedType'), 'entity predefinedType');
  if (predefined) facet.predefinedType = predefined;
  return facet;
}

const RELATIONS: readonly string[] = [
  'IFCRELAGGREGATES',
  'IFCRELASSIGNSTOGROUP',
  'IFCRELCONTAINEDINSPATIALSTRUCTURE',
  'IFCRELNESTS',
  'IFCRELVOIDSELEMENT IFCRELFILLSELEMENT',
];

function readFacet(e: XMLElement): IDSFacet | undefined {
  const optional = <T extends object>(facet: T, key: string, value: unknown) => {
    if (value !== undefined && value !== null) (facet as Record<string, unknown>)[key] = value;
    return facet;
  };
  switch (e.localName) {
    case 'entity':
      return readEntity(e);
    case 'attribute': {
      const facet: IDSAttributeFacet = {
        facet: 'attribute',
        name: need(readValue(kid(e, 'name'), 'attribute name'), 'attribute name'),
      };
      return optional(facet, 'value', readValue(kid(e, 'value'), 'attribute value'));
    }
    case 'classification': {
      const facet: IDSClassificationFacet = { facet: 'classification' };
      optional(facet, 'value', readValue(kid(e, 'value'), 'classification value'));
      optional(facet, 'system', readValue(kid(e, 'system'), 'classification system'));
      return optional(facet, 'uri', e.getAttribute('uri'));
    }
    case 'property': {
      const facet: IDSPropertyFacet = {
        facet: 'property',
        propertySet: need(readValue(kid(e, 'propertySet'), 'property propertySet'), 'property propertySet'),
        baseName: need(readValue(kid(e, 'baseName'), 'property baseName'), 'property baseName'),
      };
      optional(facet, 'value', readValue(kid(e, 'value'), 'property value'));
      optional(facet, 'dataType', e.getAttribute('dataType'));
      return optional(facet, 'uri', e.getAttribute('uri'));
    }
    case 'material': {
      const facet: IDSMaterialFacet = { facet: 'material' };
      optional(facet, 'value', readValue(kid(e, 'value'), 'material value'));
      return optional(facet, 'uri', e.getAttribute('uri'));
    }
    case 'partOf': {
      const entity = kid(e, 'entity');
      const facet: IDSPartOfFacet = { facet: 'partOf', entity: readEntity(need(entity, 'partOf entity')) };
      const relation = e.getAttribute('relation');
      if (relation !== null) {
        if (!RELATIONS.includes(relation))
          fail('syntax', `partOf relation ${relation} is not an IDS 1.0 relation; use one of ${RELATIONS.join(', ')}`);
        facet.relation = relation as IDSRelation;
      }
      return facet;
    }
  }
}

const occurs = (value: string | null, fallback: number): number | 'unbounded' => {
  if (value === null) return fallback;
  if (value === 'unbounded') return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    fail('syntax', `occurrence ${value} must be a non-negative integer or unbounded; fix it`);
  return n;
};

/** Options of parseIDS. */
export interface IDSParseOptions {
  /** Most XML elements to read. Default 1,000,000. */
  maxElements?: number;
}

/**
 * Reads an IDS 1.0 document (`.ids` XML) into plain objects. Rejects malformed XML and documents that miss what
 * ids.xsd requires with `LoaderError` (format `IDS`, code `syntax`).
 */
export function parseIDS(source: string | Uint8Array, options: IDSParseOptions = {}): IDSDocument {
  if (typeof source !== 'string' && !(source instanceof Uint8Array))
    fail('range', 'expected IDS text or bytes; read the .ids file first');
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const doc = parseXMLDocument(text.replace(/^﻿/, ''), {
    maxElements: options.maxElements ?? 1_000_000,
    fail: (reason: string) => fail('syntax', `malformed IDS XML: ${reason}; fix the file`),
  });
  const root = doc.documentElement;
  if (root.localName !== 'ids' || root.namespaceURI !== IDS_NS)
    fail('syntax', `expected an <ids> root in ${IDS_NS}; this is not an IDS 1.0 file`);
  const infoElement = need(kid(root, 'info'), 'info');
  const info: IDSInfo = { title: need(textOf(kid(infoElement, 'title')), 'info title') };
  for (const key of ['copyright', 'version', 'description', 'author', 'date', 'purpose', 'milestone'] as const) {
    const value = textOf(kid(infoElement, key));
    if (value !== undefined) info[key] = value;
  }
  const specifications: IDSSpecification[] = [];
  for (const s of kids(need(kid(root, 'specifications'), 'specifications'), 'specification')) {
    const applicability = need(kid(s, 'applicability'), 'specification applicability');
    const spec: IDSSpecification = {
      name: need(s.getAttribute('name') ?? undefined, 'specification name'),
      ifcVersion: need(s.getAttribute('ifcVersion') ?? undefined, 'specification ifcVersion')
        .trim()
        .split(/\s+/),
      minOccurs: occurs(applicability.getAttribute('minOccurs'), 1) as number,
      maxOccurs: occurs(applicability.getAttribute('maxOccurs'), 1),
      applicability: [],
      requirements: [],
    };
    if (spec.minOccurs === ('unbounded' as unknown)) fail('syntax', 'minOccurs cannot be unbounded; use 0 or 1');
    for (const key of ['identifier', 'description', 'instructions'] as const) {
      const value = s.getAttribute(key);
      if (value !== null) spec[key] = value;
    }
    for (const f of applicability.children) {
      const facet = readFacet(f);
      if (facet) spec.applicability.push(facet);
    }
    const requirements = kid(s, 'requirements');
    if (requirements) {
      const description = requirements.getAttribute('description');
      if (description !== null) spec.requirementsDescription = description;
      for (const f of requirements.children) {
        const facet = readFacet(f);
        if (!facet) continue;
        const requirement = facet as IDSRequirement;
        requirement.cardinality = (f.getAttribute('cardinality') as IDSCardinality | null) ?? 'required';
        if (!['required', 'optional', 'prohibited'].includes(requirement.cardinality))
          fail('syntax', `cardinality ${requirement.cardinality} must be required, optional or prohibited`);
        const instructions = f.getAttribute('instructions');
        if (instructions !== null) requirement.instructions = instructions;
        spec.requirements.push(requirement);
      }
    }
    specifications.push(spec);
  }
  if (!specifications.length) fail('syntax', 'an IDS needs at least one specification; add one');
  return { info, specifications };
}

// Writing.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const attr = (name: string, value: string | number | undefined) =>
  value === undefined ? '' : ` ${name}="${esc(String(value))}"`;

function writeValue(tag: string, value: IDSValue | undefined, pad: string): string {
  if (!value) return '';
  if ('simpleValue' in value)
    return `${pad}<ids:${tag}><ids:simpleValue>${esc(value.simpleValue)}</ids:simpleValue></ids:${tag}>\n`;
  const r = value.restriction,
    inner = `${pad}    `;
  let body = '';
  for (const v of r.enumeration ?? []) body += `${inner}<xs:enumeration value="${esc(v)}"/>\n`;
  for (const v of r.pattern ?? []) body += `${inner}<xs:pattern value="${esc(v)}"/>\n`;
  for (const key of [
    'minExclusive',
    'minInclusive',
    'maxExclusive',
    'maxInclusive',
    'length',
    'minLength',
    'maxLength',
  ] as const)
    if (r[key] !== undefined) body += `${inner}<xs:${key} value="${esc(String(r[key]))}"/>\n`;
  return `${pad}<ids:${tag}>\n${pad}  <xs:restriction base="${esc(r.base)}">\n${body}${pad}  </xs:restriction>\n${pad}</ids:${tag}>\n`;
}

function writeFacet(f: IDSFacet | IDSRequirement, pad: string, requirement: boolean): string {
  const req = requirement ? (f as IDSRequirement) : undefined;
  const tail = (extra: string) =>
    `${extra}${req && !(f.facet === 'entity') ? attr('cardinality', req.cardinality) : ''}${req ? attr('instructions', req.instructions) : ''}`;
  const inner = `${pad}  `;
  switch (f.facet) {
    case 'entity':
      return `${pad}<ids:entity${req ? attr('instructions', req.instructions) : ''}>\n${writeValue('name', f.name, inner)}${writeValue('predefinedType', f.predefinedType, inner)}${pad}</ids:entity>\n`;
    case 'partOf':
      return `${pad}<ids:partOf${tail(attr('relation', f.relation))}>\n${writeFacet(f.entity, inner, false)}${pad}</ids:partOf>\n`;
    case 'classification':
      return `${pad}<ids:classification${tail(attr('uri', f.uri))}>\n${writeValue('value', f.value, inner)}${writeValue('system', f.system, inner)}${pad}</ids:classification>\n`;
    case 'attribute':
      return `${pad}<ids:attribute${tail('')}>\n${writeValue('name', f.name, inner)}${writeValue('value', f.value, inner)}${pad}</ids:attribute>\n`;
    case 'property':
      return `${pad}<ids:property${tail(attr('dataType', f.dataType) + attr('uri', f.uri))}>\n${writeValue('propertySet', f.propertySet, inner)}${writeValue('baseName', f.baseName, inner)}${writeValue('value', f.value, inner)}${pad}</ids:property>\n`;
    case 'material':
      return `${pad}<ids:material${tail(attr('uri', f.uri))}>\n${writeValue('value', f.value, inner)}${pad}</ids:material>\n`;
  }
}

const ORDER = ['entity', 'partOf', 'classification', 'attribute', 'property', 'material'];
const ordered = <T extends IDSFacet>(facets: readonly T[]) =>
  [...facets].sort((a, b) => ORDER.indexOf(a.facet) - ORDER.indexOf(b.facet));

/** Writes an IDS 1.0 document as XML, facets in the order ids.xsd's sequences require. parseIDS reads it back unchanged. */
export function writeIDS(ids: IDSDocument): string {
  if (!ids || !ids.info || !Array.isArray(ids.specifications))
    fail('range', 'expected an IDSDocument with info and specifications');
  if (!ids.specifications.length) fail('range', 'an IDS needs at least one specification; add one');
  let out =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<ids:ids xmlns:ids="${IDS_NS}" xmlns:xs="${XS_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${IDS_NS} http://standards.buildingsmart.org/IDS/1.0/ids.xsd">\n  <ids:info>\n`;
  for (const key of ['title', 'copyright', 'version', 'description', 'author', 'date', 'purpose', 'milestone'] as const)
    if (ids.info[key] !== undefined) out += `    <ids:${key}>${esc(ids.info[key]!)}</ids:${key}>\n`;
  out += '  </ids:info>\n  <ids:specifications>\n';
  for (const s of ids.specifications) {
    out += `    <ids:specification${attr('name', s.name)}${attr('ifcVersion', s.ifcVersion.join(' '))}${attr('identifier', s.identifier)}${attr('description', s.description)}${attr('instructions', s.instructions)}>\n`;
    out += `      <ids:applicability${attr('minOccurs', s.minOccurs)}${attr('maxOccurs', s.maxOccurs)}>\n`;
    for (const f of ordered(s.applicability)) out += writeFacet(f, '        ', false);
    out += '      </ids:applicability>\n';
    if (s.requirements.length || s.requirementsDescription !== undefined) {
      out += `      <ids:requirements${attr('description', s.requirementsDescription)}>\n`;
      for (const f of ordered(s.requirements)) out += writeFacet(f, '        ', true);
      out += '      </ids:requirements>\n';
    }
    out += '    </ids:specification>\n';
  }
  return `${out}  </ids:specifications>\n</ids:ids>\n`;
}

// Checking.

/** One requirement an applicable entity did not meet. */
export interface IDSFailure {
  /** expressID of the entity. */
  id: number;
  /** IFC class of the entity, such as `IfcWall`. */
  type: string;
  globalId?: string;
  name?: string;
  /** Index of the requirement in the specification's `requirements`. */
  requirement: number;
  /** Why it failed, in words, such as `Pset_WallCommon.FireRating is 1HR, expected 2HR`. */
  reason: string;
}
/** The outcome of one specification. */
export interface IDSSpecificationResult {
  specification: IDSSpecification;
  status: 'pass' | 'fail';
  /** Notes that do not change the status, such as a model schema the specification's ifcVersion does not list. */
  warnings: string[];
  /** expressIDs of the entities the applicability selects, in ascending order. */
  applicable: number[];
  /** Applicable entities that met every requirement. */
  passed: number[];
  /** One entry per unmet requirement of an applicable entity. */
  failures: IDSFailure[];
  /** Why the specification failed as a whole: no applicable entity, a prohibited match, or an invalid IDS. */
  reason?: string;
}
/** What checkIDS returns. */
export interface IDSReport {
  /** True when no specification failed. */
  pass: boolean;
  schema: string;
  title: string;
  specifications: IDSSpecificationResult[];
}
/** Options of checkIDS. */
export interface IDSCheckOptions {
  signal?: AbortSignal;
  /** readIFCData of the same model, when the caller already has it. */
  data?: IFCData;
}

// biome-ignore lint/suspicious/noExplicitAny: web-ifc lines are untyped JSON
type Raw = any;
const refOf = (v: Raw): number | undefined => (v && v.type === 5 && typeof v.value === 'number' ? v.value : undefined);
const refsOf = (v: Raw): number[] =>
  Array.isArray(v)
    ? v.map(refOf).filter((x): x is number => x !== undefined)
    : refOf(v) !== undefined
      ? [refOf(v)!]
      : [];
const str = (v: Raw): string | undefined => (v && typeof v.value === 'string' && v.type !== 5 ? v.value : undefined);

// The value regular expressions of the IDS DataTypes table (XML base types).
const DOUBLE = /^([-+]?[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?|NaN|\+INF|-INF)$/;
const INTEGER = /^[+-]?(\d+)$/;
const parseDouble = (s: string): number | undefined => {
  if (!DOUBLE.test(s) || !/[0-9]|NaN|INF/.test(s)) return;
  return s === 'NaN' ? Number.NaN : s === '+INF' ? Infinity : s === '-INF' ? -Infinity : Number(s);
};

/** An IFC value as IDS compares it: text, a real, an integer or a boolean. */
type Atom =
  | { kind: 'string'; value: string }
  | { kind: 'real' | 'integer'; value: number }
  | { kind: 'boolean'; value: boolean };

function atomOf(value: IFCValue, dataType: string | undefined): Atom | undefined {
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number') return { kind: dataType && INTEGER_TYPES.has(dataType) ? 'integer' : 'real', value };
}
// Data types the IDS DataTypes table bases on xs:integer.
const INTEGER_TYPES = new Set([
  'IFCCARDINALPOINTREFERENCE',
  'IFCCOUNTMEASURE',
  'IFCDAYINMONTHNUMBER',
  'IFCDAYINWEEKNUMBER',
  'IFCDAYLIGHTSAVINGHOUR',
  'IFCDIMENSIONCOUNT',
  'IFCHOURINDAY',
  'IFCINTEGER',
  'IFCINTEGERCOUNTRATEMEASURE',
  'IFCMINUTEINHOUR',
  'IFCMONTHINYEARNUMBER',
  'IFCPOSITIVEINTEGER',
  'IFCTIMESTAMP',
  'IFCYEARNUMBER',
]);

/** Whether a simple IDS value string equals an IFC atom, casting the string to the atom's type. */
function equalsSimple(text: string, atom: Atom): boolean {
  if (atom.kind === 'string') return atom.value === text;
  if (atom.kind === 'boolean')
    return text === 'true' || text === '1' ? atom.value : text === 'false' || text === '0' ? !atom.value : false;
  if (atom.kind === 'integer') return INTEGER.test(text) && Number(text) === atom.value;
  const v = parseDouble(text);
  return v !== undefined && nearly(atom.value, v);
}

const regexCache = new Map<string, RegExp | null>();
/** An XML Schema regular expression (implicitly anchored) as a JavaScript one, or null when it does not compile. */
function xsdRegex(pattern: string): RegExp | null {
  let re = regexCache.get(pattern);
  if (re !== undefined) return re;
  // \i and \c are XML name start and name characters; \I and \C their complements.
  const translated = pattern
    .replace(/\\i/g, '[_:A-Za-z\\u00C0-\\u02FF\\u0370-\\u1FFF]')
    .replace(/\\c/g, '[-._:A-Za-z0-9\\u00B7\\u00C0-\\u02FF\\u0300-\\u1FFF]')
    .replace(/\\I/g, '[^_:A-Za-z\\u00C0-\\u02FF\\u0370-\\u1FFF]')
    .replace(/\\C/g, '[^-._:A-Za-z0-9\\u00B7\\u00C0-\\u02FF\\u0300-\\u1FFF]');
  try {
    re = new RegExp(`^(?:${translated})$`, 'u');
  } catch {
    re = null;
  }
  regexCache.set(pattern, re);
  return re;
}

/** Whether an IFC atom satisfies an IDS value (simple or restriction). */
function matches(spec: IDSValue, atom: Atom): boolean {
  if ('simpleValue' in spec) return equalsSimple(spec.simpleValue, atom);
  const r = spec.restriction;
  if (r.enumeration && !r.enumeration.some((e) => equalsSimple(e, atom))) return false;
  if (r.pattern) {
    if (atom.kind !== 'string') return false;
    if (!r.pattern.some((p) => xsdRegex(p)?.test(atom.value))) return false;
  }
  const bounds = [r.minInclusive, r.maxInclusive, r.minExclusive, r.maxExclusive];
  if (bounds.some((b) => b !== undefined)) {
    if (atom.kind !== 'real' && atom.kind !== 'integer') return false;
    const x = atom.value,
      n = (b: string | undefined) => (b === undefined ? undefined : parseDouble(b));
    const [minI, maxI, minE, maxE] = bounds.map(n);
    if (bounds.some((b, i) => b !== undefined && [minI, maxI, minE, maxE][i] === undefined)) return false;
    if (minI !== undefined && !(x >= minI)) return false;
    if (maxI !== undefined && !(x <= maxI)) return false;
    if (minE !== undefined && !(x > minE)) return false;
    if (maxE !== undefined && !(x < maxE)) return false;
  }
  if (r.length !== undefined || r.minLength !== undefined || r.maxLength !== undefined) {
    if (atom.kind !== 'string') return false;
    const length = [...atom.value].length;
    if (r.length !== undefined && length !== r.length) return false;
    if (r.minLength !== undefined && length < r.minLength) return false;
    if (r.maxLength !== undefined && length > r.maxLength) return false;
  }
  return true;
}
/** Whether a name (class, set, property, system) satisfies an IDS value; names are always text. */
const matchesText = (spec: IDSValue, text: string | undefined) =>
  text !== undefined && matches(spec, { kind: 'string', value: text });
const describe = (v: IDSValue) =>
  'simpleValue' in v
    ? v.simpleValue
    : [
        v.restriction.enumeration && `one of ${v.restriction.enumeration.join(', ')}`,
        v.restriction.pattern && `matching ${v.restriction.pattern.join(' or ')}`,
        v.restriction.minInclusive !== undefined && `>= ${v.restriction.minInclusive}`,
        v.restriction.minExclusive !== undefined && `> ${v.restriction.minExclusive}`,
        v.restriction.maxInclusive !== undefined && `<= ${v.restriction.maxInclusive}`,
        v.restriction.maxExclusive !== undefined && `< ${v.restriction.maxExclusive}`,
        v.restriction.length !== undefined && `${v.restriction.length} characters`,
        v.restriction.minLength !== undefined && `at least ${v.restriction.minLength} characters`,
        v.restriction.maxLength !== undefined && `at most ${v.restriction.maxLength} characters`,
      ]
        .filter(Boolean)
        .join(', ');

// IFC2X3 has no occurrence class for many types: an air terminal is an IfcFlowTerminal typed by an IfcAirTerminalType.
// The IDS IFC2X3 occurrence-type mapping table pairs every such IDS name N with one of these generic occurrence classes
// and the type class N + TYPE, so on IFC2X3 an occurrence of these classes whose type object is N + TYPE is an N.
const IFC2X3_GENERIC = new Set([
  'IFCFURNISHINGELEMENT',
  'IFCDISTRIBUTIONCONTROLELEMENT',
  'IFCENERGYCONVERSIONDEVICE',
  'IFCFLOWCONTROLLER',
  'IFCFLOWFITTING',
  'IFCFLOWMOVINGDEVICE',
  'IFCFLOWSEGMENT',
  'IFCFLOWSTORAGEDEVICE',
  'IFCFLOWTERMINAL',
  'IFCFLOWTREATMENTDEVICE',
  'IFCEQUIPMENTELEMENT',
]);

/** A model as the checker reads it: raw lines for any entity, readIFCData for objects and their relations. */
class Model {
  readonly ifc2x3: boolean;
  private lines = new Map<number, Raw>();
  private codes = new Map<number, string>();
  private typeOfId = new Map<number, string>();
  private all?: number[];
  private materialSets?: Map<number, IFCPropertySet[]>;
  private externalClasses?: Map<number, number[]>;
  private materialLinks?: Set<number>;
  constructor(
    readonly model: IFCModel,
    readonly data: IFCData,
  ) {
    this.ifc2x3 = model.schema.toUpperCase().startsWith('IFC2X3');
  }
  line(id: number): Raw {
    let l = this.lines.get(id);
    if (l === undefined) {
      l = native('reading a line', () => this.model.api.GetLine(this.model.id, id)) ?? null;
      this.lines.set(id, l);
    }
    return l;
  }
  nameOfCode(code: number): string {
    let name = this.codes.get(code);
    if (name === undefined)
      this.codes.set(code, (name = native('reading a type name', () => this.model.api.GetNameFromTypeCode(code))));
    return name;
  }
  /** The class of an entity in upper case. */
  type(id: number): string {
    let t = this.typeOfId.get(id);
    if (t === undefined) {
      const e = this.data.elements.get(id);
      t = (
        e ? e.type : this.nameOfCode(native('reading a line type', () => this.model.api.GetLineType(this.model.id, id)))
      ).toUpperCase();
      this.typeOfId.set(id, t);
    }
    return t;
  }
  ids(vector: { size(): number; get(i: number): number }): number[] {
    const out: number[] = [];
    const deleted = deletedLines(this.model);
    for (let i = 0; i < vector.size(); i++) if (!deleted.has(vector.get(i))) out.push(vector.get(i));
    return out;
  }
  allIds(): number[] {
    return (this.all ??= this.ids(native('listing lines', () => this.model.api.GetAllLines(this.model.id))).sort(
      (a, b) => a - b,
    ));
  }
  /** Entities of one class (not its subtypes). */
  ofClass(name: string): number[] {
    const api = this.model.api,
      code = api.GetTypeCodeFromName(name);
    if (!code) return [];
    return this.ids(native(`listing ${name}`, () => api.GetLineIDsWithType(this.model.id, code, false)));
  }
  /** Every class present in the model, upper case. */
  classes(): string[] {
    const out = new Set<string>();
    for (const t of native('listing classes', () => this.model.api.GetAllTypesOfModel(this.model.id)))
      out.add(String(t.typeName).toUpperCase());
    return [...out];
  }
  /** Property sets of an IfcMaterial: IfcMaterialProperties (IFC4) or IfcExtendedMaterialProperties (IFC2X3). */
  materialPropertySets(id: number): IFCPropertySet[] {
    return this.data.materialProperties?.get(id) ?? [];
  }
  /** Classification references of a resource that is no object (a material, a profile), by IfcExternalReferenceRelationship. */
  resourceClassifications(id: number): number[] {
    if (!this.externalClasses) {
      this.externalClasses = new Map();
      for (const rel of this.ofClass('IFCEXTERNALREFERENCERELATIONSHIP')) {
        const l = this.line(rel),
          reference = refOf(l?.RelatingReference);
        if (reference === undefined) continue;
        const kind = this.type(reference);
        if (kind !== 'IFCCLASSIFICATIONREFERENCE' && kind !== 'IFCCLASSIFICATION') continue;
        for (const target of refsOf(l.RelatedResourceObjects))
          (this.externalClasses.get(target) ?? this.externalClasses.set(target, []).get(target)!).push(reference);
      }
    }
    return this.externalClasses.get(id) ?? [];
  }
  /** Whether an object has an IfcRelAssociatesMaterial of its own. */
  hasMaterialLink(id: number): boolean {
    if (!this.materialLinks) {
      this.materialLinks = new Set();
      for (const rel of this.ofClass('IFCRELASSOCIATESMATERIAL'))
        for (const target of refsOf(this.line(rel)?.RelatedObjects)) this.materialLinks.add(target);
    }
    return this.materialLinks.has(id);
  }
}

/** A facet's verdict on one entity: whether it holds, and why not. */
type Verdict = { ok: true } | { ok: false; reason: string };
const yes: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

/** The IDS class name of an entity: on IFC2X3 a generic occurrence takes its type object's name (see IFC2X3_GENERIC). */
function classNames(m: Model, id: number): string[] {
  const own = m.type(id);
  if (!m.ifc2x3 || !IFC2X3_GENERIC.has(own)) return [own];
  const typeId = m.data.elements.get(id)?.typeId;
  const typeClass = typeId === undefined ? undefined : m.type(typeId);
  return typeClass?.endsWith('TYPE') ? [own, typeClass.slice(0, -4)] : [own];
}

/**
 * The predefined type as IDS resolves it: the type object's first, then the occurrence's. A USERDEFINED type answers
 * to both USERDEFINED and its own name (ElementType, ProcessType or ResourceType of a type, ObjectType of an occurrence).
 */
function predefinedTypesOf(m: Model, id: number): string[] {
  const own = (l: Raw, isType: boolean): string[] => {
    const p = str(l?.PredefinedType);
    if (p === undefined || p === 'NOTDEFINED') return [];
    if (p !== 'USERDEFINED') return [p];
    const custom = isType ? (str(l.ElementType) ?? str(l.ProcessType) ?? str(l.ResourceType)) : str(l.ObjectType);
    return custom === undefined ? [p] : [custom, p];
  };
  const typeId = m.data.elements.get(id)?.typeId;
  const fromType = typeId !== undefined ? own(m.line(typeId), true) : [];
  return fromType.length ? fromType : own(m.line(id), m.type(id).endsWith('TYPE'));
}

function entityVerdict(m: Model, f: IDSEntityFacet, id: number): Verdict {
  const names = classNames(m, id);
  if (!names.some((n) => matchesText(f.name, n)))
    return no(`is ${names[names.length - 1]}, expected ${describe(f.name)}`);
  if (f.predefinedType) {
    const types = predefinedTypesOf(m, id);
    if (!types.some((p) => matchesText(f.predefinedType!, p)))
      return no(`predefined type is ${types[0] ?? 'not set'}, expected ${describe(f.predefinedType)}`);
  }
  return yes;
}

/** Entities an entity facet can select, without testing its predefined type. */
function entityCandidates(m: Model, f: IDSEntityFacet): number[] {
  const names =
    'simpleValue' in f.name
      ? [f.name.simpleValue]
      : f.name.restriction.enumeration && Object.keys(f.name.restriction).length === 2
        ? f.name.restriction.enumeration
        : m.classes().filter((c) => matchesText(f.name, c));
  const out = new Set<number>();
  for (const name of names) {
    if (name !== name.toUpperCase()) continue;
    for (const id of m.ofClass(name)) out.add(id);
    if (m.ifc2x3)
      for (const typeId of m.ofClass(`${name}TYPE`))
        for (const e of m.data.elements.values())
          if (e.typeId === typeId && IFC2X3_GENERIC.has(e.type.toUpperCase())) out.add(e.id);
  }
  return [...out];
}

const SKIP_KEYS = new Set(['expressID', 'type']);
/** A raw attribute as an atom; `empty` for null, an empty string or list, or LOGICAL UNKNOWN; `object` for references, lists and selects of entities. */
function attributeAtom(m: Model, raw: Raw): Atom | 'empty' | 'object' {
  if (raw === null || raw === undefined) return 'empty';
  if (Array.isArray(raw)) return raw.length ? 'object' : 'empty';
  if (typeof raw !== 'object')
    return typeof raw === 'string' ? (raw === '' ? 'empty' : { kind: 'string', value: raw }) : 'object';
  if (raw.type === 5) return 'object';
  const name = typeof raw.name === 'string' ? raw.name.toUpperCase() : undefined;
  if (raw.type === 3 && (name === 'IFCBOOLEAN' || name === 'IFCLOGICAL')) {
    if (raw.value === true || raw.value === 'T') return { kind: 'boolean', value: true };
    if (raw.value === false || raw.value === 'F') return { kind: 'boolean', value: false };
    return 'empty';
  }
  if (raw.type === 4 || raw.type === 10) {
    const value = Number(raw._representationValue ?? raw.value);
    if (raw.type === 10) return { kind: 'integer', value };
    // Measures compare in the IDS units table's SI unit.
    const unitType = unitTypeOfMeasure(name),
      unit = unitType ? (m.data.units.byType[unitType] ?? siUnit(unitType)) : undefined;
    return {
      kind: name && INTEGER_TYPES.has(name) ? 'integer' : 'real',
      value: unit ? value * unit.scale + unit.shift : value,
    };
  }
  if (typeof raw.value === 'string') return raw.value === '' ? 'empty' : { kind: 'string', value: raw.value };
  return 'object';
}

function attributeVerdict(m: Model, f: IDSAttributeFacet, id: number): Verdict {
  const l = m.line(id);
  if (!l) return no('cannot be read');
  const keys = Object.keys(l).filter((k) => !SKIP_KEYS.has(k) && matchesText(f.name, k));
  if (!keys.length) return no(`has no attribute ${describe(f.name)}`);
  const reasons: string[] = [];
  for (const key of keys) {
    const atom = attributeAtom(m, l[key]);
    if (atom === 'empty') {
      reasons.push(`${key} is empty`);
      continue;
    }
    if (!f.value) return yes;
    if (atom === 'object') {
      reasons.push(`${key} is not a single value`);
      continue;
    }
    if (matches(f.value, atom)) return yes;
    reasons.push(`${key} is ${String(atom.value)}, expected ${describe(f.value)}`);
  }
  return no(reasons.join('; '));
}

/** The classification references (or classifications) of an entity: its own, then its type's for other systems. */
function classificationsOfEntity(m: Model, id: number): { system?: string; codes: string[] }[] {
  const read = (ref: number): { system?: string; codes: string[] } => {
    const out: { system?: string; codes: string[] } = { codes: [] };
    const seen = new Set<number>();
    for (let at: number | undefined = ref; at !== undefined && !seen.has(at); ) {
      seen.add(at);
      const l = m.line(at),
        kind = m.type(at);
      if (kind === 'IFCCLASSIFICATION') {
        out.system = str(l.Name);
        break;
      }
      const code = str(l.Identification) ?? str(l.ItemReference);
      if (code !== undefined) out.codes.push(code);
      at = refOf(l.ReferencedSource);
    }
    return out;
  };
  const element = m.data.elements.get(id);
  if (!element) return m.resourceClassifications(id).map(read);
  const own = element.classifications.map((c) => ({
    system: c.system,
    codes: [c.code, ...(c.parents ?? [])].filter((x): x is string => x !== undefined),
  }));
  const type = element.typeId !== undefined ? m.data.elements.get(element.typeId) : undefined;
  const systems = new Set(own.map((c) => c.system));
  const inherited = (type?.classifications ?? [])
    .filter((c) => !systems.has(c.system))
    .map((c) => ({
      system: c.system,
      codes: [c.code, ...(c.parents ?? [])].filter((x): x is string => x !== undefined),
    }));
  return [...own, ...inherited];
}

function classificationVerdict(m: Model, f: IDSClassificationFacet, id: number): Verdict {
  const all = classificationsOfEntity(m, id);
  if (!all.length) return no('has no classification');
  const hit = all.some(
    (c) =>
      (!f.system || matchesText(f.system, c.system)) &&
      (!f.value || c.codes.some((code) => matchesText(f.value!, code))),
  );
  if (hit) return yes;
  const found = all.map((c) => `${c.system ?? '?'} ${c.codes[0] ?? ''}`.trim()).join(', ');
  return no(
    `is classified ${found}, expected ${[f.system && describe(f.system), f.value && describe(f.value)].filter(Boolean).join(' ')}`,
  );
}

/** Quantity classes compare as the measure their value is in. */
const QUANTITY_MEASURE: Record<string, string> = {
  IFCQUANTITYLENGTH: 'IFCLENGTHMEASURE',
  IFCQUANTITYAREA: 'IFCAREAMEASURE',
  IFCQUANTITYVOLUME: 'IFCVOLUMEMEASURE',
  IFCQUANTITYCOUNT: 'IFCCOUNTMEASURE',
  IFCQUANTITYWEIGHT: 'IFCMASSMEASURE',
  IFCQUANTITYTIME: 'IFCTIMEMEASURE',
  IFCQUANTITYNUMBER: 'IFCNUMERICMEASURE',
};

function propertySetsOf(m: Model, id: number): IFCPropertySet[] {
  const element = m.data.elements.get(id);
  if (!element) return m.materialPropertySets(id);
  // Type sets first, then the occurrence's: an occurrence property overrides the type's of the same set and name.
  const type = element.typeId !== undefined ? m.data.elements.get(element.typeId) : undefined;
  const merged = new Map<string, IFCPropertySet>();
  for (const set of [...(type?.psets ?? []), ...element.psets]) {
    const into = merged.get(set.name);
    merged.set(set.name, into ? { ...set, properties: { ...into.properties, ...set.properties } } : set);
  }
  return [...merged.values()];
}

const BOUNDS = ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const;
const isBounds = (v: IDSValue) => 'restriction' in v && BOUNDS.some((k) => v.restriction[k] !== undefined);
const isEmpty = (v: IFCValue) => v === null || v === '' || (Array.isArray(v) && !v.length);

/**
 * Whether a property's value satisfies the facet's data type and value; empty values and complex or reference
 * properties never do. A list, enumerated or table property passes when any of its values matches (a bounds
 * restriction needs all of them inside); a bounded property's lower, upper and set point values are its values,
 * and a bounds restriction needs its whole range inside.
 */
function propertyValueVerdict(f: IDSPropertyFacet, p: IFCProperty, label: string): Verdict {
  if (p.kind === 'complex' || p.kind === 'reference')
    return no(`${label} is a ${p.kind} property, which IDS does not check`);
  // Each column of values with its data type: a table has two, everything else one.
  const columns: { values: IFCValue[]; dataType?: string }[] =
    p.kind === 'table'
      ? [
          { values: p.defining ?? [], dataType: p.definingDataType },
          { values: Array.isArray(p.value) ? p.value : [], dataType: p.dataType },
        ]
      : p.kind === 'bounded'
        ? [{ values: [p.lower ?? null, p.upper ?? null, p.value], dataType: p.dataType }]
        : [
            {
              values: Array.isArray(p.value) ? p.value : [p.value],
              dataType: p.kind === 'quantity' ? QUANTITY_MEASURE[p.dataType ?? ''] : p.dataType,
            },
          ];
  for (const c of columns) c.values = c.values.filter((v) => !isEmpty(v));
  const filled = columns.filter((c) => c.values.length);
  if (!filled.length) return no(`${label} is empty`);
  const typed = f.dataType ? filled.filter((c) => c.dataType === f.dataType) : filled;
  if (!typed.length)
    return no(`${label} is ${filled.map((c) => c.dataType ?? 'untyped').join(' and ')}, expected ${f.dataType}`);
  if (!f.value) return yes;
  const spec = f.value;
  const shown = typed
    .flatMap((c) => c.values)
    .map(String)
    .join(', ');
  if (p.kind === 'bounded' && isBounds(spec)) {
    const lower = p.lower ?? undefined,
      upper = p.upper ?? undefined;
    if (lower === undefined || upper === undefined) return no(`${label} is open-ended, expected ${describe(spec)}`);
    return matches(spec, { kind: 'real', value: lower }) && matches(spec, { kind: 'real', value: upper })
      ? yes
      : no(`${label} is ${lower} to ${upper}, expected ${describe(spec)}`);
  }
  const atoms = typed.flatMap((c) =>
    c.values.map((v) => atomOf(v, c.dataType)).filter((a): a is Atom => a !== undefined),
  );
  const ok =
    isBounds(spec) && p.kind !== 'single' && p.kind !== 'quantity'
      ? atoms.length > 0 && atoms.every((a) => matches(spec, a))
      : atoms.some((a) => matches(spec, a));
  return ok ? yes : no(`${label} is ${shown}, expected ${describe(spec)}`);
}

function propertyVerdict(m: Model, f: IDSPropertyFacet, id: number): Verdict {
  const sets = propertySetsOf(m, id).filter((s) => matchesText(f.propertySet, s.name));
  if (!sets.length) return no(`has no property set ${describe(f.propertySet)}`);
  for (const set of sets) {
    const props = Object.values(set.properties).filter((p) => matchesText(f.baseName, p.name));
    if (!props.length) return no(`${set.name} has no property ${describe(f.baseName)}`);
    for (const p of props) {
      const v = propertyValueVerdict(f, p, `${set.name}.${p.name}`);
      if (!v.ok) return v;
    }
  }
  return yes;
}

/** Names a material facet value can match: material names and categories, layer, profile and constituent names and categories, set names. */
function materialNames(m: Model, id: number): string[] | undefined {
  const element = m.data.elements.get(id);
  if (!element) return;
  const own = element.materials.length || m.hasMaterialLink(id);
  const source = own ? element : element.typeId !== undefined ? m.data.elements.get(element.typeId) : undefined;
  if (!source || (!source.materials.length && !m.hasMaterialLink(source.id))) return;
  const names: string[] = [];
  for (const x of source.materials) for (const n of [x.name, x.category, x.part, x.set]) if (n) names.push(n);
  return names;
}

function materialVerdict(m: Model, f: IDSMaterialFacet, id: number): Verdict {
  const names = materialNames(m, id);
  if (!names) return no('has no material');
  if (!f.value) return yes;
  return names.some((n) => matchesText(f.value!, n))
    ? yes
    : no(`has materials ${names.join(', ') || '(unnamed)'}, expected ${describe(f.value)}`);
}

/** The wholes above an entity by one IDS relation (or every relation), nearest first, recursively. */
function wholesOf(m: Model, id: number, relation: IDSRelation | undefined): number[] {
  const out: number[] = [],
    seen = new Set([id]),
    queue = [id];
  while (queue.length) {
    const e = m.data.elements.get(queue.shift()!);
    if (!e) continue;
    const up: (number | undefined)[] = [];
    if (!relation || relation === 'IFCRELAGGREGATES') up.push(e.aggregate);
    if (!relation || relation === 'IFCRELNESTS') up.push(e.nest);
    if (!relation || relation === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') up.push(e.container);
    if (!relation || relation === 'IFCRELASSIGNSTOGROUP') up.push(...(e.groups ?? []));
    if (!relation || relation === 'IFCRELVOIDSELEMENT IFCRELFILLSELEMENT') up.push(e.fills, e.voids);
    for (const w of up)
      if (w !== undefined && !seen.has(w)) {
        seen.add(w);
        out.push(w);
        queue.push(w);
      }
  }
  return out;
}

function partOfVerdict(m: Model, f: IDSPartOfFacet, id: number): Verdict {
  const wholes = wholesOf(m, id, f.relation);
  if (wholes.some((w) => entityVerdict(m, f.entity, w).ok)) return yes;
  return no(`is not part of ${describe(f.entity.name)}${f.relation ? ` by ${f.relation}` : ''}`);
}

function verdict(m: Model, f: IDSFacet, id: number): Verdict {
  switch (f.facet) {
    case 'entity':
      return entityVerdict(m, f, id);
    case 'attribute':
      return attributeVerdict(m, f, id);
    case 'classification':
      return classificationVerdict(m, f, id);
    case 'property':
      return propertyVerdict(m, f, id);
    case 'material':
      return materialVerdict(m, f, id);
    case 'partOf':
      return partOfVerdict(m, f, id);
  }
}

/** Whether the facet has anything to check on this entity, for optional requirements: absent data passes. */
function present(m: Model, f: IDSFacet, id: number): boolean {
  switch (f.facet) {
    case 'attribute': {
      const l = m.line(id);
      // Only a null ($) attribute is absent; an empty string is a value that fails.
      return (
        !!l &&
        Object.keys(l).some((k) => !SKIP_KEYS.has(k) && matchesText(f.name, k) && l[k] !== null && l[k] !== undefined)
      );
    }
    case 'property':
      return propertySetsOf(m, id).some(
        (s) =>
          matchesText(f.propertySet, s.name) &&
          Object.values(s.properties).some((p) => matchesText(f.baseName, p.name)),
      );
    case 'classification':
      return classificationsOfEntity(m, id).length > 0;
    case 'material':
      return materialNames(m, id) !== undefined;
    default:
      return true;
  }
}

/** Why a specification cannot be checked as written (IDS 1.0 rules beyond the XML schema), or undefined. */
function invalidReason(s: IDSSpecification): string | undefined {
  if (s.maxOccurs === 0 && s.requirements.length) return 'a prohibited specification cannot have requirements';
  if (!s.applicability.length) return 'the applicability needs at least one facet';
}

/** Model schema names as IDS spells them. */
const idsSchema = (schema: string) => {
  const s = schema.toUpperCase();
  return s.startsWith('IFC2X3') ? 'IFC2X3' : s.startsWith('IFC4X3') ? 'IFC4X3_ADD2' : 'IFC4';
};

/**
 * Checks an open IFC model against an IDS document, as IDS 1.0 defines: each specification's applicability selects
 * entities (any IFC entity, not only products), each applicable entity must meet every requirement, and the
 * specification's minOccurs and maxOccurs say whether applicable entities are required, optional or prohibited. Values
 * compare in SI with the IDS tolerance. The model stays open.
 */
export function checkIDS(model: IFCModel, ids: IDSDocument, options: IDSCheckOptions = {}): IDSReport {
  checkModel(model);
  checkAbort(options.signal);
  if (!ids || !Array.isArray(ids.specifications)) fail('range', 'expected an IDSDocument; read the file with parseIDS');
  const data = options.data ?? readIFCData(model, { signal: options.signal });
  const m = new Model(model, data);
  const schema = idsSchema(model.schema);
  const specifications: IDSSpecificationResult[] = [];
  for (const spec of ids.specifications) {
    checkAbort(options.signal);
    const result: IDSSpecificationResult = {
      specification: spec,
      status: 'pass',
      applicable: [],
      passed: [],
      failures: [],
      warnings: [],
    };
    specifications.push(result);
    // The specification is still checked: the IDS test cases check IFC4 files against IFC2X3 specifications.
    if (!spec.ifcVersion.some((v) => v.toUpperCase() === schema))
      result.warnings.push(`the model is ${schema}; the specification is written for ${spec.ifcVersion.join(', ')}`);
    const invalid = invalidReason(spec);
    if (invalid) {
      result.status = 'fail';
      result.reason = `invalid IDS: ${invalid}`;
      continue;
    }
    const entity = spec.applicability.find((f): f is IDSEntityFacet => f.facet === 'entity');
    const candidates = entity ? entityCandidates(m, entity) : m.allIds();
    for (const id of candidates.sort((a, b) => a - b))
      if (spec.applicability.every((f) => verdict(m, f, id).ok)) result.applicable.push(id);
    if (spec.maxOccurs === 0) {
      if (result.applicable.length) {
        result.status = 'fail';
        result.reason = `${result.applicable.length} entities match a prohibited specification`;
      }
      continue;
    }
    if (spec.minOccurs >= 1 && !result.applicable.length) {
      result.status = 'fail';
      result.reason = 'no entity matches the applicability of a required specification';
      continue;
    }
    for (const id of result.applicable) {
      let ok = true;
      spec.requirements.forEach((r, index) => {
        let v: Verdict;
        if (r.cardinality === 'prohibited') {
          const required = verdict(m, r, id);
          v = required.ok ? no(`must not match ${r.facet} ${describeFacet(r)}`) : yes;
        } else if (r.cardinality === 'optional' && !present(m, r, id)) v = yes;
        else v = verdict(m, r, id);
        if (!v.ok) {
          ok = false;
          const e = data.elements.get(id);
          const failure: IDSFailure = { id, type: e?.type ?? m.type(id), requirement: index, reason: v.reason };
          if (e?.globalId) failure.globalId = e.globalId;
          if (e?.name) failure.name = e.name;
          result.failures.push(failure);
        }
      });
      if (ok) result.passed.push(id);
    }
    if (result.failures.length) result.status = 'fail';
  }
  return { pass: specifications.every((s) => s.status !== 'fail'), schema, title: ids.info.title, specifications };
}

function describeFacet(f: IDSFacet): string {
  switch (f.facet) {
    case 'entity':
      return describe(f.name);
    case 'attribute':
      return `${describe(f.name)}${f.value ? ` = ${describe(f.value)}` : ''}`;
    case 'classification':
      return [f.system && describe(f.system), f.value && describe(f.value)].filter(Boolean).join(' ');
    case 'property':
      return `${describe(f.propertySet)}.${describe(f.baseName)}${f.value ? ` = ${describe(f.value)}` : ''}`;
    case 'material':
      return f.value ? describe(f.value) : 'any material';
    case 'partOf':
      return describe(f.entity.name);
  }
}

/** Options of bcfTopicsFromIDS. */
export interface IDSBCFOptions {
  /** The topics' and comments' author, such as an e-mail address. */
  author: string;
  /** ISO 8601 date and time of the topics; default now. */
  date?: string;
  /** Topic type (default `Issue`), status (default `Open`) and labels (default `IDS`). */
  type?: string;
  status?: string;
  labels?: string[];
  /**
   * The viewpoints' camera (IFC world meters, as `bcfFromView` makes it). BCF 3.0 needs one; without it the topics
   * suit BCF 2.1 (`writeBCF({ topics }, { version: '2.1' })`).
   */
  camera?: BCFCamera;
}

/**
 * Turns the failed specifications of an IDS report into BCF topics, as the IDS developer guide recommends for
 * sharing results: one topic per failed specification, its description saying why, a viewpoint selecting the failing
 * elements by GlobalId and one comment per failure. Write them with `writeBCF({ topics })` from `/bcf`.
 */
export function bcfTopicsFromIDS(report: IDSReport, options: IDSBCFOptions): BCFTopic[] {
  if (!report || !Array.isArray(report.specifications)) fail('range', 'expected an IDSReport from checkIDS');
  if (typeof options?.author !== 'string' || !options.author)
    fail('range', 'bcfTopicsFromIDS needs an author; pass { author }');
  const date = options.date ?? new Date().toISOString();
  const topics: BCFTopic[] = [];
  for (const result of report.specifications) {
    if (result.status !== 'fail') continue;
    const spec = result.specification;
    const failedIds = [...new Set(result.failures.map((f) => f.id))];
    const lines = [
      spec.description,
      spec.instructions,
      result.reason ?? `${failedIds.length} of ${result.applicable.length} applicable entities fail its requirements`,
    ].filter((x): x is string => !!x);
    const viewpoint: BCFViewpoint = {
      guid: newBCFGuid(),
      selection: result.failures.filter((f) => f.globalId).map((f) => ({ ifcGuid: f.globalId! })),
      defaultVisibility: true,
      exceptions: [],
      spacesVisible: false,
      spaceBoundariesVisible: false,
      openingsVisible: false,
      coloring: [],
      lines: [],
      clippingPlanes: [],
      bitmaps: [],
    };
    if (options.camera) viewpoint.camera = options.camera;
    viewpoint.selection = viewpoint.selection.filter(
      (c, i, all) => all.findIndex((x) => x.ifcGuid === c.ifcGuid) === i,
    );
    topics.push({
      guid: newBCFGuid(),
      type: options.type ?? 'Issue',
      status: options.status ?? 'Open',
      title: `IDS: ${spec.name}`,
      labels: options.labels ?? ['IDS'],
      referenceLinks: [],
      creationDate: date,
      creationAuthor: options.author,
      description: lines.join('\n'),
      files: [],
      documentReferences: [],
      relatedTopics: [],
      comments: result.failures.map((f) => ({
        guid: newBCFGuid(),
        date,
        author: options.author,
        comment: `${f.name ?? f.type} (${f.globalId ?? `#${f.id}`}): ${f.reason}`,
        viewpoint: viewpoint.guid,
      })),
      viewpoints: [viewpoint],
    });
  }
  return topics;
}
