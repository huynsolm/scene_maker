import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUBTITLE, VIDEO } from '../shared/limits';
import { buildAss, escapeAssText } from '../server/render/ass';
import { loadMeasurer } from '../server/render/font';
import { layoutSubtitle, normalizeSubtitleText } from '../server/render/layout';

const measurer = loadMeasurer(path.resolve('fonts/NotoSansKR-SemiBold.ttf'));
const L = (t: string) => layoutSubtitle(t, measurer);
const safeLeft = (VIDEO.width * SUBTITLE.sideMarginPct) / 100;
const safeRight = VIDEO.width - safeLeft;
const bottom = VIDEO.height - (VIDEO.height * SUBTITLE.bottomMarginPct) / 100;

describe('자막 레이아웃', () => {
  it('짧은 문구는 한 줄이고 상자가 가운데·아래쪽 11% 위에 놓인다', () => {
    const l = L('매장에 우유가 부족한지 확인하기 어려우셨나요?');
    expect(l.lines).toHaveLength(1);
    expect(l.box.x + l.box.w / 2).toBeCloseTo(VIDEO.width / 2, 5);
    expect(l.box.y + l.box.h).toBeCloseTo(bottom, 5);
  });

  it('샘플 문구 3개의 상자 폭은 글자 폭에 여백만 더한 값이다', () => {
    const text = '매장에 우유가 부족한지 확인하기 어려우셨나요?';
    const l = L(text);
    const padX = (VIDEO.width * SUBTITLE.padXWidthPct) / 100;
    expect(l.box.w).toBeCloseTo(measurer.width(text, l.emPx) + 2 * padX, 3);
  });

  it('줄바꿈이 생기면 상자는 최대 폭(안전 영역 전체)을 쓰고, 사용자 줄바꿈만 있을 땐 가장 긴 줄에 맞춘다(미리보기 CSS 와 같은 규칙)', () => {
    const maxBoxW = VIDEO.width - 2 * ((VIDEO.width * SUBTITLE.sideMarginPct) / 100);
    const wrapped = L('매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.');
    expect(wrapped.lines.length).toBeGreaterThan(1);
    expect(wrapped.box.w).toBeCloseTo(maxBoxW, 5);
    const manual = L('첫째 줄\n둘째 줄');
    expect(manual.box.w).toBeLessThan(maxBoxW / 2);
    const padX = (VIDEO.width * SUBTITLE.padXWidthPct) / 100;
    expect(manual.box.w).toBeCloseTo(Math.max(...manual.lines.map((x) => measurer.width(x, manual.emPx))) + 2 * padX, 3);
  });

  it('긴 문구는 여러 줄이 되어도 상자가 좌우 안전 영역 안에 있고 아래 기준선을 지킨다', () => {
    const l = L('매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.');
    expect(l.lines.length).toBeGreaterThanOrEqual(2);
    expect(l.box.x).toBeGreaterThanOrEqual(safeLeft - 0.01);
    expect(l.box.x + l.box.w).toBeLessThanOrEqual(safeRight + 0.01);
    expect(l.box.y + l.box.h).toBeCloseTo(bottom, 5);
    expect(l.box.y).toBeGreaterThan(0);
  });

  it('줄바꿈은 띄어쓰기에서만 하고(단어 중간에서 자르지 않음) 줄 길이가 고르다', () => {
    const text = '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.';
    const l = L(text);
    expect(l.lines.join(' ')).toBe(text);
    const widths = l.lines.map((x) => measurer.width(x, l.emPx));
    // 균형: 가장 긴 줄과 가장 짧은 줄의 차이가 가장 긴 줄의 40% 이하(마지막 줄만 훨씬 짧은 모양을 막는다)
    expect((Math.max(...widths) - Math.min(...widths)) / Math.max(...widths)).toBeLessThan(0.4);
  });

  it('사용자가 넣은 줄바꿈은 지킨다', () => {
    expect(L('첫째 줄\n둘째 줄').lines).toEqual(['첫째 줄', '둘째 줄']);
    expect(L('가나다\n\n라마바').lines).toHaveLength(3); // 빈 줄도 한 줄로 남는다(미리보기의 pre-line 과 동일)
  });

  it('띄어쓰기 없이 매우 긴 문자열은 글자 단위로 잘라 상자 밖으로 나가지 않게 한다', () => {
    const l = L('가'.repeat(80));
    expect(l.lines.length).toBeGreaterThan(1);
    expect(l.box.x).toBeGreaterThanOrEqual(safeLeft - 0.01);
    expect(l.box.x + l.box.w).toBeLessThanOrEqual(safeRight + 0.01);
    expect(l.lines.join('')).toBe('가'.repeat(80));
  });

  it('최대 길이(200자)도 상자가 프레임 위쪽 안전 영역(10%) 안에 머문다', () => {
    const l = L('안내 문구입니다 '.repeat(25).trim().slice(0, 200));
    expect(l.box.y).toBeGreaterThanOrEqual((VIDEO.height * 10) / 100);
  });
});

