// ─────────────────────────────────────────────────────────────────────────────
// Compass regime snapshots for the journal.
//
// The regime Compass had classified for a trade's entry date, read once at
// write time and stored — the same "captured once, never re-read" rule as the
// Oracle entry snapshot (oracle-snapshot.ts). The regime is market-wide, not
// per instrument, so only the date addresses it.
//
// The reading is the live classification in effect on that date: the row for
// the date itself, or the most recent one before it (Compass classifies US
// trading days, so a weekend entry reads the Friday). The stored value is
// `finalRegime` — the regime after the Shock Layer — falling back to
// `activeRegime` on rows written before the Shock Layer existed, where
// `finalRegime` is empty. No row on or before the date → null, never a later
// reading and never a guess.
//
// Compass is read through its own repository and not modified.
// ─────────────────────────────────────────────────────────────────────────────
import { compassClassificationsRepository } from '@core/repositories/compass-classifications.repository';
import { toScoreDate } from './oracle-snapshot';

/** Where a stored regime came from (DB CHECK trades_compass_regime_entry_source_check). */
export type CompassRegimeSource = 'snapshot' | 'archive' | 'manual';

export interface RegimeSnapshotColumns {
  compassRegimeAtEntry: string | null;
  /** The classification date the regime was read from — not always the entry date. */
  compassRegimeEntryDate: Date | null;
  compassRegimeEntrySource: CompassRegimeSource | null;
}

export const NO_REGIME_SNAPSHOT: RegimeSnapshotColumns = {
  compassRegimeAtEntry: null,
  compassRegimeEntryDate: null,
  compassRegimeEntrySource: null,
};

/** Reads the live Compass regime in effect on `dateOpened` and freezes it. */
export async function snapshotCompassRegime(dateOpened: Date): Promise<RegimeSnapshotColumns> {
  const row = await compassClassificationsRepository.getRegimeGateAsOf(toScoreDate(dateOpened), false);
  if (!row) return NO_REGIME_SNAPSHOT;
  const regime = row.finalRegime?.trim() || row.activeRegime?.trim() || null;
  if (!regime) return NO_REGIME_SNAPSHOT;
  return {
    compassRegimeAtEntry: regime,
    compassRegimeEntryDate: toScoreDate(row.classificationDate),
    compassRegimeEntrySource: 'snapshot',
  };
}
