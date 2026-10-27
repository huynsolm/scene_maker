import { describe, expect, it } from 'vitest';
import { clampDuration, findMissing, precheckImage } from '../web/rules';
import { formatUpdated } from '../web/format';

describe('clampDuration', () => {
  it('범위 안의 정수는 그대로', () => {
    expect(clampDuration('10')).toEqual({ value: 10, adjusted: false });
    expect(clampDuration('3')).toEqual({ value: 3, adjusted: false });
    expect(clampDuration('30')).toEqual({ value: 30, adjusted: false });
  });
  it('범위를 벗어나면 3~30 으로 맞추고 adjusted 로 알린다', () => {
    expect(clampDuration('2')).toEqual({ value: 3, adjusted: true });
    expect(clampDuration('0')).toEqual({ value: 3, adjusted: true });
    expect(clampDuration('-4')).toEqual({ value: 3, adjusted: true });
    expect(clampDuration('99')).toEqual({ value: 30, adjusted: true });
  });
  it('소수는 반올림하고 adjusted 로 알린다', () => {
    expect(clampDuration('10.4')).toEqual({ value: 10, adjusted: true });
  });
  it('숫자가 아니거나 비어 있으면 null', () => {
    expect(clampDuration('')).toBeNull();
    expect(clampDuration('  ')).toBeNull();
    expect(clampDuration('abc')).toBeNull();
  });
});

describe('findMissing', () => {
  const ok = { text: '문구', hasImage: true };
  it('모두 채워져 있으면 0개', () => {
    expect(findMissing('제목', [ok, ok, ok]).count).toBe(0);
  });
  it('빈 제목·공백뿐인 문구·없는 이미지를 센다', () => {
    const r = findMissing('  ', [{ text: '   ', hasImage: false }, ok, { text: '', hasImage: true }]);
    expect(r.titleMissing).toBe(true);
    expect(r.scenes[0]).toEqual({ textMissing: true, imageMissing: true });
    expect(r.scenes[2]).toEqual({ textMissing: true, imageMissing: false });
    expect(r.count).toBe(1 + 2 + 0 + 1);
  });
});

describe('precheckImage', () => {
  const file = (type: string, size: number) => ({ type, size }) as File;
  it('허용 형식과 크기', () => {
    expect(precheckImage(file('image/png', 100))).toBeNull();
    expect(precheckImage(file('image/jpeg', 100))).toBeNull();
    expect(precheckImage(file('image/webp', 100))).toBeNull();
    expect(precheckImage(file('image/gif', 100))).not.toBeNull();
    expect(precheckImage(file('application/pdf', 100))).not.toBeNull();
    expect(precheckImage(file('image/png', 10 * 1024 * 1024 + 1))).not.toBeNull();
    expect(precheckImage(file('image/png', 10 * 1024 * 1024))).toBeNull();
  });
});

describe('formatUpdated', () => {
  it('오늘은 시각만, 다른 날은 월/일과 시각', () => {
    const now = new Date(2026, 9, 27, 15, 0);
    expect(formatUpdated(new Date(2026, 9, 27, 9, 5).toISOString(), now)).toBe('오늘 09:05');
    expect(formatUpdated(new Date(2026, 9, 26, 17, 5).toISOString(), now)).toBe('10월 26일 17:05');
  });
});
