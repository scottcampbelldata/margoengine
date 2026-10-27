import { forwardRef, useEffect, useRef, useState } from 'react';
import type { Mesh as MeshHandle } from '@margoengine/core';
import type { Mesh as EngineMesh } from '@margoengine/core/extension';
import type { Text as TextBlock, TextOptions, TextRenderer, Font } from '@margoengine/text';
import { useScene, useCommit, useLiveRef, assignRef, zero, report, type Scene } from './internal.js';
import { optionalPeer } from './optional.js';
import { MargoError } from '@margoengine/math/errors';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

interface TextRendererLease {
  users: number;
  promise: Promise<{ renderer: TextRenderer; api: typeof import('@margoengine/text') }>;
}
const renderers = new WeakMap<Scene['engine'], TextRendererLease>();
function acquireTextRenderer(scene: Scene): TextRendererLease {
  let entry = renderers.get(scene.engine);
  if (!entry) {
    entry = {
      users: 0,
      promise: optionalPeer('@margoengine/text', () => import('@margoengine/text')).then((api) => {
        if (scene.engine.disposed)
          throw new MargoError('disposed', 'Canvas is disposed; render the component inside a live <Canvas>.');
        const renderer = new api.TextRenderer({ name: 'margoengine-react:text' });
        scene.engine.use(renderer);
        return { renderer, api };
      }),
    };
    renderers.set(scene.engine, entry);
  }
  entry.users++;
  return entry;
}
function releaseTextRenderer(scene: Scene, entry: TextRendererLease): void {
  if (--entry.users) return;
  queueMicrotask(() => {
    if (entry.users || renderers.get(scene.engine) !== entry) return;
    renderers.delete(scene.engine);
    void entry.promise.then(
      ({ renderer }) => {
        scene.engine.removePlugin(renderer.name);
        renderer.dispose();
      },
      () => {},
    );
  });
}
/** Props of the Text component; every prop is optional unless noted. */
export interface TextProps extends Omit<TextOptions, 'mesh' | 'text'>, ErrorProps {
  text?: string;
  children?: string | number;
}
const textDefaults = {
  fontSize: 1,
  lineHeight: 1.2,
  letterSpacing: 0,
  maxWidth: Infinity,
  textAlign: 'left',
  anchorX: 'left',
  anchorY: 'top',
  direction: 'auto',
  whiteSpace: 'normal',
  overflowWrap: 'break-word',
  color: 0xffffff,
  opacity: 1,
  outlineWidth: 0,
  outlineColor: 0,
  outlineOpacity: 1,
  shadowColor: 0,
  shadowOpacity: 0,
  shadowBlur: 0,
  billboard: false,
  onTop: false,
} as const;
/** The text component. */
export const Text = forwardRef<TextBlock, TextProps>(function Text(props, ref) {
  const scene = useScene(),
    latest = useRef(props),
    [item, setItem] = useState<TextBlock | null>(null),
    handle = useRef(ref);
  handle.current = ref;
  latest.current = props;
  const font = useRef<{ input: TextOptions['font']; value: Font } | null>(null),
    apply = useRef<(text: TextBlock) => void>(() => {});
  useEffect(() => {
    let active = true,
      current: TextBlock | undefined,
      renderer: TextRenderer | undefined;
    const entry = acquireTextRenderer(scene),
      attach = (mesh: EngineMesh) => current?.attach(mesh as unknown as MeshHandle);
    entry.promise
      .then(({ renderer: loaded, api }) => {
        if (!active || scene.engine.disposed) return;
        renderer = loaded;
        apply.current = (text) => {
          const {
            children,
            text: content = String(children ?? ''),
            font: input,
            visible = true,
            position = zero,
            rotation = zero,
            scale = 1,
            matrix,
            onError,
            ...style
          } = latest.current;
          if (!font.current || font.current.input !== input)
            font.current = { input, value: input instanceof api.Font ? input : new api.Font(input) };
          text.set({
            ...textDefaults,
            shadowOffset: [0.04 * (style.fontSize ?? 1), -0.04 * (style.fontSize ?? 1)],
            ...style,
            text: content,
            font: font.current.value,
          });
          text.visible = visible;
          if (matrix) text.setMatrix(matrix);
          else text.setTransform(position, rotation, scale);
          text.attach((scene.registry?.current as unknown as MeshHandle) ?? null);
        };
        current = new api.Text();
        apply.current(current);
        renderer.add(current);
        scene.registry?.attachments.add(attach);
        assignRef(handle.current, current);
        setItem(current);
      })
      .catch((error) => {
        if (current) renderer?.remove(current);
        if (active && !scene.engine.disposed) report(scene, error, latest.current.onError);
      });
    return () => {
      active = false;
      scene.registry?.attachments.delete(attach);
      if (current) {
        const made = current;
        assignRef(handle.current, null);
        setItem((state) => (state === made ? null : state));
        renderer?.remove(made);
      }
      releaseTextRenderer(scene, entry);
    };
  }, [scene.engine, scene.registry]);
  useCommit(() => {
    if (item) apply.current(item);
  });
  useLiveRef(ref, item);
  return null;
});
