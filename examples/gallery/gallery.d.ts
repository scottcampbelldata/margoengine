// The types khronos.ts needs from gallery.js, which is plain JavaScript shared with the gallery's index page.
export function mountGallery(options: {
  engine: unknown;
  stats?: unknown;
  show: (id: string, signal: AbortSignal) => void | Promise<void>;
  reset?: () => void;
  dispose?: () => void;
}): unknown;
