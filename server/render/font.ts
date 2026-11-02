import fs from 'node:fs';
import opentype from 'opentype.js';

/** 글자 폭을 재는 도구. 줄바꿈과 자막 박스 크기를 서버가 직접 계산하기 위해 쓴다. */
export interface Measurer {
  /** `px` 크기(em)로 그릴 때의 글자 폭 */
  width(text: string, px: number): number;
  /** (ascent + descent) / em. libass 의 Fontsize 는 이 칸 높이 기준이라 CSS font-size 에 이 값을 곱해야 같은 글자 크기가 된다 */
  cellHeightPerEm: number;
}

const cache = new Map<string, Measurer>();

export function loadMeasurer(fontPath: string): Measurer {
  const hit = cache.get(fontPath);
  if (hit) return hit;
  const buf = fs.readFileSync(fontPath);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const hhea = font.tables.hhea as unknown as { ascender: number; descender: number };
  // font.getAdvanceWidth 는 호출마다 대형 CJK 글꼴(글리프 약 2만 5천 개)의 치환 규칙을 처음부터 다시 적용해
  // 한 번에 수 ms 가 걸린다(200자 문구 레이아웃이 3초, 붙여쓰기 200자는 12초 동안 서버를 멈췄다).
  // 글자별 advance 와 글자쌍 조정(kerning)을 직접 합산하면 같은 폭(샘플 문구·영문 혼합·글자쌍 조정 문구에서 차이 0.00px)을
  // 수십 배 빠르게 얻는다. 글자쌍 조정값은 쌍마다 한 번만 계산해 둔다.
  const kern = new Map<number, number>();
  const kernOf = (l: opentype.Glyph, r: opentype.Glyph) => {
    const key = l.index * 65536 + r.index;
    let v = kern.get(key);
    if (v === undefined) {
      v = font.getKerningValue(l, r);
      kern.set(key, v);
    }
    return v;
  };
  const m: Measurer = {
    width: (text, px) => {
      let units = 0;
      let prev: opentype.Glyph | null = null;
      for (const ch of text) {
        const g = font.charToGlyph(ch);
        units += g.advanceWidth ?? 0;
        if (prev) units += kernOf(prev, g);
        prev = g;
      }
      return (units * px) / font.unitsPerEm;
    },
    cellHeightPerEm: (hhea.ascender - hhea.descender) / font.unitsPerEm,
  };
  cache.set(fontPath, m);
  return m;
}
