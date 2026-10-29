import { truncateUtf16 } from '../shared/text';

export interface PasteResult {
  /** 붙여 넣은 뒤의 전체 값(정리됨, 한도 이내) */
  next: string;
  /** 붙여 넣은 글 바로 뒤의 커서 위치 */
  caret: number;
}

/**
 * 붙여 넣는 글을 저장 때와 같은 규칙으로 정리해 입력칸의 값에 끼워 넣는다. 정리할 것이 없으면 null(브라우저 기본 동작에 맡김).
 *
 *  - 한도(`max`)는 **삽입하는 글에만** 적용한다. 선택 영역 밖의 기존 글(앞·뒤)은 지우지 않는다. 남은 자리가 모자라면 삽입 글을
 *    그만큼만 넣고(서로게이트 쌍은 쪼개지 않음) 자리가 없으면 아무것도 넣지 않는다. 브라우저의 `maxLength` 기본 동작과 같다.
 *  - 커서는 정리·합쳐진 값 기준의 삽입 끝 위치다. 기존 앞부분이 정리되면 원문 인덱스와 달라지므로 원문 `start` 를 쓰지 않는다.
 */
export function pasteInto(opts: {
  value: string;
  start: number;
  end: number;
  pasted: string;
  clean: (s: string) => string;
  max: number;
}): PasteResult | null {
  const { value, start, end, pasted, clean, max } = opts;
  const cleaned = clean(pasted);
  if (cleaned === pasted) return null;
  const prefix = clean(value.slice(0, start));
  const suffix = clean(value.slice(end));
  // 길이 계산은 정리 전 조각의 합이 아니라 **합친 뒤의 정리 결과**로 확인한다. 경계에서 NFC 가 재조합·재정렬하면
  // 합친 결과가 조각의 합보다 길어질 수 있다(예: 'Ǻ' + U+0323 → 3칸). 넘치면 삽입분을 한 칸씩 줄여 다시 계산한다.
  let budget = Math.max(0, max - prefix.length - suffix.length);
  for (;;) {
    const inserted = truncateUtf16(cleaned, budget);
    const next = clean(prefix + inserted + suffix);
    if (next.length <= max) {
      const caret = Math.min(clean(prefix + inserted).length, next.length);
      return { next, caret };
    }
    if (budget === 0) break;
    budget -= 1;
  }
  // 삽입분이 없어도 앞·뒤가 맞붙으며 한도를 넘는 경우: 기존 값을 그대로 둔다.
  return { next: value, caret: Math.min(start, value.length) };
}
