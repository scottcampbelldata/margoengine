import type { Specs } from "./USDAParser.js";

export class USDCParser {
  buffer: ArrayBuffer;
  reader: {
    view: DataView;
    readUint64(): number;
    seek(offset: number): void;
    tell(): number;
  };
  version: { major: number; minor: number; patch: number };
  tocOffset: number;
  sections: Record<string, { start: number; size: number }>;
  parseData(buffer: ArrayBuffer): { specsByPath: Specs };
  _readBootstrap(): void;
  _readTOC(): void;
  _readArrayValue(rep: any): any;
  _readValue(rep: any): any;
  _readInlinedValue(rep: any): any;
}
