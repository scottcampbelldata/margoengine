/** A style value: number, boolean, string, null, undefined, a vector (an array of numbers) or a regular expression. */
export type StyleValue = unknown;
/** Reads one property or point semantic (`POSITION`, `COLOR`, ...) by name. */
export type StyleRead = (name: string) => StyleValue;
/** A compiled expression: evaluate it with a property reader. */
export type StyleEvaluator = (read: StyleRead) => StyleValue;
/** An expression, a literal, or an ordered list of `[test, result]` conditions. */
export type StyleSource =
  | string
  | number
  | boolean
  | { conditions: readonly (readonly [string, string | number | boolean])[] };
/** A style vector holding `values`. */
export declare function vector(values: ArrayLike<number>): number[];
/** Compiles one expression. Throws MargoError `state` on a syntax error. */
export declare function expression(source: string): StyleEvaluator;
/** Compiles one style property; `fallback` when it is omitted, undefined when no condition is true. */
export declare function styleProperty(value: StyleSource | undefined, fallback: StyleValue): StyleEvaluator;
