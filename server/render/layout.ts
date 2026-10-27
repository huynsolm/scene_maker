import { SUBTITLE, VIDEO } from '../../shared/limits';
import type { Measurer } from './font';

export interface SubtitleLayout {
  lines: string[];
  /** CSS 의 font-size 에 해당하는 em 크기(px) */
  emPx: number;
  lineHeightPx: number;
  /** 자막 배경 상자. 프레임 좌표(px) */
  box: { x: number; y: number; w: number; h: number; r: number };
  /** 줄별 가운데 좌표 */
  centerX: number;
  lineCenterY: number[];
}

const pct = (v: number, of: number) => (of * v) / 100;

// 글자가 그려지지 않는데도 폭 측정이 `.notdef` 폭을 세던 문자들(제로폭 공백·접합자, 방향 제어, 변이 선택자, BOM, 소프트 하이픈)과 제어 문자.
// 브라우저·libass 는 이 문자들을 폭 0 으로 다루므로 제거해도 화면은 같다. 줄바꿈(\n)과 탭은 남긴다(탭은 레이아웃이 공백으로 줄인다).
// eslint-disable-next-line no-control-regex
const INVISIBLE_OR_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/g;

/**
 * 영상 파이프라인(폭 측정·줄바꿈·ASS)에 넣기 전의 문구 정리.
 *  - NFC 로 합친다: macOS 등에서 붙여 넣은 분해된 한글 자모(NFD)는 글꼴이 GSUB 로 합쳐 그리지만 서버의 글자별 폭 합산은
 *    그 규칙을 적용하지 않아 폭이 2배 이상으로 계산됐다(브라우저와 비교해 +980px).
 *  - 보이지 않는 문자와 제어 문자를 제거한다.
 * 폭 측정이 브라우저(HarfBuzz)와 맞는 범위는 이 정리를 거친 NFC 한글·라틴·숫자·문장부호이며, 옛한글 자모 조합·이모지·전각 문자·
 * 라틴 합자(fi, fl 등)는 맞지 않을 수 있다(docs/stage3-review.md, e2e/measure-parity.e2e.ts).
 */
export function normalizeSubtitleText(text: string): string {
  return text.normalize('NFC').replace(INVISIBLE_OR_CONTROL, '');
}

/** 공백 기준으로 가능한 한 채워 넣는 줄바꿈. 한 단어가 너무 길면 글자 단위로 자른다. */
function greedy(words: string[], maxW: number, width: (s: string) => number): string[] {
  const lines: string[] = [];
  let cur = '';
  const push = () => {
    if (cur) lines.push(cur);
    cur = '';
  };
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (width(candidate) <= maxW) {
      cur = candidate;
      continue;
    }
    push();
    if (width(word) <= maxW) {
      cur = word;
      continue;
    }
    // 단어 하나가 한 줄보다 길다: 글자 단위로 나눈다
    for (const ch of Array.from(word)) {
      if (cur && width(cur + ch) > maxW) push();
      cur += ch;
    }
  }
  push();
  return lines;
}

/**
 * 문단 하나를 CSS `text-wrap: balance` 처럼 줄 수는 그대로 두고 줄 길이를 고르게 나눈다.
 * (줄 수가 가장 적은 상태에서, 가장 좁은 폭을 이분 탐색으로 찾는다.)
 */
function wrapBalanced(paragraph: string, maxW: number, width: (s: string) => number): string[] {
  const words = paragraph.split(' ').filter(Boolean);
  if (words.length === 0) return [''];
  const base = greedy(words, maxW, width);
  if (base.length <= 1) return base;
  let lo = Math.max(...words.map((w) => Math.min(width(w), maxW)));
  let hi = maxW;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (greedy(words, mid, width).length === base.length) hi = mid;
    else lo = mid;
  }
  return greedy(words, hi, width);
}

export function layoutSubtitle(text: string, measurer: Measurer): SubtitleLayout {
  const { width: W, height: H } = VIDEO;
  const emPx = pct(SUBTITLE.fontSizeWidthPct, W);
  const lineHeightPx = emPx * SUBTITLE.lineHeight;
  const padX = pct(SUBTITLE.padXWidthPct, W);
  const padY = pct(SUBTITLE.padYWidthPct, W);
  const maxBoxW = W - 2 * pct(SUBTITLE.sideMarginPct, W);
  const maxTextW = maxBoxW - 2 * padX;
  const w = (s: string) => measurer.width(s, emPx);

  // 미리보기(CSS white-space: pre-line)와 같이 사용자가 넣은 줄바꿈은 지키고, 공백은 하나로 줄인다.
  const paragraphs = normalizeSubtitleText(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((p) => p.replace(/[ \t]+/g, ' ').trim());
  const lines = paragraphs.flatMap((p) => wrapBalanced(p, maxTextW, w));

  // 상자 폭은 미리보기(CSS)와 같은 규칙을 따른다: 글자가 한 줄에 다 들어가면 가장 긴 줄에 맞추고,
  // 폭이 모자라 줄바꿈이 생기면 `text-wrap: balance` 로 글자 줄이 고르게 나뉘어도 상자는 최대 폭을 유지한다.
  const contentW = Math.max(...paragraphs.map((p) => w(p)));
  const textW = Math.max(...lines.map((l) => w(l)));
  const boxW = contentW > maxTextW ? maxBoxW : Math.min(maxBoxW, textW + 2 * padX);
  const boxH = lines.length * lineHeightPx + 2 * padY;
  const boxBottom = H - pct(SUBTITLE.bottomMarginPct, H);
  const boxY = boxBottom - boxH;
  return {
    lines,
    emPx,
    lineHeightPx,
    box: { x: (W - boxW) / 2, y: boxY, w: boxW, h: boxH, r: pct(SUBTITLE.radiusWidthPct, W) },
    centerX: W / 2,
    lineCenterY: lines.map((_, i) => boxY + padY + (i + 0.5) * lineHeightPx),
  };
}
