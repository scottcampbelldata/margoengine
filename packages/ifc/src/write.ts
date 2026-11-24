// Property write-back for an open IFC model, through the caller's web-ifc (CreateIfcEntity, CreateIfcType, WriteLine,
// DeleteLine, SaveModel). Edits follow the IFC resource and relationship rules of IFC 4.3 ADD2, IFC4 ADD2 TC1 and IFC2x3
// TC1: occurrence property sets attach through IfcRelDefinesByProperties, type sets through IfcTypeObject.HasPropertySets;
// a property set, relationship or property shared with other elements is copied before it changes (copy on write), so
// an edit of one element never changes another; new IfcRoot entities get a new IfcGloballyUniqueId and IfcOwnerHistory
// ADDED, changed ones an IfcOwnerHistory MODIFIED that keeps the owning user, application and creation date.
import { checkAbort, checkModel, deletedLines, fail, native, type IFCModel } from './open.js';
import { decode, refOf, refsOf, text, type Raw } from './raw.js';
import { checkStep } from './step.js';
import { QUANTITY_UNIT, readUnits, siScale, unitOf, unitTypeOfMeasure, type IFCUnit, type IFCUnits } from './units.js';

/** A scalar property value: a string (IfcLabel, or IfcText past 255 characters), a number (IfcReal) or a boolean. */
export type IFCScalarInput = string | number | boolean;
/**
 * A value with its IFC type, such as `{ type: 'IfcLengthMeasure', value: 0.25 }`. `value` is in SI (m, m2, kg, K, ...)
 * and is written in the project's unit for that measure, or in `unit` when given; `raw` is written as is instead.
 */
export interface IFCTypedValue {
  /** The IFC defined type, in any case: `IfcLabel`, `IfcBoolean`, `IfcLengthMeasure`, `IfcThermalTransmittanceMeasure`. */
  type: string;
  value?: IFCScalarInput | null;
  raw?: IFCScalarInput | null;
  /**
   * An SI unit symbol with an optional prefix, written as the property's own IfcSIUnit: `mm`, `m2`, `kg`, `kPa`, `degC`,
   * `ms`. Its unit type must be the measure's.
   */
  unit?: string;
}
/** What setProperty takes: a scalar, a typed value, or a list of either (an IfcPropertyListValue). */
export type IFCPropertyInput = IFCScalarInput | IFCTypedValue | readonly (IFCScalarInput | IFCTypedValue)[];
/** The IfcPhysicalSimpleQuantity subtypes. `number` (IfcQuantityNumber) is IFC4X3 only. */
export type IFCQuantityKind = 'length' | 'area' | 'volume' | 'count' | 'weight' | 'time' | 'number';
/** What setQuantity takes: a number in SI, or the quantity spelled out. */
export interface IFCQuantityInput {
  /** Required for a new quantity; an existing one keeps its kind. */
  kind?: IFCQuantityKind;
  /** In SI (m, m2, m3, kg, s), written in the project's unit (or `unit`). */
  value?: number;
  /** Written as is instead of `value`. */
  raw?: number;
  unit?: string;
  /** IfcPhysicalQuantity.Formula (IFC4 and later). */
  formula?: string;
}
/** An IfcApplication to record as the editing application. */
export interface IFCApplicationInput {
  name: string;
  version: string;
  /** A short identifier, such as `my-viewer`. */
  identifier: string;
  /** The developer organization's name. */
  developer: string;
}
/** A person and organization to record as the editing user. */
export interface IFCUserInput {
  givenName?: string;
  familyName?: string;
  organization: string;
}
/** Options of editIFC. */
export interface IFCEditOptions {
  /** The editing application. Default: the model's first owner history's application, else `Margo Engine`. */
  application?: IFCApplicationInput;
  /** The editing user. Default: the model's first owner history's user, else an unnamed person of `Unknown`. */
  user?: IFCUserInput;
  /** The time stamp of new owner histories. Default: now. */
  now?: Date;
}
/** Edits of one open model; every change is written into the model at once. Save with saveIFC. */
export interface IFCEditor {
  /**
   * Sets one property of an element's (or type object's) property set, creating the set when it has none of that
   * name. An element's set overrides its type's, so setting a type's property on an occurrence adds an occurrence set;
   * edit the type's ID to change every occurrence. Returns the property's expressID.
   */
  setProperty(id: number, set: string, name: string, value: IFCPropertyInput): number;
  /** Sets several properties of one set (null removes one). With `replace`, properties not listed are removed. */
  setPropertySet(id: number, set: string, values: Record<string, IFCPropertyInput | null>, options?: { replace?: boolean }): void;
  /** Removes a property; a set left empty is removed. False when the element's own sets do not hold it. */
  removeProperty(id: number, set: string, name: string): boolean;
  /** Detaches a property set or quantity set from the element, deleting what nothing else uses. */
  removePropertySet(id: number, set: string): boolean;
  /** Sets one quantity of an IfcElementQuantity, creating the set when missing. Returns the quantity's expressID. */
  setQuantity(id: number, set: string, name: string, value: number | IFCQuantityInput): number;
  removeQuantity(id: number, set: string, name: string): boolean;
  /** Sets the Name attribute. */
  rename(id: number, name: string): void;
  /**
   * Sets a direct attribute that holds a value (not a reference), in the file's units as `IFCElement.attributes` reads
   * it: text, numbers, booleans or an enumeration value such as `PARTITIONING`. null clears an optional IfcRoot text
   * attribute (Name, Description, ObjectType, Tag, LongName, ElementType, ApplicableOccurrence).
   */
  setAttribute(id: number, name: string, value: IFCScalarInput | null | { type: string; raw: IFCScalarInput }): void;
  /** expressIDs of the lines this editor created, in order. */
  readonly created: readonly number[];
  /** expressIDs of the lines this editor deleted. */
  readonly deleted: readonly number[];
}
/** Options of saveIFC. */
export interface IFCSaveOptions {
  signal?: AbortSignal;
}

