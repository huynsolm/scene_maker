import { describe, expect, it } from 'vitest';
import { cleanText, cleanTitle } from '../shared/text';
import { pasteInto } from '../web/paste';

const title = (o: { value: string; start: number; end?: number; pasted: string; max?: number }) =>
  pasteInto({ value: o.value, start: o.start, end: o.end ?? o.start, pasted: o.pasted, clean: cleanTitle, max: o.max ?? 100 });

describe('pasteInto(붙여넣기 정리)', () => {
  it('정리할 것이 없으면 개입하지 않는다(null → 브라우저 기본 동작, 되돌리기 기록 유지)', () => {
    expect(title({ value: 'abc', start: 1, pasted: 'XY' })).toBeNull();
  });

  it('한도는 삽입하는 글에만 적용한다: 꽉 찬 제목 앞에 붙여 넣어도 기존 뒷글자가 사라지지 않는다(검수 반례)', () => {
    const value = 'A'.repeat(99) + 'Z';
    const r = title({ value, start: 0, pasted: '​X' })!;
    expect(r.next).toBe(value); // 자리가 없으므로 아무것도 넣지 않는다
    expect(r.next.endsWith('Z')).toBe(true);
    expect(r.caret).toBe(0);
  });

  it('남은 자리만큼만 넣는다', () => {
    const r = title({ value: 'A'.repeat(90), start: 0, pasted: '​' + 'X'.repeat(20) })!;
    expect(r.next).toBe('X'.repeat(10) + 'A'.repeat(90));
    expect(r.caret).toBe(10);
  });

  it('선택 영역을 바꿔 넣으면 그 자리가 한도에 보태진다', () => {
    const r = title({ value: 'A'.repeat(100), start: 0, end: 50, pasted: '​' + 'X'.repeat(60) })!;
    expect(r.next).toBe('X'.repeat(50) + 'A'.repeat(50));
    expect(r.caret).toBe(50);
  });

  it('기존 앞부분이 정리되어도 커서는 삽입 끝에 놓인다(검수 반례: 원문 인덱스를 쓰면 B 뒤로 밀렸다)', () => {
    const r = title({ value: '​ABC', start: 2, pasted: '​X' })!; // 원문에서 A 바로 뒤
    expect(r.next).toBe('AXBC');
    expect(r.caret).toBe(2);
    expect(r.next.slice(0, r.caret)).toBe('AX');
  });

  it('한도 경계에서 이모지(서로게이트 쌍)를 쪼개지 않는다', () => {
    const r = pasteInto({ value: 'a'.repeat(199), start: 199, end: 199, pasted: '​😀', clean: cleanText, max: 200 })!;
    expect(r.next).toBe('a'.repeat(199));
    expect(r.next.isWellFormed()).toBe(true);
    // 두 칸이 남으면 이모지가 통째로 들어간다
    const ok = pasteInto({ value: 'a'.repeat(198), start: 198, end: 198, pasted: '​😀', clean: cleanText, max: 200 })!;
    expect(ok.next).toBe('a'.repeat(198) + '😀');
  });

  it('경계에서 자모가 합쳐져도 한도 이내이고 커서가 값 안에 있다', () => {
    const r = pasteInto({ value: 'ᄀ', start: 1, end: 1, pasted: '​ᅡ', clean: cleanText, max: 10 })!;
    expect(r.next).toBe('가');
    expect(r.caret).toBeLessThanOrEqual(r.next.length);
  });

  it('분해된 한글(NFD)을 붙이면 NFC 로 합쳐져 들어간다', () => {
    const r = pasteInto({ value: '', start: 0, end: 0, pasted: '매장'.normalize('NFD'), clean: cleanText, max: 200 })!;
    expect(r.next).toBe('매장');
    expect(r.caret).toBe(2);
  });
  it('경계에서 NFC 재조합이 길이를 늘려도 한도를 넘지 않고 기존 글을 보존한다(검수 반례)', () => {
    const value = 'A'.repeat(98) + 'Ǻ'; // 99칸
    const r = pasteInto({ value, start: 99, end: 99, pasted: '​̣', clean: cleanTitle, max: 100 })!;
    expect(r.next.length).toBeLessThanOrEqual(100);
    expect(r.next).toBe(value); // 들어갈 수 있는 삽입분이 없으면 기존 값 그대로
    expect(r.caret).toBe(99);
    // 문구 200칸 경계에서도 같다
    const text = 'A'.repeat(198) + 'Ǻ';
    const t = pasteInto({ value: text, start: 199, end: 199, pasted: '​̣', clean: cleanText, max: 200 })!;
    expect(t.next.length).toBeLessThanOrEqual(200);
    expect(t.next.startsWith('A'.repeat(198))).toBe(true);
  });

  it('재조합으로 늘어나는 만큼 삽입분을 줄여 맞춘다', () => {
    const value = 'A'.repeat(97) + 'Ǻ'; // 98칸, 두 칸 남음
    const r = pasteInto({ value, start: 98, end: 98, pasted: '​̣x', clean: cleanTitle, max: 100 })!;
    expect(r.next.length).toBeLessThanOrEqual(100);
    expect(r.next.startsWith('A'.repeat(97))).toBe(true);
    expect(r.caret).toBeLessThanOrEqual(r.next.length);
  });
  it('무작위 값·선택·붙여넣기에서도 결과는 항상 한도 이내다(결합 문자·자모·보이지 않는 문자 섞음)', () => {
    const alpha = ['A', 'Ǻ', '̣', '̊', '́', 'ᄀ', 'ᅡ', 'ᆨ', '​', '가', '😀', 'x'];
    let seed = 12345;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const gen = (len: number) => Array.from({ length: len }, () => alpha[rnd(alpha.length)]).join('');
    for (let i = 0; i < 20000; i++) {
      const max = 4 + rnd(8);
      let value = cleanTitle(gen(rnd(max + 1)));
      if (value.length > max) value = value.slice(0, max);
      const a = rnd(value.length + 1);
      const b = a + rnd(value.length - a + 1);
      const r = pasteInto({ value, start: a, end: b, pasted: gen(1 + rnd(6)), clean: cleanTitle, max });
      if (!r) continue;
      expect(r.next.length).toBeLessThanOrEqual(Math.max(max, value.length));
      expect(r.caret).toBeLessThanOrEqual(r.next.length);
      expect(cleanTitle(r.next)).toBe(r.next);
    }
  });
  it('붙여넣을 조각이 이미 정리돼 있어도 합친 뒤 한도를 넘으면 개입한다(검수 반례: 제로폭 문자 없이 U+0323 만)', () => {
    const value = 'A'.repeat(98) + 'Ǻ';
    const r = pasteInto({ value, start: 99, end: 99, pasted: '̣', clean: cleanTitle, max: 100 });
    expect(r).not.toBeNull();
    expect(r!.next.length).toBeLessThanOrEqual(100);
    expect(r!.next).toBe(value);
  });

  it('정리할 것도 없고 합쳐도 그대로이며 한도 이내면 브라우저 기본 동작에 맡긴다', () => {
    expect(pasteInto({ value: 'abc', start: 1, end: 1, pasted: 'XY', clean: cleanTitle, max: 100 })).toBeNull();
  });

  it('정리 후 들어가는 가장 긴 삽입분을 넣는다(검수 반례: 자모 합쳐짐, 이모지)', () => {
    const a = pasteInto({ value: 'ᄀ', start: 1, end: 1, pasted: '​ᅡX', clean: cleanText, max: 2 })!;
    expect(a.next).toBe('가X');
    const b = pasteInto({ value: 'ᄀ', start: 1, end: 1, pasted: '​ᅡ😀', clean: cleanText, max: 3 })!;
    expect(b.next).toBe('가😀');
  });
});
