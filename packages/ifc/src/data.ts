// BIM data of an open IFC model as plain, structured-cloneable objects: every object definition (products, spatial
// elements, types, groups, the project) with its attributes, property sets and quantities in SI, type, materials,
// classifications and relations; the spatial tree; the project units; the georeference. Read from the schema's
// relationships (IfcRelDefinesByProperties, IfcRelDefinesByType, IfcRelAggregates, IfcRelNests,
// IfcRelContainedInSpatialStructure, IfcRelReferencedInSpatialStructure, IfcRelVoidsElement, IfcRelFillsElement,
// IfcRelAssignsToGroup, IfcRelAssociatesMaterial, IfcRelAssociatesClassification) as IFC 4.3 ADD2, IFC4 ADD2 TC1 and
// IFC2x3 TC1 define them. Works on IFC2X3, IFC4 and IFC4X3 files.
import { checkAbort, checkModel, deletedLines, native, type IFCModel } from './open.js';
import { IFC4_PREDEFINED_ENUMS, IFC4X3_PREDEFINED_ENUMS } from './predefined-enums.js';
import { decode, refOf, refsOf, text, type Raw } from './raw.js';
import { QUANTITY_UNIT, readUnits, siUnit, unitOf, unitTypeOfMeasure, type IFCUnit, type IFCUnits } from './units.js';

export type { IFCUnit, IFCUnits } from './units.js';

/** A decoded IFC value: text, number, boolean (null for LOGICAL UNKNOWN), or a list of them. */
export type IFCValue = string | number | boolean | null | IFCValue[];

