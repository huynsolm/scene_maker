/**
 * 사용자가 입력한 문구·제목의 정리 규칙. 서버(저장 스키마, 영상 레이아웃)와 화면(붙여넣기)이 같은 함수를 쓴다.
 *
 * 정리하지 않으면 생기는 일
 *  - 분해된 한글 자모(NFD): 글꼴이 합쳐 그리지만 글자별 폭 합산은 그 규칙을 몰라 폭이 2배 이상으로 계산되고, 글자 수 한도도 일찍 찬다.
 *  - 제로폭 문자·제어 문자: 화면에 보이지 않는데 DB 에 남고, 글자 수 한도를 차지하고, 폭 측정이 `.notdef` 폭을 센다.
 * 저장·미리보기·영상이 같은 글자를 보도록 저장 경계에서 한 번 정리하고, 영상 파이프라인에서도 한 번 더 적용한다(이전에 저장된 값 방어).
 */

// 제거하는 문자들: 제로폭 공백·접합자·방향 표시(U+200B–200F), 방향 제어(U+202A–202E, U+2066–2069), 단어 결합자 등(U+2060–2064),
// 변이 선택자(U+FE00–FE0F), BOM(U+FEFF), 그리고 줄바꿈(\n)·탭을 뺀 제어 문자. 이 문자들은 브라우저와 libass 모두 폭 0 으로 다루므로
// 제거해도 화면은 같다.
// 예외: 소프트 하이픈(U+00AD)은 줄바꿈 지점에서 하이픈으로 보일 수 있다(라틴 단어를 나눌 때). 한글 중심의 자막에서는
// 이 동작을 지원하지 않기로 하고 **의도적으로 폐기**한다(폭을 재는 쪽과 줄바꿈이 맞지 않아 어긋나기 때문).
// 이모지·복합 문자 체계의 ZWJ(U+200D)·VS16(U+FE0F)도 같은 이유로 지원 범위 밖이다.
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩︀-️﻿]/g;

/**
 * 문구: 줄바꿈은 \n 으로 통일, 보이지 않는 문자·제어 문자 제거(\n 과 탭은 유지), **마지막에** NFC.
 * 순서가 중요하다. 보이지 않는 문자가 사이에 끼어 있던 자모(`\u1100\u200B\u1161`)는 제거한 뒤에야 서로 붙으므로,
 * NFC 를 먼저 하면 한 번 더 정리해야 합쳐진다(반환값이 NFC 가 아니고 정리가 멱등이 아니게 됨).
 * 마지막에 NFC 를 하면 반환값이 항상 NFC 이므로 `cleanText(cleanText(x)) === cleanText(x)` 이다.
 */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(INVISIBLE_OR_CONTROL, '').normalize('NFC');
}

/** 제목: 한 줄이다. 줄바꿈과 탭은 공백으로 바꾼다. */
export function cleanTitle(title: string): string {
  return cleanText(title).replace(/[\n\t]+/g, ' ');
}

/**
 * UTF-16 길이 `max` 이하로 자른다. 잘리는 자리가 서로게이트 쌍(이모지 등)의 가운데면 앞 한 칸을 더 줄여
 * 깨진 문자열(isWellFormed() === false)이 되지 않게 한다.
 */
export function truncateUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // 상위 서로게이트만 남는 경우
  return text.slice(0, end);
}

/**
 * 정리한 뒤 길이가 `max` 이내가 되도록 끝을 잘라 돌려준다(항상 정리된 값, 서로게이트 쌍은 쪼개지 않음).
 * 서버 스키마는 정리 후 길이를 검사하므로, 화면의 원문이 `maxLength` 안이어도 정리하면(NFC 재조합 등) 한도를 넘는 값은
 * 저장이 거절된다. 저장을 보내기 전에 이 함수로 맞춘다.
 */
export function fitCleaned(text: string, clean: (s: string) => string, max: number): string {
  let out = clean(text);
  while (out.length > max) out = clean(truncateUtf16(out, Math.min(max, out.length - 1)));
  return out;
}
