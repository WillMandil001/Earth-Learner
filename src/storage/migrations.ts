import type { LayerId } from '../learn/layer';
import { upgradeSettingsV1 } from '../settings/schema';
import { cardKey } from '../srs/queue';

/**
 * v1 → v2 record transforms (Phase 2 → Phase 3), shared by the IndexedDB
 * upgrade and by importing v1 export files. v1 only had countries, so every
 * v1 card becomes a 'country' layer card with the country ID as its item ID.
 */

type Obj = Record<string, unknown>;
const V1_LAYER: LayerId = 'country';

export function isV1Card(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'countryId' in v && !('layerId' in v);
}

/** { key: 'GBR:locate', countryId, direction, card, introducedDay } → layer card. */
export function migrateCardV1(v: unknown): unknown {
  if (!isV1Card(v)) return v;
  const { countryId, direction, card, introducedDay } = v as Obj;
  return {
    key: cardKey(V1_LAYER, String(countryId), direction as never),
    layerId: V1_LAYER,
    itemId: countryId,
    direction,
    card,
    introducedDay,
  };
}

export function migrateLogV1(v: unknown): unknown {
  if (!isV1Card(v)) return v;
  const { countryId, ...rest } = v as Obj;
  return { ...rest, key: cardKey(V1_LAYER, String(countryId), rest.direction as never), layerId: V1_LAYER, itemId: countryId };
}

/** Daily counters move under layers.country. */
export function migrateMetaV1(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  const m = v as Obj;
  const daily = m.daily as Obj | undefined;
  if (!daily || 'layers' in daily) return { ...m, schemaVersion: 2 };
  return {
    schemaVersion: 2,
    daily: { day: daily.day, layers: { [V1_LAYER]: { reviewsDone: daily.reviewsDone, extraNew: daily.extraNew } } },
  };
}

export const migrateSettingsV1 = upgradeSettingsV1;