/** One property or quantity. `value` is in SI (m, m2, m3, kg, s, rad, K, ...); `raw` is as the file wrote it. */
export interface IFCProperty {
  name: string;
  value: IFCValue;
  raw: IFCValue;
  /** How IFC stores it: IfcPropertySingleValue is `single`, IfcQuantityArea is `quantity`, and so on. */
  kind: 'single' | 'enumerated' | 'list' | 'bounded' | 'table' | 'reference' | 'complex' | 'quantity';
  /** The IFC measure or quantity type in upper case, such as `IFCLENGTHMEASURE`, `IFCLABEL` or `IFCQUANTITYAREA`. */
  dataType?: string;
  /** SI symbol of `value` when it has a unit, such as `m2`. */
  unit?: string;
  /** IfcPropertyBoundedValue limits, in SI. */
  lower?: number | null;
  upper?: number | null;
  /** IfcPropertyTableValue: the defining values (the table's first column), in SI, and their data type. */
  defining?: IFCValue[];
  definingDataType?: string;
  /** IfcComplexProperty parts. */
  properties?: Record<string, IFCProperty>;
}
/** An IfcPropertySet or IfcElementQuantity. */
export interface IFCPropertySet {
  id: number;
  name: string;
  globalId?: string;
  /** True for an IfcElementQuantity (Qto_ sets). */
  quantities: boolean;
  /**
   * For an IfcPreDefinedPropertySet (IfcDoorPanelProperties, IfcWindowLiningProperties, ...): its class. Its direct
   * attributes are the properties, and `name` is its Name, or the class when it has none.
   */
  predefined?: string;
  properties: Record<string, IFCProperty>;
}
/** A material an element uses: the material itself or a layer, profile or constituent of a set. */
export interface IFCMaterial {
  name: string;
  category?: string;
  /** `material` for a single IfcMaterial (or a list member), else the set part it came from. */
  kind: 'material' | 'layer' | 'profile' | 'constituent';
  /** The layer, profile or constituent name. */
  part?: string;
  /** The layer set, profile set or constituent set name. */
  set?: string;
  /** Layer thickness in meters. */
  thickness?: number;
  /** Constituent fraction. */
  fraction?: number;
}
/** An IfcClassificationReference (or IfcClassification) an element is associated with. */
export interface IFCClassification {
  /** IfcClassification.Name: the system, such as `Uniclass 2015`. */
  system?: string;
  /** Identification (IFC4) or ItemReference (IFC2x3), such as `EF_25_10`. */
  code?: string;
  name?: string;
  uri?: string;
  /** Codes of the parent references, outermost first. */
  parents?: string[];
}
/** One IFC object definition: a product, spatial element, type object, group, system or the project. */
export interface IFCElement {
  id: number;
  /** IFC class name as the schema spells it, such as `IfcWall`. */
  type: string;
  globalId?: string;
  name?: string;
  description?: string;
  objectType?: string;
  tag?: string;
  /** PredefinedType as written (`USERDEFINED` included); see `effectivePredefinedType` in `/query`. */
  predefinedType?: string;
  /** For type objects: ElementType, or ProcessType (process types) or ResourceType (resource types). */
  elementType?: string;
  /** Every direct attribute decoded (references are left out). */
  attributes: Record<string, IFCValue>;
  /** The IfcTypeObject assigned through IfcRelDefinesByType. */
  typeId?: number;
  /** Occurrence property sets and quantity sets (for a type object, its own sets). */
  psets: IFCPropertySet[];
  materials: IFCMaterial[];
  classifications: IFCClassification[];
  /** Whole this element is part of (IfcRelAggregates). */
  aggregate?: number;
  /** Whole this element is nested in (IfcRelNests). */
  nest?: number;
  /** Spatial element containing it (IfcRelContainedInSpatialStructure). */
  container?: number;
  /** Spatial elements that also reference it (IfcRelReferencedInSpatialStructure). */
  references?: number[];
  /** For an opening: the element it voids (IfcRelVoidsElement). */
  voids?: number;
  /** For a door or window: the opening it fills (IfcRelFillsElement). */
  fills?: number;
  /** Groups, systems and zones it is assigned to (IfcRelAssignsToGroup). */
  groups?: number[];
  /** The IfcBuildingStorey above it in the spatial structure, if any. */
  storey?: number;
}
/** A node of the spatial tree: the project, a site, building, storey, space, facility or part, or an element. */
export interface IFCSpatialNode {
  id: number;
  type: string;
  name?: string;
  longName?: string;
  /** IfcBuildingStorey.Elevation in meters. */
  elevation?: number;
  /** Aggregated or nested parts (spatial children, or the parts of an element assembly). */
  children: IFCSpatialNode[];
  /** IDs of the elements contained in this spatial element. */
  elements: number[];
}
/** The model's georeference: IfcMapConversion (IFC4+), ePSet_MapConversion (IFC2x3) and IfcSite's location. */
export interface IFCGeoreference {
  source: 'IfcMapConversion' | 'IfcMapConversionScaled' | 'ePSet_MapConversion' | 'IfcSite';
  /** Target CRS (IfcProjectedCRS or ePSet_ProjectedCRS): Name is usually an EPSG code such as `EPSG:28356`. */
  crs?: {
    name?: string;
    description?: string;
    geodeticDatum?: string;
    verticalDatum?: string;
    mapProjection?: string;
    mapZone?: string;
    /** Meters per map unit (1 when MapUnit is metre or unset). */
    mapUnit: number;
  };
  /** In map units. */
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
  /** Anticlockwise angle of the local x axis from map east, radians: atan2(XAxisOrdinate, XAxisAbscissa). */
  rotation: number;
  /** Engineering units to map units (default 1, as IfcMapConversion defines it). */
  scale: number;
  /** IfcMapConversionScaled FactorX, FactorY, FactorZ (IFC 4.3). */
  factors?: [number, number, number];
  /** Meters per engineering (project length) unit. */
  lengthUnit: number;
  /** IfcSite.RefLatitude, RefLongitude in decimal degrees and RefElevation in meters. */
  latitude?: number;
  longitude?: number;
  elevation?: number;
  /** IfcGeometricRepresentationContext.TrueNorth as an angle from the local y axis, radians anticlockwise. */
  trueNorth?: number;
}
/** Everything readIFCData returns. Elements and types share one map keyed by expressID. */
export interface IFCData {
  schema: string;
  units: IFCUnits;
  elements: Map<number, IFCElement>;
  /** GlobalId to expressID. */
  byGlobalId: Map<string, number>;
  /**
   * Property sets of materials, by the IfcMaterial's expressID: IfcMaterialProperties (IFC4, IFC4X3) and
   * IfcExtendedMaterialProperties (IFC2X3), values in SI as for elements.
   */
  materialProperties: Map<number, IFCPropertySet[]>;
  /** The spatial tree from the IfcProject, or null when the file has none. */
  spatial: IFCSpatialNode | null;
  georeference: IFCGeoreference | null;
  /**
   * IFC2X3 models only (no IFC2X3 schema data ships, see isSubtypeOf): for each class of the model's schema whose
   * instances include object definitions, keyed in upper case, the classes present in the model that the open web-ifc
   * runtime's inherited lookup returns for it (the class itself and its subtypes), in schema spelling. Class filters
   * and isSubtypeOf(data, ...) follow it, so IFC2X3-only classes match their subtypes too.
   */
  inheritance?: Map<string, string[]>;
}
/** Options of readIFCData. */
export interface IFCDataOptions {
  signal?: AbortSignal;
  /** Read property sets and quantities. Default true. */
  properties?: boolean;
}

const measureOf = (v: Raw): string | undefined => (v && typeof v.name === 'string' ? v.name.toUpperCase() : undefined);
const SKIP = new Set(['expressID', 'type', 'GlobalId', 'OwnerHistory']);
// IfcPreDefinedPropertySet subtypes (IFC4 and IFC4X3; IFC2X3 names them the same way, IfcSoundProperties included).
const PREDEFINED_SET = /^IFC[A-Z]+PROPERTIES$/;
const enumTables = new Map<string, Map<string, string>>();
/** The enumeration type (`IFCDOORPANELOPERATIONENUM`) of a predefined property set's attribute; IFC2X3 uses IFC4's. */
function predefinedEnum(schema: string, kind: string, attribute: string): string | undefined {
  const key = schema.toUpperCase().startsWith('IFC4X3') ? 'IFC4X3' : 'IFC4';
  let table = enumTables.get(key);
  if (!table) {
    table = new Map();
    for (const group of (key === 'IFC4X3' ? IFC4X3_PREDEFINED_ENUMS : IFC4_PREDEFINED_ENUMS).split(' ')) {
      const [entity, list] = group.split(':') as [string, string];
      for (const pair of list.split(',')) {
        const [name, type] = pair.split('=') as [string, string];
        table.set(`IFC${entity.toUpperCase()}.${name}`, `IFC${type.toUpperCase()}`);
      }
    }
    enumTables.set(key, table);
  }
  return table.get(`${kind}.${attribute}`);
}

