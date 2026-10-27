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
  const m: Measurer = {
    width: (text, px) => font.getAdvanceWidth(text, px, { kerning: true }),
    cellHeightPerEm: (hhea.ascender - hhea.descender) / font.unitsPerEm,
  };
  cache.set(fontPath, m);
  return m;
}