const GUID_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const GUID = /^[0-3][0-9A-Za-z_$]{21}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * Compresses a UUID to the 22-character IfcGloballyUniqueId: the 128-bit number in base 64 with the digits
 * `0-9A-Za-z_$`, most significant first, so the first character holds the top 2 bits (0 to 3).
 */
export function ifcGuidFromUUID(uuid: string): string {
  if (typeof uuid !== 'string' || !UUID.test(uuid)) fail('range', 'expected a UUID such as 3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  let n = BigInt(`0x${uuid.replace(/-/g, '')}`),
    out = '';
  for (let i = 0; i < 22; i++, n >>= 6n) out = GUID_DIGITS[Number(n & 63n)] + out;
  return out;
}
/** Expands an IfcGloballyUniqueId to its lower-case UUID. */
export function uuidFromIFCGuid(guid: string): string {
  if (typeof guid !== 'string' || !GUID.test(guid)) fail('range', 'expected a 22-character IFC GUID whose first character is 0 to 3');
  let n = 0n;
  for (const c of guid) n = n * 64n + BigInt(GUID_DIGITS.indexOf(c));
  const h = n.toString(16).padStart(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** A new random IfcGloballyUniqueId (a version 4 UUID, RFC 9562, compressed). */
export function newIFCGuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return ifcGuidFromUUID([...b].map((x) => x.toString(16).padStart(2, '0')).join(''));
}

/**
 * Saves the model to IFC bytes (ISO 10303-21). web-ifc 0.0.78 writes a real with an exponent and no decimal point
 * (`1E-07`), which the ISO 10303-21 REAL grammar does not allow, so such reals get their point (`1.E-07`).
 */
export function saveIFC(model: IFCModel, options: IFCSaveOptions = {}): Uint8Array {
  checkModel(model);
  checkAbort(options.signal);
  const out = stepReals(native('saving the model', () => model.api.SaveModel(model.id)));
  checkAbort(options.signal);
  const syntax = checkStep(out);
  if (syntax) fail('unsupported', `web-ifc wrote malformed STEP (${syntax}); report the edit that caused it`);
  return out;
}

const isDigit = (c: number | undefined) => c !== undefined && c >= 48 && c <= 57;
const isWord = (c: number | undefined) =>
  c !== undefined && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || isDigit(c));
/** Inserts the decimal point ISO 10303-21 requires into reals written as `1E-07`. Strings and names are skipped. */
function stepReals(data: Uint8Array): Uint8Array {
  const at: number[] = [];
  for (let p = 0, n = data.length; p < n; ) {
    const c = data[p]!;
    if (c === 39 || c === 34) {
      // 'text' ('' is a quote) or "binary".
      for (p++; p < n; p++) if (data[p] === c && data[++p] !== c) break;
    } else if (c === 47 && data[p + 1] === 42) {
      let q = data.indexOf(42, p + 2);
      while (q >= 0 && data[q + 1] !== 47) q = data.indexOf(42, q + 1);
      p = q < 0 ? n : q + 2;
    } else if (c === 35 || (isWord(c) && !isDigit(c))) {
      // #123, or a keyword such as IFC2DCOMPOSITECURVE.
      for (p++; isWord(data[p]); p++);
    } else if (isDigit(c)) {
      let point = false;
      for (; isDigit(data[p]) || data[p] === 46; p++) point ||= data[p] === 46;
      if ((data[p] === 69 || data[p] === 101) && !point) at.push(p);
      if (data[p] === 69 || data[p] === 101) for (p++; isDigit(data[p]) || data[p] === 43 || data[p] === 45; p++);
    } else p++;
  }
  if (!at.length) return data;
  const out = new Uint8Array(data.length + at.length);
  let from = 0,
    to = 0;
  for (const p of at) {
    out.set(data.subarray(from, p), to);
    to += p - from;
    out[to++] = 46;
    from = p;
  }
  out.set(data.subarray(from), to);
  return out;
}

const SI_UNITS: Record<string, [string, string]> = {
  m: ['LENGTHUNIT', 'METRE'],
  m2: ['AREAUNIT', 'SQUARE_METRE'],
  m3: ['VOLUMEUNIT', 'CUBIC_METRE'],
  g: ['MASSUNIT', 'GRAM'],
  s: ['TIMEUNIT', 'SECOND'],
  rad: ['PLANEANGLEUNIT', 'RADIAN'],
  sr: ['SOLIDANGLEUNIT', 'STERADIAN'],
  K: ['THERMODYNAMICTEMPERATUREUNIT', 'KELVIN'],
  degC: ['THERMODYNAMICTEMPERATUREUNIT', 'DEGREE_CELSIUS'],
  A: ['ELECTRICCURRENTUNIT', 'AMPERE'],
  mol: ['AMOUNTOFSUBSTANCEUNIT', 'MOLE'],
  cd: ['LUMINOUSINTENSITYUNIT', 'CANDELA'],
  N: ['FORCEUNIT', 'NEWTON'],
  Pa: ['PRESSUREUNIT', 'PASCAL'],
  J: ['ENERGYUNIT', 'JOULE'],
  W: ['POWERUNIT', 'WATT'],
  Hz: ['FREQUENCYUNIT', 'HERTZ'],
  V: ['ELECTRICVOLTAGEUNIT', 'VOLT'],
  C: ['ELECTRICCHARGEUNIT', 'COULOMB'],
  F: ['ELECTRICCAPACITANCEUNIT', 'FARAD'],
  ohm: ['ELECTRICRESISTANCEUNIT', 'OHM'],
  S: ['ELECTRICCONDUCTANCEUNIT', 'SIEMENS'],
  Wb: ['MAGNETICFLUXUNIT', 'WEBER'],
  T: ['MAGNETICFLUXDENSITYUNIT', 'TESLA'],
  H: ['INDUCTANCEUNIT', 'HENRY'],
  lm: ['LUMINOUSFLUXUNIT', 'LUMEN'],
  lx: ['ILLUMINANCEUNIT', 'LUX'],
  Bq: ['RADIOACTIVITYUNIT', 'BECQUEREL'],
  Gy: ['ABSORBEDDOSEUNIT', 'GRAY'],
  Sv: ['DOSEEQUIVALENTUNIT', 'SIEVERT'],
};
const SI_PREFIXES: Record<string, string> = {
  E: 'EXA',
  P: 'PETA',
  T: 'TERA',
  G: 'GIGA',
  M: 'MEGA',
  k: 'KILO',
  h: 'HECTO',
  da: 'DECA',
  d: 'DECI',
  c: 'CENTI',
  m: 'MILLI',
  u: 'MICRO',
  µ: 'MICRO',
  n: 'NANO',
  p: 'PICO',
  f: 'FEMTO',
  a: 'ATTO',
};
/** `kPa` to [unit type, prefix, name]; the whole symbol is tried first, so `m` is a metre and `cd` a candela. */
function parseUnit(symbol: string): [string, string | null, string] {
  const whole = SI_UNITS[symbol];
  if (whole) return [whole[0], null, whole[1]];
  for (const length of [2, 1]) {
    const prefix = SI_PREFIXES[symbol.slice(0, length)],
      unit = SI_UNITS[symbol.slice(length)];
    if (prefix && unit && symbol.slice(length) !== 'degC') return [unit[0], prefix, unit[1]];
  }
  return fail('range', `unknown unit ${JSON.stringify(symbol)}; use an SI symbol with an optional prefix, such as mm, m2, kg or kPa`);
}

const QUANTITIES: Record<IFCQuantityKind, [string, string, string]> = {
  length: ['IFCQUANTITYLENGTH', 'LengthValue', 'IFCLENGTHMEASURE'],
  area: ['IFCQUANTITYAREA', 'AreaValue', 'IFCAREAMEASURE'],
  volume: ['IFCQUANTITYVOLUME', 'VolumeValue', 'IFCVOLUMEMEASURE'],
  count: ['IFCQUANTITYCOUNT', 'CountValue', 'IFCCOUNTMEASURE'],
  weight: ['IFCQUANTITYWEIGHT', 'WeightValue', 'IFCMASSMEASURE'],
  time: ['IFCQUANTITYTIME', 'TimeValue', 'IFCTIMEMEASURE'],
  number: ['IFCQUANTITYNUMBER', 'NumberValue', 'IFCNUMERICMEASURE'],
};
// Lines whose references are counted to tell shared property sets and properties from exclusive ones.
const HOLDERS = [
  'IFCRELDEFINESBYPROPERTIES',
  'IFCRELDEFINESBYTEMPLATE',
  'IFCTYPEOBJECT',
  'IFCPROPERTYSET',
  'IFCELEMENTQUANTITY',
  'IFCCOMPLEXPROPERTY',
  'IFCPHYSICALCOMPLEXQUANTITY',
  'IFCEXTENDEDMATERIALPROPERTIES',
  'IFCEXTENDEDPROPERTIES',
  'IFCPROPERTYDEPENDENCYRELATIONSHIP',
  'IFCPROPERTYCONSTRAINTRELATIONSHIP',
  'IFCRESOURCECONSTRAINTRELATIONSHIP',
  'IFCRESOURCEAPPROVALRELATIONSHIP',
];
// Attributes listing the parts a property container owns; deleting the container deletes parts nothing else uses.
const PARTS = ['HasProperties', 'Quantities', 'HasQuantities'];
const OPTIONAL_TEXT: Record<string, string> = {
  Name: 'IFCLABEL',
  Description: 'IFCTEXT',
  ObjectType: 'IFCLABEL',
  Tag: 'IFCIDENTIFIER',
  LongName: 'IFCLABEL',
  ElementType: 'IFCLABEL',
  ApplicableOccurrence: 'IFCIDENTIFIER',
};
const ENUM_VALUE = /^[A-Z][A-Z0-9_]*$/;
const SET_KINDS = { property: ['IFCPROPERTYSET', 'HasProperties'], quantity: ['IFCELEMENTQUANTITY', 'Quantities'] } as const;
type SetKind = keyof typeof SET_KINDS;

/** The SI to file-unit inverse of `si = raw * scale + shift`, rounded to 15 significant digits to drop the 1 ulp
 * residue of a decimal scale (0.2 / 0.001 is 200.00000000000003 in binary64). */
const toRaw = (si: number, unit: IFCUnit | undefined) =>
  !unit || (unit.scale === 1 && unit.shift === 0) ? si : Number(((si - unit.shift) / unit.scale).toPrecision(15));

/** Starts editing an open model. The editor writes into the model at once; readIFCData reads the edits back. */
export function editIFC(model: IFCModel, options: IFCEditOptions = {}): IFCEditor {
  checkModel(model);
  const { api, id: modelId } = model;
  const now = Math.floor((options.now === undefined ? Date.now() : options.now instanceof Date ? options.now.getTime() : Number.NaN) / 1000);
  if (!Number.isSafeInteger(now)) fail('range', 'now must be a valid Date');
  const ifc2x3 = model.schema.toUpperCase() === 'IFC2X3';
  const lines = new Map<number, Raw>();
  const gone = deletedLines(model);
  const get = (expressID: number): Raw => {
    let l = lines.get(expressID);
    if (l === undefined) {
      l = native('reading a line', () => api.GetLine(modelId, expressID));
      if (!l) fail('range', `line #${expressID} does not exist`);
      lines.set(expressID, l);
    }
    return l;
  };
  // web-ifc 0.0.78 writes a single reference only when it is its own Handle class (a plain { type: 5, value } fails in
  // WriteLine), so new references are made with the constructor of a reference the model already holds.
  let Handle: (new (value: number) => Raw) | undefined;
  const handleIn = (v: Raw): typeof Handle =>
    Array.isArray(v)
      ? v.map(handleIn).find(Boolean)
      : v && v.type === 5 && typeof v.value === 'number' && v.constructor !== Object
        ? v.constructor
        : undefined;
  const ref = (value: number): Raw => {
    if (!Handle) {
      const scan = (l: Raw) => {
        for (const key of Object.keys(l ?? {})) if (!Handle) Handle = handleIn(l[key]);
      };
      for (const l of lines.values()) scan(l);
      const all = Handle ? undefined : native('listing lines', () => api.GetAllLines(modelId));
      for (let i = 0; !Handle && all && i < all.size(); i++) scan(get(all.get(i)));
      if (!Handle) fail('unsupported', 'the model holds no references to copy; it has nothing to edit');
    }
    return new Handle!(value);
  };
  const names = new Map<number, string>();
  const kindOf = (l: Raw): string => {
    let name = names.get(l.type);
    if (name === undefined) names.set(l.type, (name = native('reading a type name', () => api.GetNameFromTypeCode(l.type)).toUpperCase()));
    return name;
  };
  const ids = (name: string, inherited = false): number[] => {
    let vector;
    try {
      vector = api.GetLineIDsWithType(modelId, api.GetTypeCodeFromName(name), inherited);
    } catch {
      // A class the model's schema does not have (IfcRelDefinesByTemplate in IFC2X3) has no lines.
      return [];
    }
    const out: number[] = [];
    for (let i = 0; i < vector.size(); i++) if (!gone.has(vector.get(i))) out.push(vector.get(i));
    return out;
  };
  const create = (name: string): Raw => {
    let entity: Raw;
    try {
      entity = api.CreateIfcEntity(modelId, api.GetTypeCodeFromName(name));
    } catch {}
    if (!entity) fail('unsupported', `${model.schema} has no ${name}; it needs a newer schema`);
    return entity;
  };
  const typed = (type: string, value: unknown): Raw => {
    let out: Raw;
    try {
      out = api.CreateIfcType(modelId, api.GetTypeCodeFromName(type), value);
    } catch {}
    if (!out) fail('range', `${model.schema} has no defined type ${type}; use one of its types, such as IfcLabel or IfcLengthMeasure`);
    return out;
  };

  // Reference counts among property containers and relationships, kept current by every write. Each indexed line
  // keeps the references it was counted with, since edits change the cached line objects before they are written.
  const counts = new Map<number, number>();
  const indexed = new Map<number, { refs: number[]; objects: number[] }>();
  const byObject = new Map<number, number[]>();
  const index = (l: Raw) => {
    const refs: number[] = [];
    for (const key of Object.keys(l)) if (key !== 'OwnerHistory') refs.push(...refsOf(l[key]));
    const objects = kindOf(l) === 'IFCRELDEFINESBYPROPERTIES' ? refsOf(l.RelatedObjects) : [];
    for (const r of refs) counts.set(r, (counts.get(r) ?? 0) + 1);
    for (const o of objects) byObject.set(o, [...(byObject.get(o) ?? []), l.expressID]);
    indexed.set(l.expressID, { refs, objects });
  };
  const unindex = (expressID: number) => {
    const entry = indexed.get(expressID);
    if (!entry) return;
    for (const r of entry.refs) counts.set(r, counts.get(r)! - 1);
    for (const o of entry.objects) byObject.set(o, byObject.get(o)!.filter((rel) => rel !== expressID));
    indexed.delete(expressID);
  };
  for (const name of HOLDERS) for (const holder of ids(name, true)) if (!indexed.has(holder)) index(get(holder));
  const types = new Set(ids('IFCTYPEOBJECT', true));
  const objects = new Set(ids('IFCOBJECTDEFINITION', true));

  const created: number[] = [],
    deleted: number[] = [];
  const createdSet = new Set<number>();
  /** Writes a line (new when expressID is unset) and keeps the reference counts current. */
  const put = (l: Raw, holder = indexed.has(l.expressID)): number => {
    if (l.expressID === undefined || l.expressID < 0) {
      l.expressID = native('reading the largest expressID', () => api.GetMaxExpressID(modelId)) + 1;
      created.push(l.expressID);
      createdSet.add(l.expressID);
    }
    unindex(l.expressID);
    native('writing a line', () => api.WriteLine(modelId, l));
    lines.set(l.expressID, l);
    if (holder) index(l);
    return l.expressID;
  };
  const remove = (expressID: number) => {
    const l = get(expressID);
    unindex(expressID);
    native('deleting a line', () => api.DeleteLine(modelId, expressID));
    lines.delete(expressID);
    gone.add(expressID);
    deleted.push(expressID);
    // Parts nothing else uses go with their container.
    for (const key of PARTS) for (const part of refsOf(l[key])) if (!counts.get(part)) remove(part);
  };
  /** A new entity with every attribute set ($ unless given); `keep` names derived attributes web-ifc writes as `*`. */
  const entity = (name: string, fields: Record<string, unknown>, keep: string[] = []): Raw => {
    const e = create(name);
    for (const key of Object.keys(e)) if (e[key] === undefined && !keep.includes(key)) e[key] = null;
    for (const [key, value] of Object.entries(fields)) {
      if (!(key in e)) fail('unsupported', `${model.schema} ${name} has no ${key}`);
      e[key] = value;
    }
    return e;
  };

  // Owner histories.
  const firstHistory = ids('IFCOWNERHISTORY').sort((a, b) => a - b)[0];
  const histories = ifc2x3 || firstHistory !== undefined || !!options.user || !!options.application;
  let user: number | undefined, application: number | undefined, added: number | undefined;
  // LOGICAL UNKNOWN is .U.
  const wrap = (type: string, raw: unknown) => typed(type, type === 'IFCLOGICAL' && raw === null ? 'U' : raw);
  const label = (value: string) => typed('IFCLABEL', value);
  const organization = (name: string) => put(entity('IFCORGANIZATION', { Name: label(name) }));
  const sessionUser = (): number => {
    if (user !== undefined) return user;
    const existing = firstHistory !== undefined ? refOf(get(firstHistory).OwningUser) : undefined;
    if (!options.user && existing !== undefined) return (user = existing);
    const u = options.user ?? { organization: 'Unknown' };
    if (typeof u.organization !== 'string' || !u.organization) fail('range', 'user.organization must be a non-empty string');
    const person = put(
      entity('IFCPERSON', {
        FamilyName: u.familyName === undefined ? null : label(u.familyName),
        // IFC2x3 and IFC4 need a family or given name.
        GivenName: u.givenName === undefined ? (u.familyName === undefined ? label('Unknown') : null) : label(u.givenName),
      }),
    );
    return (user = put(entity('IFCPERSONANDORGANIZATION', { ThePerson: ref(person), TheOrganization: ref(organization(u.organization)) })));
  };
  const sessionApplication = (): number => {
    if (application !== undefined) return application;
    const existing = firstHistory !== undefined ? refOf(get(firstHistory).OwningApplication) : undefined;
    if (!options.application && existing !== undefined) return (application = existing);
    const a = options.application ?? { name: 'Margo Engine', version: '1.0.0', identifier: 'margoengine', developer: 'Margo Engine' };
    for (const key of ['name', 'version', 'identifier', 'developer'] as const)
      if (typeof a[key] !== 'string' || !a[key]) fail('range', `application.${key} must be a non-empty string`);
    return (application = put(
      entity('IFCAPPLICATION', {
        ApplicationDeveloper: ref(organization(a.developer)),
        Version: label(a.version),
        ApplicationFullName: label(a.name),
        ApplicationIdentifier: typed('IFCIDENTIFIER', a.identifier),
      }),
    ));
  };
  const history = (action: string, from?: Raw): Raw =>
    entity('IFCOWNERHISTORY', {
      OwningUser: from?.OwningUser ?? ref(sessionUser()),
      OwningApplication: from?.OwningApplication ?? ref(sessionApplication()),
      State: from?.State ?? null,
      ChangeAction: { type: 3, value: action },
      // IFC4 CorrectChangeAction: ADDED and MODIFIED need LastModifiedDate.
      LastModifiedDate: typed('IFCTIMESTAMP', now),
      LastModifyingUser: ref(sessionUser()),
      LastModifyingApplication: ref(sessionApplication()),
      CreationDate: from?.CreationDate ?? typed('IFCTIMESTAMP', now),
    });
  const addedHistory = (): Raw => {
    if (!histories) return null;
    if (added === undefined) added = put(history('ADDED'));
    return ref(added);
  };
  const modified = new Map<number | null, number>();
  /** Marks an IfcRoot line as changed by this session (before it is written). */
  const touch = (l: Raw) => {
    if (!('GlobalId' in l) || createdSet.has(l.expressID) || !histories) return;
    const old = refOf(l.OwnerHistory) ?? null;
    if (old !== null && createdSet.has(old)) return;
    let next = modified.get(old);
    if (next === undefined) modified.set(old, (next = put(history('MODIFIED', old === null ? undefined : get(old)))));
    l.OwnerHistory = ref(next);
  };
  const root = (name: string, fields: Record<string, unknown>) =>
    entity(name, { GlobalId: typed('IFCGLOBALLYUNIQUEID', newIFCGuid()), OwnerHistory: addedHistory(), ...fields });

  // Units.
  let units: IFCUnits | undefined;
  const projectUnit = (unitType: string | undefined): IFCUnit | undefined => {
    if (!unitType) return;
    units ??= readUnits(
      (expressID) => (expressID === undefined ? undefined : get(expressID)),
      kindOf,
      (name) => ids(name).sort((a, b) => a - b),
    );
    return units.byType[unitType];
  };
  const unitLines = new Map<string, number>();
  /** The IfcSIUnit for a symbol, reused when the model has it; checked against the measure's unit type. */
  const siUnitLine = (symbol: string, measure: string): [number, IFCUnit] => {
    const [unitType, prefix, name] = parseUnit(symbol);
    const needed = unitTypeOfMeasure(measure);
    if (needed !== unitType) fail('range', `unit ${symbol} is a ${unitType}, but ${measure} takes ${needed ?? 'no unit'}`);
    const key = `${unitType} ${prefix} ${name}`;
    let found = unitLines.get(key);
    if (found === undefined) {
      found = ids('IFCSIUNIT').find((u) => {
        const l = get(u);
        return l.UnitType?.value === unitType && (l.Prefix?.value ?? null) === prefix && l.Name?.value === name;
      });
      found ??= put(
        entity(
          'IFCSIUNIT',
          { UnitType: { type: 3, value: unitType }, Prefix: prefix ? { type: 3, value: prefix } : null, Name: { type: 3, value: name } },
          ['Dimensions'],
        ),
      );
      unitLines.set(key, found);
    }
    return [found, { ...siScale(prefix, name), symbol, name: key }];
  };
  const explicitUnit = (unitRef: number | undefined): IFCUnit | undefined =>
    unitRef === undefined ? undefined : unitOf(get(unitRef), (expressID) => (expressID === undefined ? undefined : get(expressID)), kindOf);

  /** A typed IFC value from an input; `hint` is the type and unit the property has now. */
  const value = (
    input: IFCScalarInput | IFCTypedValue,
    hint: { type?: string; unit?: number },
    what: string,
  ): { wrapper: Raw; type: string; unit?: number } => {
    const plain = typeof input !== 'object' || input === null;
    if (!plain && (typeof input.type !== 'string' || !input.type)) fail('range', `${what}: a typed value needs a type such as IfcLabel`);
    const given = plain ? input : (input.raw !== undefined ? input.raw : input.value);
    if (given === undefined) fail('range', `${what}: a typed value needs value or raw`);
    const kindOfValue = given === null ? 'null' : typeof given;
    if (!['string', 'number', 'boolean', 'null'].includes(kindOfValue)) fail('range', `${what}: expected a string, number or boolean`);
    let type = plain ? undefined : input.type.toUpperCase();
    // A plain value keeps the property's type when it fits.
    if (type === undefined && hint.type && fits(hint.type, given)) type = hint.type;
    type ??= typeof given === 'string' ? ([...given].length > 255 ? 'IFCTEXT' : 'IFCLABEL') : typeof given === 'boolean' ? 'IFCBOOLEAN' : 'IFCREAL';
    if (!fits(type, given)) fail('range', `${what}: ${JSON.stringify(given)} is not a valid ${type}`);
    let unit: number | undefined, convert: IFCUnit | undefined;
    if (!plain && input.unit !== undefined) [unit, convert] = siUnitLine(input.unit, type);
    else if (type === hint.type && hint.unit !== undefined) convert = explicitUnit((unit = hint.unit));
    else convert = projectUnit(unitTypeOfMeasure(type));
    let raw = given;
    if (typeof given === 'number' && (plain || input.raw === undefined)) raw = toRaw(given, convert);
    check(type, raw, what);
    return { wrapper: wrap(type, raw), type, unit };
  };

  // Property sets of an element.
  const objectOf = (id: number) => {
    if (!Number.isSafeInteger(id) || !objects.has(id)) fail('range', `#${id} is not an object or type object; pass an expressID from readIFCData`);
    return types.has(id);
  };
  const setsOf = (id: number): { set: number; rel?: number }[] => {
    if (types.has(id)) return refsOf(get(id).HasPropertySets).map((set) => ({ set }));
    const out: { set: number; rel?: number }[] = [];
    for (const rel of byObject.get(id) ?? []) for (const set of refsOf(get(rel).RelatingPropertyDefinition)) out.push({ set, rel });
    return out;
  };
  const findSet = (id: number, name: string, kind?: SetKind) =>
    setsOf(id).find(({ set }) => {
      const l = get(set);
      return text(l.Name) === name && (kind ? kindOf(l) === SET_KINDS[kind][0] : kindOf(l) in { IFCPROPERTYSET: 1, IFCELEMENTQUANTITY: 1 });
    });
  const replaceRef = (v: Raw, from: number, to: number | null): Raw =>
    Array.isArray(v) ? v.flatMap((r) => (refOf(r) === from ? (to === null ? [] : [ref(to)]) : [r])) : refOf(v) === from ? (to === null ? null : ref(to)) : v;
  /** Makes the relationship and the set exclusive to the element (copying shared ones) and returns the set's ID. */
  const own = (id: number, found: { set: number; rel?: number }): number => {
    let { set, rel } = found;
    if (rel !== undefined) {
      const r = get(rel);
      if (refsOf(r.RelatedObjects).length > 1) {
        touch(r);
        r.RelatedObjects = replaceRef(r.RelatedObjects, id, null);
        put(r);
        rel = put(root('IFCRELDEFINESBYPROPERTIES', { Name: r.Name, Description: r.Description, RelatedObjects: [ref(id)], RelatingPropertyDefinition: r.RelatingPropertyDefinition }), true);
      }
    }
    if ((counts.get(set) ?? 0) > 1) {
      const old = get(set),
        copy = create(kindOf(old));
      for (const key of Object.keys(copy)) copy[key] = key === 'expressID' || key === 'type' ? copy[key] : (old[key] ?? null);
      copy.GlobalId = typed('IFCGLOBALLYUNIQUEID', newIFCGuid());
      copy.OwnerHistory = addedHistory();
      const next = put(copy, true);
      const holder = rel !== undefined ? get(rel) : get(id);
      const key = rel !== undefined ? 'RelatingPropertyDefinition' : 'HasPropertySets';
      touch(holder);
      holder[key] = replaceRef(holder[key], set, next);
      put(holder);
      set = next;
    }
    return set;
  };
  /** Adds a new set holding `parts` to the element. */
  const addSet = (id: number, kind: SetKind, name: string, parts: number[]): number => {
    const set = put(
      root(SET_KINDS[kind][0], { Name: label(name), [SET_KINDS[kind][1]]: parts.map(ref) }),
      true,
    );
    if (types.has(id)) {
      const t = get(id);
      touch(t);
      t.HasPropertySets = [...(t.HasPropertySets ?? []), ref(set)];
      put(t);
    } else put(root('IFCRELDEFINESBYPROPERTIES', { RelatedObjects: [ref(id)], RelatingPropertyDefinition: ref(set) }), true);
    return set;
  };
  /** Detaches a set from the element and deletes it when nothing else uses it. */
  const detach = (id: number, found: { set: number; rel?: number }) => {
    if (found.rel === undefined) {
      const t = get(id);
      touch(t);
      const left = replaceRef(t.HasPropertySets, found.set, null);
      t.HasPropertySets = left.length ? left : null;
      put(t);
    } else {
      const r = get(found.rel),
        others = refsOf(r.RelatedObjects).length > 1,
        defs = refsOf(r.RelatingPropertyDefinition).filter((d) => d !== found.set);
      if (others) {
        touch(r);
        r.RelatedObjects = replaceRef(r.RelatedObjects, id, null);
        put(r);
        if (defs.length)
          put(root('IFCRELDEFINESBYPROPERTIES', { Name: r.Name, Description: r.Description, RelatedObjects: [ref(id)], RelatingPropertyDefinition: replaceRef(r.RelatingPropertyDefinition, found.set, null) }), true);
      } else if (defs.length) {
        touch(r);
        r.RelatingPropertyDefinition = replaceRef(r.RelatingPropertyDefinition, found.set, null);
        put(r);
      } else remove(found.rel);
    }
    if (!counts.get(found.set)) remove(found.set);
  };
  /** Writes `part` (a new property or quantity line) into the element's set, replacing the part of that name. */
  const writePart = (id: number, kind: SetKind, setName: string, name: string, build: (old: Raw | undefined) => Raw): number => {
    objectOf(id);
    if (typeof setName !== 'string' || !setName) fail('range', 'the set name must be a non-empty string');
    if (typeof name !== 'string' || !name) fail('range', 'the property name must be a non-empty string');
    const found = findSet(id, setName, kind);
    const oldSet = found ? get(found.set) : undefined;
    const oldPart = oldSet && refsOf(oldSet[SET_KINDS[kind][1]]).find((p) => text(get(p).Name) === name);
    const line = build(oldPart === undefined ? undefined : get(oldPart));
    if (!found) {
      addSet(id, kind, setName, [put(line)]);
      return line.expressID;
    }
    const set = get(own(id, found));
    if (oldPart !== undefined && counts.get(oldPart) === 1) {
      // The set is the part's only user: rewrite it in place, keeping its expressID.
      const before = get(oldPart);
      line.expressID = oldPart;
      put(line);
      for (const key of PARTS) for (const p of refsOf(before[key])) if (!counts.get(p)) remove(p);
      touch(set);
      put(set);
      return oldPart;
    }
    const part = put(line);
    touch(set);
    const key = SET_KINDS[kind][1];
    set[key] = oldPart === undefined ? [...set[key], ref(part)] : replaceRef(set[key], oldPart, part);
    put(set);
    if (oldPart !== undefined && !counts.get(oldPart)) remove(oldPart);
    return part;
  };
  const removePart = (id: number, kind: SetKind, setName: string, name: string): boolean => {
    objectOf(id);
    const found = findSet(id, setName, kind);
    if (!found) return false;
    const key = SET_KINDS[kind][1];
    const part = refsOf(get(found.set)[key]).find((p) => text(get(p).Name) === name);
    if (part === undefined) return false;
    if (refsOf(get(found.set)[key]).length === 1) return detach(id, found), true;
    const set = get(own(id, found));
    touch(set);
    set[key] = replaceRef(set[key], part, null);
    put(set);
    if (!counts.get(part)) remove(part);
    return true;
  };

  /** Builds the property line for an input; an existing property keeps its other attributes (Description, ...). */
  const property = (name: string, input: IFCPropertyInput, old: Raw | undefined): Raw => {
    const what = `property ${name}`;
    const oldKind = old ? kindOf(old) : undefined;
    const many = Array.isArray(input);
    const enumerated = oldKind === 'IFCPROPERTYENUMERATEDVALUE' && (many ? input : [input]).every((v) => typeof v === 'string' || (typeof v === 'object' && v !== null && typeof (v as IFCTypedValue).value === 'string'));
    const kind = enumerated ? 'IFCPROPERTYENUMERATEDVALUE' : many ? 'IFCPROPERTYLISTVALUE' : 'IFCPROPERTYSINGLEVALUE';
    const e = entity(kind, {});
    if (old) for (const key of Object.keys(e)) if (key !== 'expressID' && key !== 'type' && key in old) e[key] = old[key] ?? null;
    e.Name = typed('IFCIDENTIFIER', name);
    const firstOld = oldKind === 'IFCPROPERTYSINGLEVALUE' ? old.NominalValue : (old?.ListValues ?? old?.EnumerationValues)?.[0];
    const hint = { type: typeof firstOld?.name === 'string' ? firstOld.name.toUpperCase() : undefined, unit: refOf(old?.Unit) };
    const values = (many ? (input as readonly (IFCScalarInput | IFCTypedValue)[]) : [input as IFCScalarInput | IFCTypedValue]).map((v) => value(v, hint, what));
    if (!values.length) fail('range', `${what}: a list needs at least one value`);
    if (values.some((v) => v.type !== values[0]!.type)) fail('range', `${what}: every value of a list must have one type`);
    if (enumerated) {
      const reference = refOf(old.EnumerationReference);
      if (reference !== undefined) {
        const allowed = (get(reference).EnumerationValues ?? []).map((v: Raw) => decode(v));
        for (const v of values)
          if (!allowed.includes(decode(v.wrapper))) fail('range', `${what}: ${JSON.stringify(decode(v.wrapper))} is not one of ${allowed.join(', ')}`);
      }
      e.EnumerationValues = values.map((v) => v.wrapper);
    } else if (many) e.ListValues = values.map((v) => v.wrapper);
    else e.NominalValue = values[0]!.wrapper;
    if ('Unit' in e && kind !== 'IFCPROPERTYENUMERATEDVALUE') e.Unit = values[0]!.unit === undefined ? null : ref(values[0]!.unit);
    return e;
  };
  const quantity = (name: string, input: number | IFCQuantityInput, old: Raw | undefined): Raw => {
    const what = `quantity ${name}`;
    const spec: IFCQuantityInput = typeof input === 'number' ? { value: input } : input;
    if (!spec || typeof spec !== 'object') fail('range', `${what}: expected a number or { kind, value }`);
    const oldKind = old ? (Object.entries(QUANTITIES).find(([, q]) => q[0] === kindOf(old))?.[0] as IFCQuantityKind | undefined) : undefined;
    const kind: IFCQuantityKind | undefined = spec.kind ?? oldKind;
    if (!kind || !QUANTITIES[kind]) return fail('range', `${what}: a new quantity needs kind (length, area, volume, count, weight, time or number)`);
    const [entityName, key, measure] = QUANTITIES[kind];
    const e = entity(entityName, {});
    if (old && kind === oldKind) for (const k of Object.keys(e)) if (k !== 'expressID' && k !== 'type' && k in old) e[k] = old[k] ?? null;
    e.Name = label(name);
    const given = spec.raw ?? spec.value;
    if (typeof given !== 'number' || !Number.isFinite(given)) fail('range', `${what}: expected a finite number`);
    let unit: IFCUnit | undefined;
    if (spec.unit !== undefined) {
      const [line, scale] = siUnitLine(spec.unit, measure);
      e.Unit = ref(line);
      unit = scale;
    } else if (old && kind === oldKind && refOf(old.Unit) !== undefined) unit = explicitUnit(refOf(old.Unit));
    else unit = projectUnit(QUANTITY_UNIT[entityName]);
    const raw = spec.raw !== undefined ? spec.raw : toRaw(spec.value!, unit);
    // IFC4 and IFC4X3 rule WR21 of each simple quantity: the value is not negative.
    if (raw < 0) fail('range', `${what}: quantities must not be negative`);
    e[key] = typed(measure, raw);
    if (spec.formula !== undefined) {
      if (!('Formula' in e)) fail('unsupported', `${model.schema} quantities have no Formula`);
      e.Formula = typed('IFCLABEL', spec.formula);
    }
    return e;
  };

  const editor: IFCEditor = {
    created,
    deleted,
    setProperty: (id, set, name, input) => writePart(id, 'property', set, name, (old) => property(name, input, old)),
    setPropertySet(id, set, values, opts = {}) {
      if (!values || typeof values !== 'object') fail('range', 'values must be an object of property names to values');
      for (const [name, input] of Object.entries(values))
        if (input === null) editor.removeProperty(id, set, name);
        else editor.setProperty(id, set, name, input);
      if (opts.replace) {
        const found = findSet(id, set, 'property');
        if (found)
          for (const part of refsOf(get(found.set).HasProperties)) {
            const name = text(get(part).Name);
            if (name !== undefined && !(name in values)) editor.removeProperty(id, set, name);
          }
      }
    },
    removeProperty: (id, set, name) => removePart(id, 'property', set, name),
    removePropertySet(id, set) {
      objectOf(id);
      const found = findSet(id, set);
      if (!found) return false;
      detach(id, found);
      return true;
    },
    setQuantity: (id, set, name, input) => writePart(id, 'quantity', set, name, (old) => quantity(name, input, old)),
    removeQuantity: (id, set, name) => removePart(id, 'quantity', set, name),
    rename: (id, name) => editor.setAttribute(id, 'Name', name),
    setAttribute(id, name, input) {
      if (!Number.isSafeInteger(id) || id <= 0) fail('range', 'expected an expressID');
      const l = get(id);
      if (typeof name !== 'string' || !(name in l) || ['expressID', 'type', 'GlobalId', 'OwnerHistory'].includes(name))
        fail('range', `#${id} has no attribute ${JSON.stringify(name)} that can be set`);
      const current = l[name];
      if (refsOf(current).length || (current && current.type === 5) || (Array.isArray(current) && current.length))
        fail('range', `${name} holds references or a list; setAttribute sets single values`);
      if (input === null) {
        if (!(name in OPTIONAL_TEXT) || !('GlobalId' in l)) fail('range', `${name} cannot be cleared; only optional IfcRoot text attributes can`);
        l[name] = null;
      } else if (typeof input === 'object') {
        if (typeof input.type !== 'string') fail('range', 'a typed attribute value needs a type');
        const type = input.type.toUpperCase();
        check(type, input.raw, name);
        l[name] = wrap(type, input.raw);
      } else if (current && current.type === 3 && !current.name) {
        if (typeof input !== 'string' || !ENUM_VALUE.test(input)) fail('range', `${name} is an enumeration; pass a value such as NOTDEFINED`);
        l[name] = { type: 3, value: input };
      } else if (!current && (name === 'PredefinedType' || name === 'CompositionType')) {
        if (typeof input !== 'string' || !ENUM_VALUE.test(input)) fail('range', `${name} is an enumeration; pass a value such as NOTDEFINED`);
        l[name] = { type: 3, value: input };
      } else {
        const type = typeof current?.name === 'string' ? current.name.toUpperCase() : OPTIONAL_TEXT[name];
        if (!type) fail('range', `${name} is unset and its type is not known here; pass { type, raw }`);
        check(type, input, name);
        l[name] = wrap(type, input);
      }
      touch(l);
      put(l);
    },
  };
  return editor;
}

const INTEGER = /INTEGER|TIMESTAMP|NUMBER$/;
/** True when a JS value has the kind the IFC type stores. */
function fits(type: string, value: unknown): boolean {
  if (type === 'IFCBOOLEAN') return typeof value === 'boolean';
  if (type === 'IFCLOGICAL') return typeof value === 'boolean' || value === null;
  if (value === null) return false;
  if (/^IFC(LABEL|TEXT|IDENTIFIER|DESCRIPTIVEMEASURE|DATE|DATETIME|TIME|DURATION|URIREFERENCE|GLOBALLYUNIQUEID|PRESENTABLETEXT|BOXALIGNMENT|FONTSTYLE|FONTVARIANT|FONTWEIGHT|TEXTALIGNMENT|TEXTDECORATION|TEXTFONTNAME|TEXTTRANSFORMATION|WELLKNOWNTEXTLITERAL|LANGUAGEID)$/.test(type))
    return typeof value === 'string';
  return typeof value === 'number';
}
/** Throws unless `raw` is a valid value of the IFC type (finite, integer, sign and length rules of the schemas). */
function check(type: string, raw: unknown, what: string): void {
  if (!fits(type, raw)) fail('range', `${what}: ${JSON.stringify(raw)} is not a valid ${type}`);
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) fail('range', `${what}: numbers must be finite`);
    if (INTEGER.test(type) && !Number.isInteger(raw)) fail('range', `${what}: ${type} needs an integer`);
    if (type.startsWith('IFCPOSITIVE') && !(raw > 0)) fail('range', `${what}: ${type} needs a value above 0`);
    if (type.startsWith('IFCNONNEGATIVE') && raw < 0) fail('range', `${what}: ${type} needs a value of 0 or more`);
    if (type === 'IFCNORMALISEDRATIOMEASURE' && (raw < 0 || raw > 1)) fail('range', `${what}: ${type} needs a value from 0 to 1`);
  }
  // IfcLabel and IfcIdentifier are STRING(255) in IFC4 and IFC4X3.
  if (typeof raw === 'string' && (type === 'IFCLABEL' || type === 'IFCIDENTIFIER') && [...raw].length > 255)
    fail('range', `${what}: ${type} holds at most 255 characters; use IfcText`);
}