/** Reads the BIM data of an open model. The model stays open. */
export function readIFCData(model: IFCModel, options: IFCDataOptions = {}): IFCData {
  checkModel(model);
  checkAbort(options.signal);
  const { api, id } = model;
  const lines = new Map<number, Raw>();
  const line = (expressID: number | undefined): Raw =>
    expressID === undefined
      ? undefined
      : (lines.get(expressID) ??
        (lines.set(
          expressID,
          native('reading a line', () => api.GetLine(id, expressID)),
        ),
        lines.get(expressID)));
  const names = new Map<number, string>();
  const typeName = (l: Raw): string => {
    let name = names.get(l.type);
    if (name === undefined)
      names.set(l.type, (name = native('reading a type name', () => api.GetNameFromTypeCode(l.type))));
    return name;
  };
  const upper = (l: Raw) => typeName(l).toUpperCase();
  const deleted = deletedLines(model);
  const ids = (name: string, inherited = false): number[] => {
    const vector = native(`listing ${name}`, () =>
      api.GetLineIDsWithType(id, api.GetTypeCodeFromName(name), inherited),
    );
    const out: number[] = [];
    for (let i = 0; i < vector.size(); i++) if (!deleted.has(vector.get(i))) out.push(vector.get(i));
    return out.sort((a, b) => a - b);
  };

  const units = readUnits(line, upper, ids);
  const unitFor = (type: string | undefined): IFCUnit | undefined =>
    type ? (units.byType[type] ?? siUnit(type)) : undefined;
  const elements = new Map<number, IFCElement>(),
    byGlobalId = new Map<string, number>();
  for (const objectId of ids('IFCOBJECTDEFINITION', true)) {
    const l = line(objectId),
      attributes: Record<string, IFCValue> = {};
    for (const key of Object.keys(l)) {
      if (SKIP.has(key)) continue;
      const value = decode(l[key]);
      if (value !== undefined) attributes[key] = value;
    }
    const element: IFCElement = {
      id: objectId,
      type: typeName(l),
      attributes,
      psets: [],
      materials: [],
      classifications: [],
    };
    const set = (key: keyof IFCElement, attribute: string) => {
      const v = text(l[attribute]);
      if (v !== undefined) (element as unknown as Record<string, unknown>)[key] = v;
    };
    set('globalId', 'GlobalId');
    set('name', 'Name');
    set('description', 'Description');
    set('objectType', 'ObjectType');
    set('tag', 'Tag');
    set('predefinedType', 'PredefinedType');
    set('elementType', 'ElementType');
    // Process types (IfcTaskType, IfcEventType, ...) and resource types name their custom type differently.
    if (element.elementType === undefined) set('elementType', 'ProcessType');
    if (element.elementType === undefined) set('elementType', 'ResourceType');
    elements.set(objectId, element);
    if (element.globalId) byGlobalId.set(element.globalId, objectId);
  }
  checkAbort(options.signal);

  // Property sets, read once each and shared by every element they define.
  const psets = new Map<number, IFCPropertySet | null>();
  const readProperty = (p: Raw): IFCProperty | undefined => {
    const kind = upper(p),
      name = text(p.Name) ?? '';
    const explicit =
      p.Unit !== undefined && refOf(p.Unit) !== undefined ? unitOf(line(refOf(p.Unit)), line, upper) : undefined;
    const convert = (v: Raw): { value: IFCValue; raw: IFCValue; unit?: string; dataType?: string } => {
      const raw = decode(v) ?? null,
        dataType = measureOf(v),
        type = unitTypeOfMeasure(dataType),
        unit = explicit ?? unitFor(type);
      if (unit && typeof raw === 'number')
        return { value: raw * unit.scale + unit.shift, raw, unit: unit.symbol || undefined, dataType };
      return { value: raw, raw, dataType };
    };
    if (kind === 'IFCPROPERTYSINGLEVALUE') return { name, kind: 'single', ...convert(p.NominalValue) };
    if (kind === 'IFCPROPERTYENUMERATEDVALUE' || kind === 'IFCPROPERTYLISTVALUE') {
      const values = (p[kind === 'IFCPROPERTYLISTVALUE' ? 'ListValues' : 'EnumerationValues'] ?? []).map(convert);
      return {
        name,
        kind: kind === 'IFCPROPERTYLISTVALUE' ? 'list' : 'enumerated',
        value: values.map((v: { value: IFCValue }) => v.value),
        raw: values.map((v: { raw: IFCValue }) => v.raw),
        dataType: values[0]?.dataType,
        unit: values[0]?.unit,
      };
    }
    if (kind === 'IFCPROPERTYBOUNDEDVALUE') {
      const lower = convert(p.LowerBoundValue),
        upperValue = convert(p.UpperBoundValue),
        set = convert(p.SetPointValue);
      return {
        name,
        kind: 'bounded',
        value: set.value,
        raw: set.raw,
        lower: typeof lower.value === 'number' ? lower.value : null,
        upper: typeof upperValue.value === 'number' ? upperValue.value : null,
        dataType: lower.dataType ?? upperValue.dataType ?? set.dataType,
        unit: lower.unit ?? upperValue.unit ?? set.unit,
      };
    }
    if (kind === 'IFCPROPERTYTABLEVALUE') {
      const defining = (p.DefiningValues ?? []).map(convert),
        defined = (p.DefinedValues ?? []).map(convert);
      return {
        name,
        kind: 'table',
        value: defined.map((v: { value: IFCValue }) => v.value),
        raw: defining.map((v: { raw: IFCValue }, i: number) => [v.raw, defined[i]?.raw ?? null]),
        dataType: defined[0]?.dataType,
        unit: defined[0]?.unit,
        defining: defining.map((v: { value: IFCValue }) => v.value),
        definingDataType: defining[0]?.dataType,
      };
    }
    if (kind === 'IFCPROPERTYREFERENCEVALUE') {
      const target = line(refOf(p.PropertyReference));
      const label = target ? (text(target.Name) ?? text(target.Identification) ?? text(target.Location) ?? null) : null;
      return { name, kind: 'reference', value: label, raw: label };
    }
    if (kind === 'IFCCOMPLEXPROPERTY') {
      const properties: Record<string, IFCProperty> = {};
      for (const part of refsOf(p.HasProperties)) {
        const read = readProperty(line(part));
        if (read) properties[read.name] = read;
      }
      return { name, kind: 'complex', value: null, raw: null, properties };
    }
    if (kind.startsWith('IFCQUANTITY')) {
      const key = Object.keys(p).find((k) => k.endsWith('Value'));
      const raw = key ? (decode(p[key]) ?? null) : null,
        unit = explicit ?? unitFor(QUANTITY_UNIT[kind]);
      if (unit && typeof raw === 'number')
        return {
          name,
          kind: 'quantity',
          value: raw * unit.scale + unit.shift,
          raw,
          dataType: kind,
          unit: unit.symbol || undefined,
        };
      return { name, kind: 'quantity', value: raw, raw, dataType: kind };
    }
    return undefined;
  };
  const readSet = (setId: number): IFCPropertySet | null => {
    if (psets.has(setId)) return psets.get(setId)!;
    const l = line(setId),
      kind = l ? upper(l) : '';
    let result: IFCPropertySet | null = null;
    if (kind === 'IFCPROPERTYSET' || kind === 'IFCELEMENTQUANTITY') {
      const properties: Record<string, IFCProperty> = {};
      for (const pid of refsOf(kind === 'IFCPROPERTYSET' ? l.HasProperties : l.Quantities)) {
        const read = readProperty(line(pid));
        if (read) properties[read.name] = read;
      }
      result = { id: setId, name: text(l.Name) ?? '', quantities: kind === 'IFCELEMENTQUANTITY', properties };
      const globalId = text(l.GlobalId);
      if (globalId) result.globalId = globalId;
    } else if (kind === 'IFCMATERIALPROPERTIES' || kind === 'IFCEXTENDEDMATERIALPROPERTIES') {
      const properties: Record<string, IFCProperty> = {};
      for (const pid of refsOf(kind === 'IFCMATERIALPROPERTIES' ? l.Properties : l.ExtendedProperties)) {
        const read = readProperty(line(pid));
        if (read) properties[read.name] = read;
      }
      result = { id: setId, name: text(l.Name) ?? '', quantities: false, properties };
    } else if (l && PREDEFINED_SET.test(kind)) {
      // Predefined property sets carry their properties as direct attributes.
      const properties: Record<string, IFCProperty> = {};
      for (const key of Object.keys(l)) {
        if (SKIP.has(key) || key === 'Name' || key === 'Description' || refsOf(l[key]).length) continue;
        const value = l[key];
        if (value === null || value === undefined) continue;
        const raw = decode(value) ?? null,
          dataType = measureOf(value) ?? predefinedEnum(model.schema, kind, key),
          unit = unitFor(unitTypeOfMeasure(dataType));
        const property: IFCProperty = { name: key, kind: 'single', value: raw, raw };
        if (dataType) property.dataType = dataType;
        if (unit && typeof raw === 'number') {
          property.value = raw * unit.scale + unit.shift;
          if (unit.symbol) property.unit = unit.symbol;
        }
        properties[key] = property;
      }
      const name = typeName(l);
      result = { id: setId, name: text(l.Name) ?? name, quantities: false, properties, predefined: name };
      const globalId = text(l.GlobalId);
      if (globalId) result.globalId = globalId;
    }
    psets.set(setId, result);
    return result;
  };
  const addSet = (element: IFCElement | undefined, setId: number) => {
    const set = readSet(setId);
    if (element && set && !element.psets.includes(set)) element.psets.push(set);
  };

  const read = (rel: string, each: (l: Raw) => void) => {
    for (const relId of ids(rel)) each(line(relId));
    checkAbort(options.signal);
  };
  if (options.properties !== false) {
    read('IFCRELDEFINESBYPROPERTIES', (l) => {
      for (const setId of refsOf(l.RelatingPropertyDefinition))
        for (const objectId of refsOf(l.RelatedObjects)) addSet(elements.get(objectId), setId);
    });
    // IfcTypeObject.HasPropertySets.
    for (const element of elements.values())
      for (const setId of refsOf(line(element.id).HasPropertySets)) addSet(element, setId);
  }
  const materialProperties = new Map<number, IFCPropertySet[]>();
  if (options.properties !== false)
    for (const kind of ['IFCMATERIALPROPERTIES', 'IFCEXTENDEDMATERIALPROPERTIES'])
      for (const setId of model.schema.toUpperCase().startsWith('IFC2X3') === (kind === 'IFCEXTENDEDMATERIALPROPERTIES')
        ? ids(kind)
        : []) {
        const material = refOf(line(setId).Material),
          set = readSet(setId);
        if (material !== undefined && set)
          (materialProperties.get(material) ?? materialProperties.set(material, []).get(material)!).push(set);
      }
  read('IFCRELDEFINESBYTYPE', (l) => {
    const typeId = refOf(l.RelatingType);
    for (const objectId of refsOf(l.RelatedObjects)) {
      const element = elements.get(objectId);
      if (element && typeId !== undefined) element.typeId = typeId;
    }
  });
  const link = (
    rel: string,
    whole: string,
    parts: string,
    key: 'aggregate' | 'nest' | 'container' | 'voids' | 'fills',
  ) =>
    read(rel, (l) => {
      const owner = refOf(l[whole]);
      for (const part of refsOf(l[parts])) {
        const element = elements.get(part);
        if (element && owner !== undefined) element[key] = owner;
      }
    });
  link('IFCRELAGGREGATES', 'RelatingObject', 'RelatedObjects', 'aggregate');
  link('IFCRELNESTS', 'RelatingObject', 'RelatedObjects', 'nest');
  link('IFCRELCONTAINEDINSPATIALSTRUCTURE', 'RelatingStructure', 'RelatedElements', 'container');
  read('IFCRELREFERENCEDINSPATIALSTRUCTURE', (l) => {
    const owner = refOf(l.RelatingStructure);
    for (const part of refsOf(l.RelatedElements)) {
      const element = elements.get(part);
      if (element && owner !== undefined) (element.references ??= []).push(owner);
    }
  });
  // An opening voids an element; a door or window fills an opening.
  read('IFCRELVOIDSELEMENT', (l) => {
    const opening = elements.get(refOf(l.RelatedOpeningElement)!),
      host = refOf(l.RelatingBuildingElement);
    if (opening && host !== undefined) opening.voids = host;
  });
  read('IFCRELFILLSELEMENT', (l) => {
    const filler = elements.get(refOf(l.RelatedBuildingElement)!),
      opening = refOf(l.RelatingOpeningElement);
    if (filler && opening !== undefined) filler.fills = opening;
  });
  read('IFCRELASSIGNSTOGROUP', (l) => {
    const group = refOf(l.RelatingGroup);
    for (const part of refsOf(l.RelatedObjects)) {
      const element = elements.get(part);
      if (element && group !== undefined) (element.groups ??= []).push(group);
    }
  });
  read('IFCRELASSOCIATESMATERIAL', (l) => {
    const materials = readMaterials(line(refOf(l.RelatingMaterial)), line, upper, unitFor('LENGTHUNIT')!);
    for (const objectId of refsOf(l.RelatedObjects)) elements.get(objectId)?.materials.push(...materials);
  });
  read('IFCRELASSOCIATESCLASSIFICATION', (l) => {
    const classification = readClassification(line(refOf(l.RelatingClassification)), line, upper);
    if (classification)
      for (const objectId of refsOf(l.RelatedObjects)) elements.get(objectId)?.classifications.push(classification);
  });

  // Storey of each element: the nearest IfcBuildingStorey up the containment, aggregation and nesting chain.
  const storeyOf = (element: IFCElement): number | undefined => {
    const seen = new Set<number>();
    for (let at: IFCElement | undefined = element; at && !seen.has(at.id); ) {
      seen.add(at.id);
      if (at !== element && at.type.toUpperCase() === 'IFCBUILDINGSTOREY') return at.id;
      const up: number | undefined = at.container ?? at.aggregate ?? at.nest ?? at.voids ?? at.fills;
      at = up === undefined ? undefined : elements.get(up);
    }
  };
  for (const element of elements.values()) {
    const storey = storeyOf(element);
    if (storey !== undefined) element.storey = storey;
  }

  const lengthUnit = unitFor('LENGTHUNIT')!;
  const inheritance = model.schema.toUpperCase().startsWith('IFC4') ? undefined : readInheritance(model, elements);
  checkAbort(options.signal);
  return {
    schema: model.schema,
    units,
    elements,
    byGlobalId,
    materialProperties,
    spatial: buildTree(elements, lengthUnit),
    georeference: readGeoreference(elements, line, upper, ids, lengthUnit),
    ...(inheritance && { inheritance }),
  };
}

