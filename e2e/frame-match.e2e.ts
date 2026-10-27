import { describe, expect, it } from 'vitest';
import { compareFrames } from '../scripts/compare-frame';

/**
 * 미리보기와 실제 렌더 영상의 자막 일치를 자동으로 지킨다(측정 방법과 표는 docs/frame-comparison.md).
 * 허용 오차는 측정 오차(±1px)에 여유를 둔 값이다. 글꼴·배치 규칙이 어긋나면 이 테스트가 실패한다.
 */
describe('미리보기 ↔ 영상 자막 일치', () => {
  it('배포 CSS 의 미리보기가 영상 프레임과 상자 ±5px, 글자 ±8px, 줄바꿈 위치까지 같다', async () => {
    const { variants } = await compareFrames({ only: ['served'] });
    const served = variants.find((v) => v.id === 'served')!;
    expect(served.fontCovered, '자막 웹 글꼴이 로드되고 모든 글자를 담아야 한다').toBe(true);
    expect(served.rows).toHaveLength(6);
    for (const r of served.rows) {
      const where = `[${r.label}]`;
      expect(Math.abs(r.box.dx), `${where} 상자 x`).toBeLessThanOrEqual(3);
      expect(Math.abs(r.box.dy), `${where} 상자 y`).toBeLessThanOrEqual(3);
      expect(Math.abs(r.box.dw), `${where} 상자 폭`).toBeLessThanOrEqual(5);
      expect(Math.abs(r.box.dh), `${where} 상자 높이`).toBeLessThanOrEqual(5);
      expect(Math.abs(r.ink.dx), `${where} 글자 x`).toBeLessThanOrEqual(4);
      expect(Math.abs(r.ink.dy), `${where} 글자 y`).toBeLessThanOrEqual(3);
      expect(Math.abs(r.ink.dw), `${where} 글자 폭`).toBeLessThanOrEqual(8);
      expect(r.lines.preview, `${where} 줄 수`).toBe(r.lines.video);
      expect(r.sameBreaks, `${where} 줄바꿈 위치`).toBe(true);
    }
  }, 180_000);
});
