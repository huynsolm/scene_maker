import { describe, expect, it } from 'vitest';
import { cleanText, cleanTitle, truncateUtf16 } from '../shared/text';

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
