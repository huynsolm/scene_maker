import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_BYTES } from '../shared/limits';
import { REQUEST_TIMEOUT_MS, uploadTimeoutMs } from '../web/api';

describe('요청 제한 시간', () => {
  it('일반 요청은 30초', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('업로드는 기본 60초에 MB 당 10초를 더한다(올림)', () => {
    expect(uploadTimeoutMs(0)).toBe(60_000);
    expect(uploadTimeoutMs(1)).toBe(70_000); // 1바이트도 1MB 로 올린다
    expect(uploadTimeoutMs(1024 * 1024)).toBe(70_000);
    expect(uploadTimeoutMs(1024 * 1024 + 1)).toBe(80_000);
  });

  it('허용하는 가장 큰 이미지(10MB)도 일반 요청보다 길고 3분을 넘지 않는다', () => {
    const t = uploadTimeoutMs(IMAGE_MAX_BYTES);
    expect(t).toBe(160_000);
    expect(t).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    expect(t).toBeLessThan(180_000);
  });
});