// One inherited GetLineIDsWithType lookup per entity type of the model's schema (GetIfcEntityList). A class is either
// below IfcObjectDefinition, so every line it returns is an element, or its lookup holds no element at all (the one
// exception, IfcRoot, returns more lines than there are elements). So a lookup is read through only when it returns
// no more lines than there are elements and its first line is an element: the lines read add up to the elements times
// their inheritance depth, and no geometry or relationship list is ever walked.
function readInheritance(model: IFCModel, elements: Map<number, IFCElement>): Map<string, string[]> {
  const { api, id } = model,
    inheritance = new Map<string, string[]>();
  for (const code of native('listing the schema entities', () => api.GetIfcEntityList(id))) {
    const vector = native('listing a class with its subtypes', () => api.GetLineIDsWithType(id, code, true)),
      size = vector.size();
    if (!size || size > elements.size || !elements.has(vector.get(0))) continue;
    const classes = new Set<string>();
    for (let i = 0; i < size; i++) {
      const element = elements.get(vector.get(i));
      if (element) classes.add(element.type);
    }
    inheritance.set(
      native('reading a type name', () => api.GetNameFromTypeCode(code)).toUpperCase(),
      [...classes].sort(),
    );
  }
  return inheritance;
}

function readMaterials(
  l: Raw,
  line: (id: number | undefined) => Raw,
  upper: (l: Raw) => string,
  length: IFCUnit,
): IFCMaterial[] {
  if (!l) return [];
  const kind = upper(l),
    out: IFCMaterial[] = [];
  const material = (m: Raw, extra: Partial<IFCMaterial> & Pick<IFCMaterial, 'kind'>) => {
    const name = text(m?.Name);
    if (name === undefined && extra.part === undefined) return;
    const entry: IFCMaterial = { name: name ?? '', ...extra };
    const category = text(m?.Category);
    if (category !== undefined) entry.category = category;
    out.push(entry);
  };
  const part = (p: Raw, kind: 'layer' | 'profile' | 'constituent', set: string | undefined) => {
    const extra: Partial<IFCMaterial> & Pick<IFCMaterial, 'kind'> = { kind };
    const partName = text(p.Name);
    if (partName !== undefined) extra.part = partName;
    if (set !== undefined) extra.set = set;
    const thickness = decode(p.LayerThickness);
    if (typeof thickness === 'number') extra.thickness = thickness * length.scale;
    const fraction = decode(p.Fraction);
    if (typeof fraction === 'number') extra.fraction = fraction;
    const category = text(p.Category);
    material(line(refOf(p.Material)), extra);
    // A part's own category (IFC4 layers, profiles and constituents carry one) is also a name the part goes by.
    if (category !== undefined && out.length) out[out.length - 1].category ??= category;
  };
  if (kind === 'IFCMATERIAL') material(l, { kind: 'material' });
  else if (kind === 'IFCMATERIALLIST') for (const m of refsOf(l.Materials)) material(line(m), { kind: 'material' });
  else if (kind === 'IFCMATERIALLAYERSETUSAGE') return readMaterials(line(refOf(l.ForLayerSet)), line, upper, length);
  else if (kind === 'IFCMATERIALPROFILESETUSAGE' || kind === 'IFCMATERIALPROFILESETUSAGETAPERING')
    return readMaterials(line(refOf(l.ForProfileSet)), line, upper, length);
  else if (kind === 'IFCMATERIALLAYERSET')
    for (const p of refsOf(l.MaterialLayers)) part(line(p), 'layer', text(l.LayerSetName));
  else if (kind === 'IFCMATERIALPROFILESET')
    for (const p of refsOf(l.MaterialProfiles)) part(line(p), 'profile', text(l.Name));
  else if (kind === 'IFCMATERIALCONSTITUENTSET')
    for (const p of refsOf(l.MaterialConstituents)) part(line(p), 'constituent', text(l.Name));
  else if (kind === 'IFCMATERIALLAYER') part(l, 'layer', undefined);
  else if (kind === 'IFCMATERIALPROFILE') part(l, 'profile', undefined);
  else if (kind === 'IFCMATERIALCONSTITUENT') part(l, 'constituent', undefined);
  return out;
}

