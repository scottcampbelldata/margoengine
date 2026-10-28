// Coded errors of the WGSL front end. Every fault in the source text is a WGSLError with a code, the 1-based line
// and column (in code points) of the token at fault and a help link; anything else thrown is a bug.

/**
 * Why a {@link WGSLError} was thrown. Stable across releases: branch on `code`, not on the message.
 * - `syntax`: the text is not WGSL (a bad token, a missing `;`, a reserved word, an unbalanced bracket).
 * - `type`: the text parses but breaks a WGSL rule: an unknown name, a type mismatch, a wrong argument count, a
 *   misplaced statement or attribute, a constant expression that overflows.
 * - `limit`: the source is past one of the front end's limits ({@link WGSL_LIMITS}): too long, nested too deep.
 */
export type WGSLErrorCode = 'syntax' | 'type' | 'limit';

/** The help page for front-end errors; the code is the anchor. */
export const WGSL_HELP = 'https://margoengine.com/errors#wgsl';

/** Limits that keep hostile or broken input from hanging or exhausting the front end. */
export const WGSL_LIMITS = {
  /** Source length in UTF-16 code units. */
  sourceLength: 4 * 1024 * 1024,
  /** Nesting of brackets, statements and expressions (the WGSL specification asks implementations for 127+). */
  depth: 255,
  /** Elements of a constant array the evaluator builds. */
  constantElements: 65536,
} as const;

/** A fault in WGSL source text, with its position. */
export class WGSLError extends Error {
  /** Machine-readable reason; see {@link WGSLErrorCode}. */
  readonly code: WGSLErrorCode;
  /** 1-based line of the token at fault. */
  readonly line: number;
  /** 1-based column, in code points, of the token at fault. */
  readonly column: number;
  /** Offset of the token at fault in the source, in UTF-16 code units. */
  readonly offset: number;
  /** The message without its position and link, for an editor that marks the position itself. */
  readonly detail: string;
  /**
   * @param code Why. @param detail Problem and fix. @param line 1-based line. @param column 1-based column.
   * @param offset Offset in the source.
   */
  constructor(code: WGSLErrorCode, detail: string, line: number, column: number, offset: number) {
    super(`${detail} (line ${line}, column ${column}); see ${WGSL_HELP}-${code}`);
    this.name = 'WGSLError';
    this.code = code;
    this.line = line;
    this.column = column;
    this.offset = offset;
    this.detail = detail;
  }
}

/** Maps offsets to 1-based line and column (code points), for messages and editors. */
export class SourceMap {
  private readonly starts: number[] = [0];
  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      // WGSL line breaks: LF, VT, FF, CR (CR LF counts once), NEL, LS, PS.
      if (c === 13 && text.charCodeAt(i + 1) === 10) continue;
      if (c === 10 || c === 11 || c === 12 || c === 13 || c === 0x85 || c === 0x2028 || c === 0x2029)
        this.starts.push(i + 1);
    }
  }
  /** Line and column of an offset. */
  locate(offset: number): { line: number; column: number } {
    const at = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0,
      hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    let column = 1;
    for (let i = this.starts[lo]; i < at; i++) {
      const c = this.text.charCodeAt(i);
      if (c < 0xdc00 || c > 0xdfff || i === this.starts[lo]) column++;
    }
    return { line: lo + 1, column };
  }
  /** A WGSLError at an offset. */
  error(code: WGSLErrorCode, detail: string, offset: number): WGSLError {
    const { line, column } = this.locate(offset);
    return new WGSLError(code, detail, line, column, offset);
  }
}
