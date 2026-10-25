import { describe, expect, it } from 'vitest';
import { autoGrade } from '../src/srs/grading';

const thresholds = { easySeconds: 5, hardSeconds: 15 };

describe('autoGrade', () => {
  it('grades correct answers by time', () => {
    expect(autoGrade({ correct: true, elapsedMs: 4999, thresholds })).toBe('easy');
    expect(autoGrade({ correct: true, elapsedMs: 5000, thresholds })).toBe('good');
    expect(autoGrade({ correct: true, elapsedMs: 15000, thresholds })).toBe('good');
    expect(autoGrade({ correct: true, elapsedMs: 15001, thresholds })).toBe('hard');
  });

  it('wrong is Again regardless of time', () => {
    expect(autoGrade({ correct: false, elapsedMs: 1000, thresholds })).toBe('again');
  });

  it('caps typo answers at Hard', () => {
    expect(autoGrade({ correct: true, typo: true, elapsedMs: 1000, thresholds })).toBe('hard');
    expect(autoGrade({ correct: true, typo: true, elapsedMs: 10000, thresholds })).toBe('hard');
  });
});