function readClassification(
  l: Raw,
  line: (id: number | undefined) => Raw,
  upper: (l: Raw) => string,
): IFCClassification | undefined {
  if (!l) return;
  const result: IFCClassification = {},
    parents: string[] = [];
  let at = l;
  for (let depth = 0; at && depth < 32; depth++) {
    const kind = upper(at);
    if (kind === 'IFCCLASSIFICATION') {
      const system = text(at.Name);
      if (system !== undefined) result.system = system;
      break;
    }
    if (kind !== 'IFCCLASSIFICATIONREFERENCE') break;
    const code = text(at.Identification) ?? text(at.ItemReference);
    if (at === l) {
      if (code !== undefined) result.code = code;
      const name = text(at.Name),
        uri = text(at.Location);
      if (name !== undefined) result.name = name;
      if (uri !== undefined) result.uri = uri;
    } else if (code !== undefined) parents.unshift(code);
    at = line(refOf(at.ReferencedSource));
  }
  if (parents.length) result.parents = parents;
  return result;
}

const SPATIAL =
  /^IFC(PROJECT|SITE|BUILDING|BUILDINGSTOREY|SPACE|SPATIALZONE|FACILITY|FACILITYPART|BRIDGE|BRIDGEPART|ROAD|ROADPART|RAILWAY|RAILWAYPART|MARINEFACILITY|MARINEPART|EXTERNALSPATIALELEMENT|SPATIALELEMENT|SPATIALSTRUCTUREELEMENT)$/;

