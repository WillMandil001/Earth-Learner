import type { Store } from '../storage/db';
import type { CountryId } from '../types';
import { normaliseSettings, updateSetting, type Settings } from './schema';

/** Current settings: validated on every change, persisted immediately, observable. */
export class SettingsStore {
  private listeners = new Set<(s: Settings) => void>();

  private constructor(
    private store: Store,
    private current: Settings,
    private readonly countries: ReadonlySet<CountryId>,
  ) {}

  static async load(store: Store, countries: ReadonlySet<CountryId>): Promise<SettingsStore> {
    const { settings } = normaliseSettings(await store.loadSettings());
    if (!countries.has(settings.learning.homeCountry)) settings.learning.homeCountry = [...countries][0]!;
    return new SettingsStore(store, settings, countries);
  }

  get value(): Settings {
    return this.current;
  }

  /** Validate and apply one field. Returns an error message, or null on success. */
  async set(path: string, value: unknown): Promise<string | null> {
    const r = updateSetting(this.current, path, value, this.countries);
    if (!r.ok) return r.error;
    await this.replace(r.settings);
    return null;
  }

  async replace(settings: Settings): Promise<void> {
    this.current = settings;
    await this.store.saveSettings(settings);
    this.listeners.forEach((l) => l(settings));
  }

  /** Reload after an import replaced the stored settings. */
  async reload(): Promise<void> {
    this.current = normaliseSettings(await this.store.loadSettings()).settings;
    this.listeners.forEach((l) => l(this.current));
  }

  subscribe(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
