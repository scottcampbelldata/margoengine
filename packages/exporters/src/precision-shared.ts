// Shared input, JSON and file-tree rules of the precision bundles (Unity, Unreal, Godot and Roblox runtime).
import { SHA256 } from './hash.js';

/** One bundle member: a relative path with forward slashes, its bytes and media type. */
export interface PrecisionFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** An authored object's local transform: translation, unit quaternion (x, y, z, w) and scale. */
export interface PrecisionTransform {
  readonly position: readonly number[];
  readonly rotation: readonly number[];
  readonly scale: readonly number[];
}

/** An authored object (a logical node). Names are exact; no exporter renames them. */
export interface PrecisionObject {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly transform: PrecisionTransform;
}

/** The authored record a face came from: its object, material and per-corner RGBA. */
export interface PrecisionFaceSource {
  readonly id: string;
  readonly objectId: string;
  readonly materialId: string;
  readonly vertices: readonly string[];
  readonly colors: readonly (readonly number[])[];
}

/**
 * One captured face: its corners in object space (`localCorners`), in world space before the output frame
 * (`worldCorners`) and after it (`outputWorldCorners`), the UVs it samples (`effectiveUVs`), and the triangles that
 * index those corners in object space (`localTriangles`) and when baked to world space (`worldBakedTriangles`).
 */
export interface PrecisionFace {
  readonly source: PrecisionFaceSource;
  readonly effectiveUVs: readonly (readonly number[])[];
  readonly localCorners: readonly (readonly number[])[];
  readonly worldCorners: readonly (readonly number[])[];
  readonly outputWorldCorners: readonly (readonly number[])[];
  readonly localTriangles: readonly (readonly number[])[];
  readonly worldBakedTriangles: readonly (readonly number[])[];
  readonly localNormal: readonly number[];
  readonly worldNormal: readonly number[];
}

/** A material record: its exact name and the image it samples (none for untextured). */
export interface PrecisionMaterial {
  readonly id: string;
  readonly name: string;
  readonly assetId: string | null;
  readonly alphaMode: string;
  /** Mask threshold; 0.5 when left out. */
  readonly alphaCutoff?: number;
  readonly doubleSided: boolean;
}

/** An original image: top-left RGBA8 pixels at its own dimensions. */
export interface PrecisionImage {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: readonly number[];
}

/**
 * The captured scene a precision bundle is made from and checked against. An application passes its own export
 * snapshot when it has this shape; nothing is copied. `document` holds the material and image records faces refer to.
 */
export interface PrecisionScene {
  readonly document: {
    readonly materials: Readonly<Record<string, PrecisionMaterial>>;
    readonly assets: Readonly<Record<string, PrecisionImage>>;
  };
  readonly objects: readonly PrecisionObject[];
  readonly faces: readonly PrecisionFace[];
  readonly outputFrame: { readonly originMode: 'world' | 'bottom-base'; readonly pivot: readonly number[] };
  readonly rigMode?: 'pose' | 'skin';
}

/** One preflight finding: a platform-prefixed code and the fix in words. */
export interface PrecisionDiagnostic {
  readonly code: string;
  readonly message: string;
}

/** The export choices a precision bundle accepts and records in its manifest. */
export interface PrecisionOptions {
  readonly layout: 'objects' | 'combined';
  readonly transformMode: 'preserve' | 'bake';
  readonly animation: 'static' | 'flipbook';
  readonly skin: boolean;
  readonly objectAnimation: boolean;
}

/** True when every own key of `record` is a string listed in `names`. */
export const onlyFields = (record: object, names: readonly string[]): boolean =>
  Reflect.ownKeys(record).every((key) => typeof key === 'string' && names.includes(key));

/**
 * Canonical JSON: object keys sorted, numbers as `String(n)` with negative zero written `-0`, strings and literals
 * as `JSON.stringify` writes them. Manifests are written and compared in this form.
 */
export function canonicalJSON(value: unknown): string {
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const record = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonicalJSON(record[key]))
      .join(',') +
    '}'
  );
}

/** Deep equality with the meaning of {@link canonicalJSON}: key order ignored, array order and `-0` kept. */
export function canonicalEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false;
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  for (const key of keys) if (!Object.hasOwn(b, key) || !canonicalEqual(a[key], b[key])) return false;
  return true;
}

/** Lower-case hex SHA-256. */
export const sha256Hex = (bytes: Uint8Array): string => new SHA256().update(bytes).hex();

const encoder = new TextEncoder();
/** UTF-8 bytes of a string. */
export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text);

/** True for a basename of ASCII letters, digits, `_` and `-` that is not a reserved Windows device name. */
export const safeBasename = (basename: unknown): basename is string =>
  typeof basename === 'string' &&
  /^[A-Za-z0-9_-]+$/.test(basename) &&
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(basename);

/**
 * Checks and detaches a bundle's files: nonempty bytes, explicit media types, relative forward-slash paths without
 * reserved or alias segments, and no duplicate (ignoring case) or file/folder conflict. Returns copies sorted by path.
 * @throws TypeError naming the first problem.
 */
