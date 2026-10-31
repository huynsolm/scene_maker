import { execFileSync } from 'node:child_process';
import { VIDEO } from '../shared/limits';

/** 1280x720 RGB 프레임 한 장. 영상과 화면 캡처를 같은 방식으로 분석하려고 둘 다 이 형태로 읽는다. */
export type Rgb = Buffer;

const RAW = ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
const OPTS = { maxBuffer: 32 * 1024 * 1024 };

export const frameFromVideo = (file: string, t: number): Rgb =>
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', ...RAW], OPTS);

export const frameFromImage = (file: string): Rgb => {
  const f = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', ...RAW], OPTS);
  if (f.length !== VIDEO.width * VIDEO.height * 3) {
    throw new Error(`${file}: 크기가 ${VIDEO.width}x${VIDEO.height} 가 아니에요 (바이트 ${f.length})`);
  }
  return f;
};

export const px = (f: Rgb, x: number, y: number) => {
  const i = (y * VIDEO.width + x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!] as const;
};
export const near = (a: readonly number[], b: readonly number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 배경색(왼쪽 위 모서리)과 달라진 픽셀의 경계 상자 = 자막 상자. 화면 아래쪽 절반만 본다. */
export function boxBounds(f: Rgb, tol = 14): Box {
  const bg = px(f, 4, 4);
  let x1: number = VIDEO.width, y1: number = VIDEO.height, x2 = -1, y2 = -1;
  for (let y = VIDEO.height / 2; y < VIDEO.height; y++) {
    for (let x = 0; x < VIDEO.width; x++) {
      if (!near(px(f, x, y), bg, tol)) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

const isInk = (p: readonly number[]) => p[0]! > 200 && p[1]! > 200 && p[2]! > 200;

/** 상자 안의 흰 글자 픽셀 경계 상자와, 행 투영으로 센 줄 수 */
export function inkAnalysis(f: Rgb, box: Box): { ink: Box; lines: number; inkPixels: number } {
  let x1: number = VIDEO.width, y1: number = VIDEO.height, x2 = -1, y2 = -1, n = 0;
  const rows: number[] = [];
  for (let y = box.y; y < box.y + box.h; y++) {
    let c = 0;
    for (let x = box.x; x < box.x + box.w; x++) {
      if (isInk(px(f, x, y))) {
        c++;
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
    n += c;
    rows.push(c);
  }
  // 글자가 있는 행 덩어리를 줄로 본다(덩어리 사이에 4행 이상 빈 곳이 있으면 다른 줄)
  let lines = 0;
  let gap = 99;
  for (const c of rows) {
    if (c > 0) {
      if (gap >= 4) lines++;
      gap = 0;
    } else gap++;
  }
  return { ink: { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }, lines, inkPixels: n };
}
