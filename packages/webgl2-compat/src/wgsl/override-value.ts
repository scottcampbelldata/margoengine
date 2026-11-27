// Values of constant and override expressions of checked WGSL, as pipeline creation resolves them (WGSL
// "const-expression" and "override-expression"): `@workgroup_size` for the device's limit check and the compute
// planner, and loop bounds for the planner.
import type { IRExpr } from './ir.js';

/** The numeric value of a constant or override expression; undefined if not constant (or not evaluated here). */
export function constantOf(e: IRExpr, constants: Readonly<Record<string, number | boolean>> = {}): number | undefined {
  if (typeof e.value === 'number') return e.value;
  if (typeof e.value === 'boolean') return +e.value;
  switch (e.kind) {
    case 'name': {
      const d = e.decl;
      if (d.kind === 'override') {
        const given = constants[d.name] ?? (d.id !== undefined ? constants[String(d.id)] : undefined);
        if (given !== undefined) return Number(given);
        return d.init ? constantOf(d.init, constants) : undefined;
      }
      if (d.kind === 'const' || d.kind === 'local-const') return typeof d.value === 'number' ? d.value : undefined;
      return undefined;
    }
    case 'convert':
      return constantOf(e.arg, constants);
    case 'unary': {
      const v = constantOf(e.operand, constants);
      return v === undefined ? undefined : e.op === '-' ? -v : e.op === '~' ? ~v : +!v;
    }
    case 'binary': {
      const a = constantOf(e.left, constants),
        b = constantOf(e.right, constants);
      if (a === undefined || b === undefined) return undefined;
      switch (e.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? a : Math.trunc(a / b);
        case '%':
          return b === 0 ? 0 : a % b;
        case '<<':
          return a << b;
        case '>>':
          return a >> b;
      }
    }
  }
  return undefined;
}