export function copyBundleTree(input: unknown): PrecisionFile[] {
  if (!Array.isArray(input) || input.length === 0)
    throw new TypeError('Export tree is empty; export at least one file.');
  const members = new Set<string>();
  const files: PrecisionFile[] = input.map((value: unknown) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      Object.keys(value).some((key) => !['filename', 'bytes', 'mimeType'].includes(key))
    )
      throw new TypeError('Export file has invalid fields; supply filename, bytes and mimeType only.');
    const file = value as PrecisionFile;
    if (
      typeof file.filename !== 'string' ||
      !file.filename ||
      /[\\:<>"|?*\u0000-\u001f\u007f-\u009f]/.test(file.filename)
    )
      throw new TypeError(
        'Export path must be relative with forward slashes and no controls or colon; choose safe file names.',
      );
    for (const part of file.filename.split('/')) {
      if (
        !part ||
        part === '.' ||
        part === '..' ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(part.split('.')[0]!.replace(/[ .]+$/, ''))
      )
        throw new TypeError(
          'Export path contains an unsafe segment; choose relative names without aliases or reserved devices.',
        );
    }
    const key = file.filename.toUpperCase();
    if (members.has(key))
      throw new TypeError('Export tree contains duplicate paths; assign distinct names ignoring case.');
    members.add(key);
    if (!(file.bytes instanceof Uint8Array) || !file.bytes.byteLength)
      throw new TypeError('Export bytes must be nonempty Uint8Array; encode the complete file before exporting.');
    if (typeof file.mimeType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType))
      throw new TypeError('Export MIME type is invalid; supply an explicit media type.');
    return { filename: file.filename, bytes: new Uint8Array(file.bytes), mimeType: file.mimeType };
  });
  for (const key of members) {
    const segments = key.split('/');
    for (let i = 1; i < segments.length; i++)
      if (members.has(segments.slice(0, i).join('/')))
        throw new TypeError('Export tree has a file/directory conflict; assign separate relative paths.');
  }
  return files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
}

/**
 * What only the application can judge about its own source records. The Unity, Unreal and Godot preflights ask
 * these at fixed points so their findings keep one order.
 */
export interface PrecisionSourceChecks<S extends PrecisionScene = PrecisionScene> {
  /**
   * The source document: `fields` false when it has top-level fields the application does not know, `extensions`
   * true when it carries extension metadata the application cannot map, `extensionShape` false when metadata it does
   * know is not in its versioned form.
   */
  document(scene: S): { readonly fields: boolean; readonly extensions: boolean; readonly extensionShape: boolean };
  /** Reads the document's rig, clip and UV metadata; throws when it cannot be read. */
  readMetadata(scene: S): void;
  /** True when a face's source record or one of its vertices has fields with no mapping. */
  faceExtension(face: S['faces'][number], scene: S): boolean;
  /**
   * True unless the material is in the bounded unlit profile: no unknown fields, basic shading, white tint, full
   * opacity, no emission or specular, normal blending and nearest filtering. Throw when its appearance cannot be read.
   */
  materialOutsideProfile(material: S['document']['materials'][string]): boolean;
  /** True when an image record has fields with no mapping. */
  imageExtension(image: S['document']['assets'][string]): boolean;
}

/** The application's source master as stored in a bundle. */
export interface PrecisionMaster {
  /** The complete editable source, byte for byte. */
  readonly bytes: Uint8Array;
  /** Its file extension without the dot; the member is `<basename>-source.<extension>`. */
  readonly extension: string;
  /** Whether it is the user's complete original project or a snapshot made for the export. */
  readonly role: 'original-full-source-project' | 'export-snapshot';
}

/** The application's identity of the captured scene. */
export interface PrecisionSnapshot {
  /** SHA-256 of the application's canonical encoding of the captured scene. */
  readonly sha256: string;
  /** The capture options, as the application's canonical JSON. */
  readonly optionsJSON: string;
}

/** True when `name` can be a Windows file stem as is: not blank, no reserved characters or device names, no trailing dot or space. */
export const nativeStemSupported = (name: string): boolean =>
  name.trim().length > 0 &&
  !/[<>:"/\\|?*\u0000-\u001f]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name);

/** True when Float32 stores `value` finitely within `budget`. */
export const float32Within = (value: number, budget: number) =>
  Number.isFinite(Math.fround(value)) && Math.abs(Math.fround(value) - value) <= budget;

/** True when every pixel component is an integer byte and every alpha is 255. */
export const opaqueRGBA8 = (image: PrecisionImage): boolean =>
  !image.pixels.some((v, i) => !Number.isInteger(v) || v < 0 || v > 255 || (i % 4 === 3 && v !== 255));

/** Untrusted parsed JSON (what `JSON.parse` returns): the verifiers read it field by field with runtime checks. */
export type ParsedJSON = ReturnType<typeof JSON.parse>;