function buildTree(elements: Map<number, IFCElement>, length: IFCUnit): IFCSpatialNode | null {
  const project = [...elements.values()].find((e) => e.type.toUpperCase() === 'IFCPROJECT');
  if (!project) return null;
  const nodes = new Map<number, IFCSpatialNode>();
  const node = (e: IFCElement): IFCSpatialNode => {
    let n = nodes.get(e.id);
    if (!n) {
      n = { id: e.id, type: e.type, children: [], elements: [] };
      if (e.name !== undefined) n.name = e.name;
      const longName = e.attributes.LongName;
      if (typeof longName === 'string') n.longName = longName;
      const elevation = e.attributes.Elevation;
      if (typeof elevation === 'number' && e.type.toUpperCase() === 'IFCBUILDINGSTOREY')
        n.elevation = elevation * length.scale;
      nodes.set(e.id, n);
    }
    return n;
  };
  node(project);
  for (const e of elements.values()) {
    const whole = e.aggregate ?? e.nest;
    if (whole !== undefined && elements.has(whole)) node(elements.get(whole)!).children.push(node(e));
    if (e.container !== undefined && elements.has(e.container)) node(elements.get(e.container)!).elements.push(e.id);
  }
  // Spatial children first, then element parts (a stair's flights, a curtain wall's plates), each by expressID.
  const spatial = (n: IFCSpatialNode) => Number(SPATIAL.test(n.type.toUpperCase()));
  for (const n of nodes.values()) n.children.sort((a, b) => spatial(b) - spatial(a) || a.id - b.id);
  return nodes.get(project.id)!;
}

