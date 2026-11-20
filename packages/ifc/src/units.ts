// IFC units (IfcUnitAssignment) to SI. IfcSIUnit applies its prefix to the base unit before the power, so MILLI
// SQUARE_METRE is (10^-3 m)^2 = 10^-6 m2 (BIPM SI Brochure, 9th edition, 3); IfcConversionBasedUnit scales its
// ConversionFactor's unit; IfcConversionBasedUnitWithOffset adds its ConversionOffset after the factor in the
// direction SI -> unit, so SI = (v - offset) * factor; IfcDerivedUnit multiplies its elements' factors to their
// exponents. A unit is { scale, shift } with SI = value * scale + shift.

import { decode, refOf, refsOf, text, type Raw } from './raw.js';

/** A unit's conversion to SI: `si = value * scale + shift`, and the SI symbol the result is in. */
export interface IFCUnit {
  scale: number;
  shift: number;
  /** SI symbol of the converted value, such as `m`, `m2`, `kg` or `K`; empty when the unit type has none here. */
  symbol: string;
  /** The unit as the file names it, such as `MILLI METRE` or `foot`. */
  name: string;
}
/** The project's units by IFC unit type (`LENGTHUNIT`, `AREAUNIT`, ...), with `currency` for IfcMonetaryUnit. */
export interface IFCUnits {
  byType: Record<string, IFCUnit>;
  currency?: string;
}

const PREFIX: Record<string, number> = {
  EXA: 18,
  PETA: 15,
  TERA: 12,
  GIGA: 9,
  MEGA: 6,
  KILO: 3,
  HECTO: 2,
  DECA: 1,
  DECI: -1,
  CENTI: -2,
  MILLI: -3,
  MICRO: -6,
  NANO: -9,
  PICO: -12,
  FEMTO: -15,
  ATTO: -18,
};
/** SI symbol of each unit type this package converts; other types keep their scale but name no symbol. */
export const SI_SYMBOL: Record<string, string> = {
  LENGTHUNIT: 'm',
  AREAUNIT: 'm2',
  VOLUMEUNIT: 'm3',
  MASSUNIT: 'kg',
  TIMEUNIT: 's',
  PLANEANGLEUNIT: 'rad',
  SOLIDANGLEUNIT: 'sr',
  THERMODYNAMICTEMPERATUREUNIT: 'K',
  ELECTRICCURRENTUNIT: 'A',
  AMOUNTOFSUBSTANCEUNIT: 'mol',
  LUMINOUSINTENSITYUNIT: 'cd',
  FORCEUNIT: 'N',
  PRESSUREUNIT: 'Pa',
  ENERGYUNIT: 'J',
  POWERUNIT: 'W',
  FREQUENCYUNIT: 'Hz',
  ELECTRICVOLTAGEUNIT: 'V',
  ILLUMINANCEUNIT: 'lx',
  LUMINOUSFLUXUNIT: 'lm',
  MASSDENSITYUNIT: 'kg/m3',
  THERMALTRANSMITTANCEUNIT: 'W/(m2.K)',
  THERMALCONDUCTANCEUNIT: 'W/(m.K)',
  VOLUMETRICFLOWRATEUNIT: 'm3/s',
  LINEARVELOCITYUNIT: 'm/s',
  MASSFLOWRATEUNIT: 'kg/s',
};
const POWER: Record<string, number> = { SQUARE_METRE: 2, CUBIC_METRE: 3 };

/** The SI unit (scale 1) of a unit type. */
export const siUnit = (type: string): IFCUnit => ({ scale: 1, shift: 0, symbol: SI_SYMBOL[type] ?? '', name: 'SI' });

/** Converts an IfcSIUnit's prefix and name to { scale, shift }. */
export function siScale(prefix: string | null | undefined, name: string): { scale: number; shift: number } {
  const exponent = prefix ? (PREFIX[prefix] ?? 0) : 0,
    power = POWER[name] ?? 1;
  if (name === 'DEGREE_CELSIUS') return { scale: 10 ** exponent, shift: 273.15 };
  // The SI base unit of mass is the kilogram; IfcSIUnit names it GRAM with prefix KILO.
  return { scale: (name === 'GRAM' ? 1e-3 : 1) * 10 ** (exponent * power), shift: 0 };
}

