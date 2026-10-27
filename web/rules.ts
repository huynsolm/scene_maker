import { DURATION_MAX_SEC, DURATION_MIN_SEC, IMAGE_MAX_BYTES, IMAGE_TYPES } from '../shared/limits';

/** 입력값을 3~30 사이 정수로 맞춘다. 숫자가 아니면 null. */
export function clampDuration(raw: string | number): { value: number; adjusted: boolean } | null {
  const trimmed = typeof raw === 'number' ? raw : raw.trim();
  if (trimmed === '') return null; // Number('') 은 0 이라서 먼저 걸러야 한다
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  const value = Math.min(DURATION_MAX_SEC, Math.max(DURATION_MIN_SEC, rounded));
  return { value, adjusted: value !== n };
}

export interface SceneForCheck {
  text: string;
  hasImage: boolean;
}

export interface MissingReport {
  titleMissing: boolean;
  scenes: Array<{ textMissing: boolean; imageMissing: boolean }>;
  count: number;
}

/** 영상 생성 전에 비어 있으면 안 되는 항목: 제목, 각 장면의 문구와 이미지. */
export function findMissing(title: string, scenes: SceneForCheck[]): MissingReport {
  const rows = scenes.map((s) => ({ textMissing: s.text.trim() === '', imageMissing: !s.hasImage }));
  const count =
    (title.trim() === '' ? 1 : 0) + rows.reduce((a, r) => a + (r.textMissing ? 1 : 0) + (r.imageMissing ? 1 : 0), 0);
  return { titleMissing: title.trim() === '', scenes: rows, count };
}

/** 서버 요청 전에 걸러 낼 수 있는 것만 확인한다. 실제 형식·크기 판정은 서버가 한다. */
export function precheckImage(file: File): string | null {
  const allowed = Object.values(IMAGE_TYPES) as string[];
  if (!allowed.includes(file.type)) return 'JPG, PNG, WebP 이미지만 올릴 수 있어요';
  if (file.size > IMAGE_MAX_BYTES) return '이미지는 10MB 이하만 올릴 수 있어요';
  return null;
}