function readGeoreference(
  elements: Map<number, IFCElement>,
  line: (id: number | undefined) => Raw,
  upper: (l: Raw) => string,
  ids: (n: string, inherited?: boolean) => number[],
  length: IFCUnit,
): IFCGeoreference | null {
  let geo: IFCGeoreference | null = null;
  const crsOf = (l: Raw, get: (key: string) => Raw) => {
    const crs: NonNullable<IFCGeoreference['crs']> = { mapUnit: 1 };
    for (const key of ['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone'] as const) {
      const value = get(key);
      if (typeof value === 'string') crs[(key[0].toLowerCase() + key.slice(1)) as 'name'] = value;
    }
    const unit = l ? unitOf(line(refOf(l.MapUnit)), line, upper) : undefined;
    if (unit) crs.mapUnit = unit.scale;
    return crs;
  };
  const conversion = ids('IFCMAPCONVERSION', true)[0];
  if (conversion !== undefined) {
    const l = line(conversion),
      num = (key: string, fallback: number) => {
        const v = decode(l[key]);
        return typeof v === 'number' ? v : fallback;
      };
    const target = line(refOf(l.TargetCRS));
    geo = {
      source: upper(l) === 'IFCMAPCONVERSIONSCALED' ? 'IfcMapConversionScaled' : 'IfcMapConversion',
      eastings: num('Eastings', 0),
      northings: num('Northings', 0),
      orthogonalHeight: num('OrthogonalHeight', 0),
      xAxisAbscissa: num('XAxisAbscissa', 1),
      xAxisOrdinate: num('XAxisOrdinate', 0),
      rotation: 0,
      scale: num('Scale', 1),
      lengthUnit: length.scale,
    };
    if (target) geo.crs = crsOf(target, (key) => text(target[key]));
    if (geo.source === 'IfcMapConversionScaled')
      geo.factors = [num('FactorX', 1), num('FactorY', 1), num('FactorZ', 1)];
  } else {
    // IFC2x3: the buildingSMART Australia property sets on the project or site.
    let map: IFCPropertySet | undefined, crs: IFCPropertySet | undefined;
    for (const e of elements.values())
      for (const set of e.psets) {
        if (set.name === 'ePSet_MapConversion') map ??= set;
        if (set.name === 'ePSet_ProjectedCRS') crs ??= set;
      }
    if (map) {
      // These sets hold plain numbers in map units: their raw values are what the guide defines.
      const num = (key: string, fallback: number) => {
        const v = map!.properties[key]?.raw;
        return typeof v === 'number' ? v : fallback;
      };
      geo = {
        source: 'ePSet_MapConversion',
        eastings: num('Eastings', 0),
        northings: num('Northings', 0),
        orthogonalHeight: num('OrthogonalHeight', 0),
        xAxisAbscissa: num('XAxisAbscissa', 1),
        xAxisOrdinate: num('XAxisOrdinate', 0),
        rotation: 0,
        scale: num('Scale', 1),
        lengthUnit: length.scale,
      };
      if (crs) {
        const get = (key: string) => crs!.properties[key]?.raw;
        geo.crs = crsOf(undefined, get);
        const unit = get('MapUnit');
        if (typeof unit === 'string' && /FOOT|FEET/i.test(unit))
          geo.crs.mapUnit = /US/i.test(unit) ? 1200 / 3937 : 0.3048;
      }
    }
  }
  if (geo) geo.rotation = Math.atan2(geo.xAxisOrdinate, geo.xAxisAbscissa);
  // IfcSite reference location (compound plane angles: degrees, minutes, seconds, millionths of a second).
  const site = [...elements.values()].find((e) => e.type.toUpperCase() === 'IFCSITE');
  const dms = (v: IFCValue | undefined) =>
    Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number')
      ? (v[0] as number) + (v[1] as number) / 60 + ((v[2] as number) + ((v[3] as number) ?? 0) / 1e6) / 3600
      : undefined;
  const latitude = dms(site?.attributes.RefLatitude),
    longitude = dms(site?.attributes.RefLongitude),
    elevation = site?.attributes.RefElevation;
  if (latitude !== undefined || longitude !== undefined) {
    geo ??= {
      source: 'IfcSite',
      eastings: 0,
      northings: 0,
      orthogonalHeight: 0,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      rotation: 0,
      scale: 1,
      lengthUnit: length.scale,
    };
    if (latitude !== undefined) geo.latitude = latitude;
    if (longitude !== undefined) geo.longitude = longitude;
    if (typeof elevation === 'number') geo.elevation = elevation * length.scale;
  }
  // True north of the model context: a direction in the XY plane; its angle from +Y, anticlockwise positive.
  for (const contextId of ids('IFCGEOMETRICREPRESENTATIONCONTEXT')) {
    const north = line(refOf(line(contextId).TrueNorth));
    const ratios = decode(north?.DirectionRatios);
    if (geo && Array.isArray(ratios) && typeof ratios[0] === 'number' && typeof ratios[1] === 'number') {
      geo.trueNorth = Math.atan2(-(ratios[0] as number), ratios[1] as number);
      break;
    }
  }
  return geo;
}

