import { VIDEO } from '../../shared/limits';
import type { Measurer } from './font';
import { layoutSubtitle } from './layout';

/**
 * 한 장면의 자막을 ASS(libass) 문서로 만든다.
 *
 * libass 의 자체 줄바꿈과 줄별 상자는 미리보기(박스 하나, 균형 잡힌 줄바꿈)와 달라서 쓰지 않는다.
 * 대신 layout.ts 가 줄바꿈과 상자 크기를 계산하고, 여기서는
 *   - 레이어 0: 둥근 사각형(상자) 하나
 *   - 레이어 1: 줄마다 가운데 정렬로 지정 좌표에 글자
 * 를 그린다. 그래도 브라우저와 libass 의 글자 렌더링은 완전히 같지 않으며, 차이는 scripts/compare-frame.ts 로 측정한다.
 */

export const FONT_FAMILY = 'Noto Sans KR SemiBold';

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();
/** ASS 색상은 &HAABBGGRR, 알파 00 = 불투명 */
const assColor = (r: number, g: number, b: number, opacity = 1) => `&H${hex2(255 * (1 - opacity))}${hex2(b)}${hex2(g)}${hex2(r)}`;

/** ASS 본문에서 의미가 있는 문자를 막는다. (줄바꿈은 layout 이 이미 나눴다) */
export function escapeAssText(line: string): string {
  return line.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝');
}

const assTime = (sec: number) => {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/** 둥근 사각형 ASS 도형(\p4: 좌표를 8 로 나눠 쓰므로 8 배 해서 넣는다) */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = 0.5523 * r;
  const x2 = x + w;
  const y2 = y + h;
  const p = (a: number, b: number) => `${Math.round(a * 8)} ${Math.round(b * 8)}`;
  return [
    `m ${p(x + r, y)}`,
    `l ${p(x2 - r, y)}`,
    `b ${p(x2 - r + k, y)} ${p(x2, y + r - k)} ${p(x2, y + r)}`,
    `l ${p(x2, y2 - r)}`,
    `b ${p(x2, y2 - r + k)} ${p(x2 - r + k, y2)} ${p(x2 - r, y2)}`,
    `l ${p(x + r, y2)}`,
    `b ${p(x + r - k, y2)} ${p(x, y2 - r + k)} ${p(x, y2 - r)}`,
    `l ${p(x, y + r)}`,
    `b ${p(x, y + r - k)} ${p(x + r - k, y)} ${p(x + r, y)}`,
  ].join(' ');
}

export function buildAss(text: string, durationSec: number, measurer: Measurer): string {
  const L = layoutSubtitle(text, measurer);
  const assFontSize = L.emPx * measurer.cellHeightPerEm;
  const end = assTime(durationSec + 1);
  const box = assColor(18, 19, 24, 0.74);
  const boxAlpha = box.slice(2, 4); // 앞 두 자리가 알파
  const events = [
    `Dialogue: 0,${assTime(0)},${end},Sub,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H${box.slice(4)}&\\1a&H${boxAlpha}&\\p4}${roundedRect(L.box.x, L.box.y, L.box.w, L.box.h, L.box.r)}`,
    ...L.lines.map(
      (line, i) =>
        `Dialogue: 1,${assTime(0)},${end},Sub,,0,0,0,,{\\an5\\pos(${L.centerX.toFixed(2)},${L.lineCenterY[i]!.toFixed(2)})}${escapeAssText(line)}`,
    ),
  ];
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${VIDEO.width}`,
    `PlayResY: ${VIDEO.height}`,
    'WrapStyle: 2', // 자동 줄바꿈 끔(줄바꿈은 layout 이 결정)
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Sub,${FONT_FAMILY},${assFontSize.toFixed(2)},${assColor(255, 255, 255)},${assColor(255, 255, 255)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}


