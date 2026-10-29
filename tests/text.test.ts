import { describe, expect, it } from 'vitest';
import { cleanText, cleanTitle, fitCleaned, truncateUtf16 } from '../shared/text';

describe('cleanText (저장 경계·붙여넣기·영상 파이프라인이 함께 쓰는 정리)', () => {
  it('NFC 로 합친다', () => {
    expect(cleanText('매장'.normalize('NFD'))).toBe('매장');
    expect(cleanText('café')).toBe('café');
  });

  it('보이지 않는 문자를 제거한다(제로폭 공백·접합자·방향 표시·변이 선택자·BOM·소프트 하이픈)', () => {
    for (const junk of ['​', '‌', '‍', '‎', '‏', '⁠', '‮', '⁦', '️', '﻿', '­']) {
      expect(cleanText(`가${junk}나다`), `U+${junk.charCodeAt(0).toString(16)}`).toBe('가나다');
    }
  });

  it('제어 문자는 제거하고 줄바꿈(\\n)과 탭은 남기며, CRLF·CR 은 \\n 으로 통일한다', () => {
    expect(cleanText('가\u0000\u0007나')).toBe('가나');
    expect(cleanText('가\n나\t다')).toBe('가\n나\t다');
    expect(cleanText('가\r\n나\r다')).toBe('가\n나\n다');
  });

  it('보이는 문자(공백·NBSP·이모지·한자)는 건드리지 않는다', () => {
    const s = '가 나 다 😀 漢字';
    expect(cleanText(s)).toBe(s);
  });

  it('여러 번 적용해도 같다(멱등)', () => {
    const once = cleanText('매​장'.normalize('NFD') + '\r\n끝﻿');
    expect(cleanText(once)).toBe(once);
  });
});

describe('cleanTitle', () => {
  it('한 줄로 만든다: 줄바꿈·탭은 공백, 보이지 않는 문자는 제거', () => {
    expect(cleanTitle('매장\n재고\t관리​'.normalize('NFD'))).toBe('매장 재고 관리');
  });
});

describe('truncateUtf16', () => {
  it('한도 이하면 그대로, 넘으면 한도에서 자른다', () => {
    expect(truncateUtf16('abc', 5)).toBe('abc');
    expect(truncateUtf16('abcdef', 4)).toBe('abcd');
  });

  it('이모지(서로게이트 쌍)의 가운데에서 자르지 않는다 — 깨진 문자열(isWellFormed 거짓)을 만들지 않는다', () => {
    const s = 'a'.repeat(199) + '😀'; // UTF-16 길이 201, 200 번째 칸이 이모지의 앞 절반
    const cut = truncateUtf16(s, 200);
    expect(cut).toBe('a'.repeat(199));
    expect(cut.isWellFormed()).toBe(true);
    // 경계가 이모지 뒤라면 이모지를 유지한다
    const keep = truncateUtf16('a'.repeat(198) + '😀' + 'b', 200);
    expect(keep).toBe('a'.repeat(198) + '😀');
    expect(keep.isWellFormed()).toBe(true);
  });
});

describe('멱등성: cleanText(cleanText(x)) === cleanText(x), 결과는 항상 NFC', () => {
  it('보이지 않는 문자로 떨어져 있던 한글 자모는 제거한 뒤에 합쳐진다(검수 반례)', () => {
    const x = '\u1100\u200B\u1161';
    expect(cleanText(x)).toBe('가'); // 첫 호출에서 이미 합쳐진다(1칸)
    expect(cleanText(cleanText(x))).toBe(cleanText(x));
    expect(cleanText('\u1100\u200B\u1161\u200B\u11A8')).toBe('각');
    expect(cleanText('e\u200B\u0301')).toBe('é'); // 라틴 결합 문자도 같다
    expect(cleanTitle('\u1100\u200B\u1161')).toBe('가');
  });

  it('이런 입력 200개는 정리 후 200자이므로 길이 한도를 넘지 않는다', () => {
    const text = '\u1100\u200B\u1161'.repeat(200);
    expect(cleanText(text)).toBe('가'.repeat(200));
    expect(cleanText(text).length).toBe(200);
  });

  it('무작위 조합 3만 개(고정 시드)에서도 멱등이고 항상 NFC 이며 제거 대상이 남지 않는다', () => {
    const alphabet = ['\u1100', '\u1161', '\u11A8', '가', '각', 'a', 'e', '\u0301', '\u0308', '\u200B', '\u200D', '\uFEFF', '\u00AD', '\uFE0F', '\r', '\n', '\t', ' ', '\u0007', '😀', '한', '\u1112', '\u1161', '\u11AB', '\u202E', '\u2060'];
    let seed = 20261029;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 30000; i++) {
      const len = Math.floor(rnd() * 13);
      let x = '';
      for (let k = 0; k < len; k++) x += alphabet[Math.floor(rnd() * alphabet.length)]!;
      const a = cleanText(x);
      expect(cleanText(a), JSON.stringify(x)).toBe(a);
      expect(a, JSON.stringify(x)).toBe(a.normalize('NFC'));
      expect(a, JSON.stringify(x)).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/);
      const t = cleanTitle(x);
      expect(cleanTitle(t), JSON.stringify(x)).toBe(t);
    }
  });
});

describe('fitCleaned (저장 전송 직전 정리 후 길이 맞춤)', () => {
  it('정리하면 한도를 넘는 값(검수 반례)을 한도 이내로 줄이고 결과는 정리된 값이다', () => {
    const raw = 'A'.repeat(98) + 'Ǻ' + '̣'; // 원문 100칸, NFC 101칸
    expect(raw.length).toBe(100);
    const out = fitCleaned(raw, cleanTitle, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(cleanTitle(out)).toBe(out);
    expect(out.startsWith('A'.repeat(98))).toBe(true);
  });
  it('한도 이내면 정리만 한다', () => {
    expect(fitCleaned('가​나', cleanText, 200)).toBe('가나');
  });
  it('이모지를 쪼개지 않는다', () => {
    const out = fitCleaned('a'.repeat(199) + '😀', cleanText, 200);
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