/**
 * Converts a point in the model's IFC coordinates (meters, Z up) to map coordinates (map units) by the
 * IfcMapConversion transform: scale, rotate anticlockwise by `rotation` about Z, translate.
 */
export function modelToMap(
  geo: IFCGeoreference,
  [x, y, z]: readonly [number, number, number],
): [number, number, number] {
  const k = geo.scale / geo.lengthUnit,
    [fx, fy, fz] = geo.factors ?? [1, 1, 1];
  const ex = x * k * fx,
    ey = y * k * fy,
    ez = z * k * fz,
    c = Math.cos(geo.rotation),
    s = Math.sin(geo.rotation);
  return [geo.eastings + c * ex - s * ey, geo.northings + s * ex + c * ey, geo.orthogonalHeight + ez];
}

/** The inverse of modelToMap: map coordinates (map units) to the model's IFC coordinates (meters, Z up). */
export function mapToModel(
  geo: IFCGeoreference,
  [e, n, h]: readonly [number, number, number],
): [number, number, number] {
  const k = geo.scale / geo.lengthUnit,
    [fx, fy, fz] = geo.factors ?? [1, 1, 1];
  const dx = e - geo.eastings,
    dy = n - geo.northings,
    c = Math.cos(geo.rotation),
    s = Math.sin(geo.rotation);
  return [(c * dx + s * dy) / (k * fx), (-s * dx + c * dy) / (k * fy), (h - geo.orthogonalHeight) / (k * fz)];
}

/** Engine axes (Y up, as readIFCGeometry writes vertices) to IFC axes (Z up), adding back a rebased origin. */
export function engineToIFC(
  [x, y, z]: readonly number[],
  origin: readonly number[] = [0, 0, 0],
): [number, number, number] {
  return [x + origin[0], -(z + origin[2]), y + origin[1]];
}
/** IFC axes (Z up, meters) to engine axes (Y up), subtracting a rebased origin. */
export function ifcToEngine(
  [x, y, z]: readonly number[],
  origin: readonly number[] = [0, 0, 0],
): [number, number, number] {
  return [x - origin[0], z - origin[1], -y - origin[2]];
}

/**
 * An element's properties merged with its type's: the type's sets first, then the occurrence's, so an occurrence
 * property overrides the type property of the same set and name (IFC4 IfcRelDefinesByType). Values are SI.
 */
export function propertiesOf(data: IFCData, id: number): Record<string, Record<string, IFCProperty>> {
  const element = data.elements.get(id),
    out: Record<string, Record<string, IFCProperty>> = {};
  if (!element) return out;
  const type = element.typeId !== undefined ? data.elements.get(element.typeId) : undefined;
  for (const set of [...(type?.psets ?? []), ...element.psets]) Object.assign((out[set.name] ??= {}), set.properties);
  return out;
}

/** One property of an element (type properties included, occurrence first), or undefined. */
export function propertyOf(data: IFCData, id: number, set: string, name: string): IFCProperty | undefined {
  return propertiesOf(data, id)[set]?.[name];
}

/** An element's materials, falling back to its type's when the occurrence has none. */
export function materialsOf(data: IFCData, id: number): IFCMaterial[] {
  const element = data.elements.get(id);
  if (!element) return [];
  if (element.materials.length || element.typeId === undefined) return element.materials;
  return data.elements.get(element.typeId)?.materials ?? [];
}

/** An element's classifications together with its type's. */
export function classificationsOf(data: IFCData, id: number): IFCClassification[] {
  const element = data.elements.get(id);
  if (!element) return [];
  const type = element.typeId !== undefined ? data.elements.get(element.typeId) : undefined;
  return [...element.classifications, ...(type?.classifications ?? [])];
}
