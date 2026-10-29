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
  const inserted = truncateUtf16(cleaned, Math.max(0, max - prefix.length - suffix.length));
  const next = clean(prefix + inserted + suffix); // 경계에서 자모가 합쳐질 수 있어 한 번 더 정리(길이는 늘지 않는다)
  const caret = Math.min(clean(prefix + inserted).length, next.length);
  return { next, caret };
}