/**
 * The unit type a value's IFC measure type belongs to: IFCLENGTHMEASURE and IFCPOSITIVELENGTHMEASURE to LENGTHUNIT,
 * IFCTHERMALTRANSMITTANCEMEASURE to THERMALTRANSMITTANCEUNIT. Ratios, counts, labels and the like have none.
 */
export function unitTypeOfMeasure(measure: string | undefined): string | undefined {
  const m = measure && /^IFC(?:POSITIVE|NONNEGATIVE)?([A-Z]+)MEASURE$/.exec(measure.toUpperCase());
  if (!m) return;
  const kind = m[1];
  if (/^(COUNT|RATIO|NORMALISEDRATIO|PARAMETERVALUE|NUMERIC|COMPOUNDPLANEANGLE|CONTEXTDEPENDENT|DESCRIPTIVE)$/.test(kind))
    return;
  return `${kind}UNIT`;
}

/** Unit type of each IfcPhysicalSimpleQuantity subtype's value. */
export const QUANTITY_UNIT: Record<string, string | undefined> = {
  IFCQUANTITYLENGTH: 'LENGTHUNIT',
  IFCQUANTITYAREA: 'AREAUNIT',
  IFCQUANTITYVOLUME: 'VOLUMEUNIT',
  IFCQUANTITYWEIGHT: 'MASSUNIT',
  IFCQUANTITYTIME: 'TIMEUNIT',
};

export function unitOf(l: Raw, line: (id: number | undefined) => Raw, upper: (l: Raw) => string, depth = 0): IFCUnit | undefined {
  if (!l || depth > 8) return;
  const kind = upper(l),
    unitType = typeof l.UnitType?.value === 'string' ? l.UnitType.value : '';
  const symbol = SI_SYMBOL[unitType] ?? '';
  if (kind === 'IFCSIUNIT') {
    const prefix = typeof l.Prefix?.value === 'string' ? l.Prefix.value : null,
      name = String(l.Name?.value ?? '');
    return { ...siScale(prefix, name), symbol, name: prefix ? `${prefix} ${name}` : name };
  }
  if (kind === 'IFCCONVERSIONBASEDUNIT' || kind === 'IFCCONVERSIONBASEDUNITWITHOFFSET') {
    const factor = line(refOf(l.ConversionFactor)),
      value = decode(factor?.ValueComponent),
      base = unitOf(line(refOf(factor?.UnitComponent)), line, upper, depth + 1);
    if (typeof value !== 'number' || !base) return;
    const offset = kind === 'IFCCONVERSIONBASEDUNITWITHOFFSET' ? Number(decode(l.ConversionOffset) ?? 0) : 0;
    // SI = base.scale * ((v - offset) * value) + base.shift.
    return { scale: base.scale * value, shift: base.shift - base.scale * value * offset, symbol, name: String(text(l.Name) ?? l.Name?.value ?? '') };
  }
  if (kind === 'IFCDERIVEDUNIT') {
    let scale = 1;
    for (const elementId of refsOf(l.Elements)) {
      const element = line(elementId),
        unit = unitOf(line(refOf(element?.Unit)), line, upper, depth + 1),
        exponent = Number(element?.Exponent?.value ?? element?.Exponent ?? 1);
      if (!unit) return;
      scale *= unit.scale ** exponent;
    }
    return { scale, shift: 0, symbol, name: text(l.Name) ?? unitType };
  }
}

export function readUnits(line: (id: number | undefined) => Raw, upper: (l: Raw) => string, ids: (n: string) => number[]): IFCUnits {
  const units: IFCUnits = { byType: {} };
  const project = line(ids('IFCPROJECT')[0]);
  const assignment = project ? line(refOf(project.UnitsInContext)) : undefined;
  for (const unitId of refsOf(assignment?.Units)) {
    const l = line(unitId);
    if (!l) continue;
    if (upper(l) === 'IFCMONETARYUNIT') {
      units.currency = String(text(l.Currency) ?? l.Currency?.value ?? '');
      continue;
    }
    const type = typeof l.UnitType?.value === 'string' ? l.UnitType.value : undefined,
      unit = unitOf(l, line, upper);
    if (type && unit) units.byType[type] = unit;
  }
  return units;
}
