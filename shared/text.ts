/**
 * 사용자가 입력한 문구·제목의 정리 규칙. 서버(저장 스키마, 영상 레이아웃)와 화면(붙여넣기)이 같은 함수를 쓴다.
 *
 * 정리하지 않으면 생기는 일
 *  - 분해된 한글 자모(NFD): 글꼴이 합쳐 그리지만 글자별 폭 합산은 그 규칙을 몰라 폭이 2배 이상으로 계산되고, 글자 수 한도도 일찍 찬다.
 *  - 제로폭 문자·제어 문자: 화면에 보이지 않는데 DB 에 남고, 글자 수 한도를 차지하고, 폭 측정이 `.notdef` 폭을 센다.
 * 저장·미리보기·영상이 같은 글자를 보도록 저장 경계에서 한 번 정리하고, 영상 파이프라인에서도 한 번 더 적용한다(이전에 저장된 값 방어).
 */

// 그려지지 않는 문자들: 소프트 하이픈, 제로폭 공백·접합자·방향 표시(U+200B–200F), 방향 제어(U+202A–202E, U+2066–2069),
// 단어 결합자 등(U+2060–2064), 변이 선택자(U+FE00–FE0F), BOM(U+FEFF). 그리고 줄바꿈(\n)·탭을 뺀 제어 문자.
// 브라우저와 libass 는 모두 폭 0 으로 다루므로 제거해도 화면은 같다.
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤⁦-⁩︀-️﻿]/g;

/** 문구: NFC, 줄바꿈은 \n 으로 통일, 보이지 않는 문자·제어 문자 제거(\n 과 탭은 유지) */
export function cleanText(text: string): string {
  return text.normalize('NFC').replace(/\r\n?/g, '\n').replace(INVISIBLE_OR_CONTROL, '');
}

/** 제목: 한 줄이다. 줄바꿈과 탭은 공백으로 바꾼다. */
export function cleanTitle(title: string): string {
  return cleanText(title).replace(/[\n\t]+/g, ' ');
}
