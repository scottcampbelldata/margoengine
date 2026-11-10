/// <reference lib="esnext.disposable" preserve="true" />
import type { Ui } from '@margoengine/ui';
import { rangeError, typeError } from '../../shared/errors.js';
/** A message is plain text or cardinal plural forms. Every plural message needs other. */
export type LocalizedMessage =
  | string
  | ({ other: string } & Partial<Record<Intl.LDMLPluralRule | `=${number}`, string>>);
/** A locale's flat string-key table. Keys may contain dots. */
export type LocaleTable = Readonly<Record<string, LocalizedMessage>>;
/** Named substitutions; count also chooses plural forms. */
export type MessageParameters = Readonly<Record<string, string | number>>;
/** Locale selection and table options. */
export interface LocalizationOptions {
  /** Initial locale, default first table locale (or en with no tables). */
  locale?: string;
  /** Final fallback locale, default first table locale (or en). Parent locales are tried first. */
  fallback?: string;
  /** Optional explicit directions by locale. Default inferred from the locale's maximized script. */
  directions?: Readonly<Record<string, 'ltr' | 'rtl'>>;
  /** Default 'key'; 'error' throws a linked error for missing keys or parameters. */
  missing?: 'key' | 'error';
}
/** A translation assigned through a normal widget setter, which invalidates layout and accessibility mirrors. */
export interface TranslationBinding {
  target: { text?: string; label?: string; placeholder?: string };
  key: string;
  /** Default text. */
  property?: 'text' | 'label' | 'placeholder';
  /** Re-evaluated on locale changes or refresh(). */
  parameters?: MessageParameters | (() => MessageParameters);
}
function canonical(locale: string): string {
  try {
    return new Intl.Locale(locale).baseName;
  } catch {
    throw rangeError('Locale must be a BCP 47 language tag such as en-US or ar; supply a valid tag', 'ui');
  }
}
const RTL_SCRIPTS = new Set([
  'Arab',
  'Hebr',
  'Syrc',
  'Thaa',
  'Nkoo',
  'Adlm',
  'Rohg',
  'Samr',
  'Mand',
  'Armi',
  'Avst',
  'Chrs',
  'Elym',
  'Hatr',
  'Hung',
  'Khar',
  'Lydi',
  'Mani',
  'Mend',
  'Merc',
  'Mero',
  'Narb',
  'Nbat',
  'Orkh',
  'Ougr',
  'Palm',
  'Phli',
  'Phlp',
  'Phnx',
  'Prti',
  'Sogd',
  'Sogo',
  'Yezi',
]);
/** Locale tables with parent/fallback lookup, plural selection, substitutions and live widget bindings. */
export class Localization {
  private readonly tables = new Map<string, LocaleTable>();
  private readonly listeners = new Set<() => void>();
  private readonly bindings = new Set<() => void>();
  private readonly directions = new Map<string, 'ltr' | 'rtl'>();
  private current: string;
  readonly fallback: string;
  private readonly missing: 'key' | 'error';
  constructor(tables: Readonly<Record<string, LocaleTable>> = {}, options: LocalizationOptions = {}) {
    const first = Object.keys(tables)[0] ?? 'en';
    this.current = canonical(options.locale ?? first);
    this.fallback = canonical(options.fallback ?? first);
    this.missing = options.missing ?? 'key';
    if (!['key', 'error'].includes(this.missing))
      throw typeError('missing must be key or error; select a missing-key policy', 'ui');
    for (const [locale, direction] of Object.entries(options.directions ?? {})) {
      if (direction !== 'ltr' && direction !== 'rtl')
        throw typeError('Locale direction must be ltr or rtl; supply one of these values', 'ui');
      this.directions.set(canonical(locale), direction);
    }
    for (const [locale, table] of Object.entries(tables)) this.setTable(locale, table);
  }
  get locale(): string {
    return this.current;
  }
  set locale(locale: string) {
    const next = canonical(locale);
    if (next === this.current) return;
    this.current = next;
    this.refresh();
  }
  /** Explicit locale metadata wins; otherwise use the maximized Unicode script (ar-Latn stays LTR). */
  get direction(): 'ltr' | 'rtl' {
    for (const locale of this.parents(this.current)) {
      const direction = this.directions.get(locale);
      if (direction) return direction;
    }
    const locale = new Intl.Locale(this.current) as Intl.Locale & { getTextInfo?: () => { direction?: 'ltr' | 'rtl' } };
    return locale.getTextInfo?.().direction ?? (RTL_SCRIPTS.has(locale.maximize().script ?? '') ? 'rtl' : 'ltr');
  }
  /** Replace a table atomically. Input tables are cloned so later caller mutations cannot bypass relayout. */
  setTable(locale: string, table: LocaleTable): void {
    const next: Record<string, LocalizedMessage> = Object.create(null);
    if (!table || typeof table !== 'object' || Array.isArray(table))
      throw typeError('Locale table must map string keys to messages; pass an object', 'ui');
    for (const [key, message] of Object.entries(table)) {
      if (typeof message === 'string') next[key] = message;
      else {
        if (
          !message ||
          typeof message.other !== 'string' ||
          Object.entries(message).some(
            ([form, value]) =>
              typeof value !== 'string' ||
              (!['zero', 'one', 'two', 'few', 'many', 'other'].includes(form) && !/^=-?\d+(?:\.\d+)?$/.test(form)),
          )
        )
          throw typeError(
            'Plural messages need string forms and an other fallback; supply a valid message table',
            'ui',
          );
        next[key] = Object.freeze({ ...message });
      }
    }
    this.tables.set(canonical(locale), Object.freeze(next));
    this.refresh();
  }
  private parents(locale: string): string[] {
    const result = [];
    let parts = locale.split('-');
    while (parts.length) {
      result.push(parts.join('-'));
      parts = parts.slice(0, -1);
    }
    return result;
  }
  /** Resolve a key, using exact-count then Intl cardinal plural forms and {name} substitutions. */
  t(key: string, parameters: MessageParameters = {}): string {
    let message: LocalizedMessage | undefined,
      resolved = this.current;
    for (const locale of new Set([...this.parents(this.current), ...this.parents(this.fallback)])) {
      const table = this.tables.get(locale);
      if (table && Object.hasOwn(table, key)) {
        message = table[key];
        resolved = locale;
        break;
      }
    }
    if (message === undefined) {
      if (this.missing === 'error')
        throw rangeError(`Missing translation ${key}; add it to ${this.current} or ${this.fallback}`, 'ui');
      return key;
    }
    if (typeof message !== 'string') {
      const count = parameters.count;
      if (typeof count !== 'number' || !Number.isFinite(count))
        throw rangeError(`Plural translation ${key} needs a finite count parameter; pass {count: number}`, 'ui');
      message = message[`=${count}`] ?? message[new Intl.PluralRules(resolved).select(count)] ?? message.other;
    }
    return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
      if (Object.hasOwn(parameters, name)) return String(parameters[name]);
      if (this.missing === 'error')
        throw rangeError(`Translation ${key} needs parameter ${name}; supply it in parameters`, 'ui');
      return token;
    });
  }
  /** Reapply translations after changing dynamic parameters. */
  refresh(): void {
    for (const listener of this.listeners) listener();
  }
  /** Subscribe to table/locale changes. Unsubscribe is disposable. */
  onChange(listener: () => void): (() => void) & { [Symbol.dispose](): void } {
    this.listeners.add(listener);
    const off = () => {
      this.listeners.delete(listener);
    };
    return Object.assign(off, { [Symbol.dispose ?? Symbol.for('Symbol.dispose')]: off }) as (() => void) & {
      [Symbol.dispose](): void;
    };
  }
  /** Apply now and on every locale/table change. Layout recomputes on the UI's next frame. */
  bind(
    ui: Ui,
    bindings: readonly TranslationBinding[],
    options: { signal?: AbortSignal } = {},
  ): (() => void) & { [Symbol.dispose](): void } {
    options.signal?.throwIfAborted();
    const apply = () => {
      const values = bindings.map((binding) =>
        this.t(binding.key, typeof binding.parameters === 'function' ? binding.parameters() : binding.parameters),
      );
      ui.direction = this.direction;
      bindings.forEach((binding, i) => {
        binding.target[binding.property ?? 'text'] = values[i];
      });
    };
    apply();
    const off = this.onChange(apply),
      abort = () => release();
    options.signal?.addEventListener('abort', abort, { once: true });
    const release = () => {
      off();
      options.signal?.removeEventListener('abort', abort);
      this.bindings.delete(release);
    };
    this.bindings.add(release);
    return Object.assign(release, { [Symbol.dispose ?? Symbol.for('Symbol.dispose')]: release }) as (() => void) & {
      [Symbol.dispose](): void;
    };
  }
  /** Detach every binding/subscriber; does not dispose the widgets. */
  dispose(): void {
    for (const release of this.bindings) release();
    this.listeners.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol.for('Symbol.dispose')) as symbol](): void {
    this.dispose();
  }
}
