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
  // 붙여 넣을 조각이 이미 정리돼 있어도 **합친 뒤**에는 달라질 수 있다(NFC 재조합으로 길이가 늘어 한도를 넘는 경우).
  // 브라우저 기본 동작으로 넣은 결과가 정리해도 그대로이고 한도 이내일 때만 개입하지 않는다.
  const native = value.slice(0, start) + pasted + value.slice(end);
  if (cleaned === pasted && native.length <= max && clean(native) === native) return null;
  const prefix = clean(value.slice(0, start));
  const suffix = clean(value.slice(end));
  // 길이는 조각의 합이 아니라 **합친 뒤의 정리 결과**로 확인한다. 경계에서 NFC 가 재조합·재정렬하면 조각의 합보다
  // 길어지거나(예: 'Ǻ' + U+0323 → 3칸) 짧아질 수 있다(예: 'ᄀ' + 'ᅡ' → 1칸). 정리 후 들어가는 가장 긴 삽입분을 찾기 위해
  // 후보 전체(자모 3개가 1글자로 합쳐지는 경우까지 고려해 max 의 4배로 상한)에서 한 칸씩 줄여 가며 확인한다.
  let budget = Math.min(cleaned.length, max * 4);
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
