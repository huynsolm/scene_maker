import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { loadMeasurer } from '../server/render/font';
import { normalizeSubtitleText } from '../server/render/layout';

/**
 * 서버의 글자 폭 측정(글자별 advance + 글자쌍 조정)이 브라우저(HarfBuzz — libass 와 같은 shaping 엔진)와 맞는 범위를 고정한다.
 * 측정이 맞는 범위와 맞지 않는 범위를 입력 종류별로 나눠 둔다. (docs/stage3-review.md 의 표와 같은 내용)
 */
const FONT = path.resolve('fonts/NotoSansKR-SemiBold.ttf');
const PX = 40.96;
const ko = '매장에 우유가 부족한지 확인하기 어려우셨나요?';
const ko2 = '재고 화면에서 현재 수량과 부족한 품목을 확인하세요.';

/** 서버가 정리(NFC·보이지 않는 문자 제거)한 뒤 재는 값이 브라우저와 1px 안에서 맞아야 하는 입력 */
const SUPPORTED: Array<[string, string]> = [
  ['한글 NFC 문장', ko],
  ['한글 NFC 긴 문장', ko2],
  ['한글 NFD(분해된 자모) — 정리로 해결', ko.normalize('NFD')],
  ['한글 NFD 긴 문장 — 정리로 해결', ko2.normalize('NFD')],
  ['라틴 문장', 'The quick brown fox jumps over the lazy dog.'],
  ['글자쌍 조정 후보', 'AV To Yo WA LT P. T, V. Y;'],
  ['숫자·문장부호', '2026-10-27 15:30 (A/S) 1,000원 ₩ 100% “따옴표” — … ~'],
  ['결합 문자 e+◌́(NFD) — 정리로 해결', 'café résumé'],
  ['NBSP', 'ab cd'],
  ['제로폭 공백 — 정리로 해결', 'ab​cd'],
  ['제로폭 접합 — 정리로 해결', 'ab‍cd'],
  ['변이 선택자 — 정리로 해결', 'ab️cd'],
];

/** 알려진 한계: 어긋나는 크기가 아래 상한을 넘지 않는지만 지킨다(더 나빠지면 알아챈다) */
const KNOWN_LIMITS: Array<[string, string, number]> = [
  ['라틴 합자 후보(fi fl ffi ffl)', 'office first fi fl ffi ffl final flow affirm', 5],
  ['전각 문자', 'ＡＢＣ １２３，．！？', 25],
];

/** 측정 보장 밖: 값만 출력하고 검사하지 않는다(글꼴에 없는 문자는 대체 글꼴이 그려 폭을 알 수 없다) */
const UNSUPPORTED: Array<[string, string]> = [
  ['옛한글 자모 조합', 'ᄀᆞᆯ ᄒᆞᆫ ᅀᅡ'],
  ['이모지', '재고 😀 확인'],
];

describe('글자 폭 측정 ↔ 브라우저(HarfBuzz) 대조', () => {
  it('정리 후 폭이 보장 범위에서 1px 안으로 맞고, 알려진 한계는 상한 안이다', async () => {
    const m = loadMeasurer(FONT);
    // 글자 힌팅이 켜진 브라우저는 글자 폭을 정수 픽셀로 반올림하므로 고정한다(docs/frame-comparison.md)
    const browser = await chromium.launch({ args: ['--font-render-hinting=none'] });
    const page = await browser.newPage();
    await page.route('http://x.test/__f.ttf', (r) => r.fulfill({ path: FONT, contentType: 'font/ttf' }));
    await page.goto('about:blank');
    await page.setContent('<canvas id="c"></canvas>');
    await page.evaluate(async () => {
      const f = await new FontFace('M', 'url(http://x.test/__f.ttf)').load();
      document.fonts.add(f);
    });
    const real = (text: string) =>
      page.evaluate(([t, px]) => {
        const ctx = (document.getElementById('c') as HTMLCanvasElement).getContext('2d')!;
        ctx.font = `${px}px M`;
        return ctx.measureText(t as string).width;
      }, [text, PX] as const);
    const mine = (text: string) => m.width(normalizeSubtitleText(text), PX);

    const table: string[] = [];
    const fails: string[] = [];
    for (const [label, text] of SUPPORTED) {
      const d = mine(text) - (await real(text));
      table.push(`보장   ${label.padEnd(34)} Δ ${d.toFixed(2)}px`);
      if (Math.abs(d) > 1) fails.push(`${label}: Δ ${d.toFixed(2)}px (허용 1px)`);
    }
    for (const [label, text, limit] of KNOWN_LIMITS) {
      const d = mine(text) - (await real(text));
      table.push(`한계   ${label.padEnd(34)} Δ ${d.toFixed(2)}px (상한 ${limit}px)`);
      if (Math.abs(d) > limit) fails.push(`${label}: Δ ${d.toFixed(2)}px (상한 ${limit}px)`);
    }
    for (const [label, text] of UNSUPPORTED) {
      const d = mine(text) - (await real(text));
      table.push(`미보장 ${label.padEnd(34)} Δ ${d.toFixed(2)}px (검사 안 함)`);
    }
    await browser.close();
    console.log('\n' + table.join('\n'));
    expect(fails, fails.join('\n')).toEqual([]);
  }, 60_000);
});