describe('문구 정리(NFC·보이지 않는 문자)', () => {
  const ko = '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.';

  it('분해된 한글 자모(NFD)는 NFC 와 같은 줄바꿈·상자 크기가 된다(정리하지 않으면 폭이 2배 이상으로 계산됐다)', () => {
    const nfd = ko.normalize('NFD');
    expect(nfd).not.toBe(ko);
    expect(nfd.length).toBeGreaterThan(ko.length * 2);
    const a = L(ko);
    const b = L(nfd);
    expect(b.lines).toEqual(a.lines);
    expect(b.box).toEqual(a.box);
    expect(b.lines.join('')).not.toMatch(/[\u1100-\u11FF]/); // ASS 로 나가는 줄에 분해된 자모가 남지 않는다
  });

  it('제로폭 문자·제어 문자·변이 선택자는 폭에 영향을 주지 않는다', () => {
    const clean = L('가나다 라마바');
    for (const junk of ['\u200B', '\u200D', '\u2060', '\uFEFF', '\u00AD', '\uFE0F', '\u202E', '\u0007']) {
      const l = L(`가나${junk}다 라마${junk}바`);
      expect(l.lines, `U+${junk.charCodeAt(0).toString(16)}`).toEqual(clean.lines);
      expect(l.box.w).toBeCloseTo(clean.box.w, 5);
    }
  });

  it('normalizeSubtitleText: NFC 로 합치고, 줄바꿈과 일반 공백·NBSP 는 남긴다', () => {
    expect(normalizeSubtitleText('가'.normalize('NFD'))).toBe('가');
    expect(normalizeSubtitleText('cafe\u0301')).toBe('café');
    expect(normalizeSubtitleText('a\nb c\u00A0d')).toBe('a\nb c\u00A0d');
    expect(normalizeSubtitleText('a\u200Bb')).toBe('ab');
  });
});

describe('레이아웃 성능', () => {
  // 렌더 작업은 동기 계산이라 오래 걸리면 서버 전체가 멈춘다. 최악의 입력(최대 길이 200자, 붙여쓰기)도 빨라야 한다.
  it('200자 붙여쓰기·200자 일반 문장·3줄 문구가 각각 0.5초 안에 끝난다', () => {
    for (const text of ['가'.repeat(200), '안내 문구입니다 '.repeat(25).trim().slice(0, 200), 'Stock 12개 — order now: 3 boxes of milk (2%) '.repeat(5).slice(0, 200)]) {
      const t0 = performance.now();
      const l = L(text);
      const ms = performance.now() - t0;
      expect(l.lines.length).toBeGreaterThan(1);
      expect(ms, `${text.slice(0, 10)}… ${ms.toFixed(0)}ms`).toBeLessThan(500);
    }
  });

  it('글자 폭 측정은 글꼴 규칙을 따른 값이다(알려진 기준값 고정)', () => {
    // 이전 측정 방식(opentype 의 전체 shaping)으로 구한 값. 측정 방식을 바꿔도 같은 폭이어야 영상·미리보기와 어긋나지 않는다.
    expect(measurer.width('매장에 우유가 부족한지 확인하기 어려우셨나요?', 40.96)).toBeCloseTo(811.29, 1);
    expect(measurer.width('재고 화면에서 현재 수량과 부족한 품목을 확인하세요.', 40.96)).toBeCloseTo(897.3, 1);
    expect(measurer.width('Stock 12개 남음 — order now: 3 boxes of milk (2%) 확인', 40.96)).toBeCloseTo(1051.2, 1);
  });
});

describe('ASS 이스케이프', () => {
  it('중괄호와 백슬래시로 ASS 태그를 끼워 넣을 수 없다', () => {
    const out = escapeAssText('{\\an9\\p1}악성\\N 문구{x}');
    expect(out).not.toMatch(/[{}\\]/);
  });

  it('문서에는 상자 1개와 줄마다 글자가 들어가고, 입력한 중괄호는 태그로 남지 않는다', () => {
    const ass = buildAss('{\\an9}안녕 하세요', 3, measurer);
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues.filter((d) => d.includes('\\p4'))).toHaveLength(1);
    const textLines = dialogues.filter((d) => !d.includes('\\p4'));
    for (const d of textLines) {
      const afterTag = d.slice(d.indexOf('}') + 1);
      expect(afterTag).not.toMatch(/[{}\\]/);
    }
    expect(ass).toContain('Noto Sans KR SemiBold');
    expect(ass).toContain(`PlayResX: ${VIDEO.width}`);
  });
});
