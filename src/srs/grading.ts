import type { TimeThresholds } from '../settings/schema';
import type { Grade } from './scheduler';

export interface GradeInput {
  correct: boolean;
  /** Accepted with a spelling slip: capped at Hard. */
  typo?: boolean;
  elapsedMs: number;
  thresholds: TimeThresholds;
}

/** Easy under `easySeconds`, Good up to `hardSeconds`, Hard beyond; wrong = Again. */
export function autoGrade({ correct, typo = false, elapsedMs, thresholds }: GradeInput): Grade {
  if (!correct) return 'again';
  const s = elapsedMs / 1000;
  const byTime: Grade = s < thresholds.easySeconds ? 'easy' : s <= thresholds.hardSeconds ? 'good' : 'hard';
  return typo ? 'hard' : byTime;
}
