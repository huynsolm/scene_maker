import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  /** 빌드된 웹 파일 위치. 없으면 API만 제공한다(개발 중에는 Vite가 화면을 제공). */
  webDist: string | null;
  ffmpegPath: string;
  ffprobePath: string;
  /** 자막 글꼴 폴더(Noto Sans KR + OFL.txt) */
  fontsDir: string;
  /** ffmpeg 한 번 실행의 제한 시간 */
  renderTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    port: Number(env.PORT ?? 3001),
    // 로그인이 없는 단일 사용자 앱이므로 기본은 로컬 접속만 허용한다.
    host: env.HOST ?? '127.0.0.1',
    webDist: path.resolve(env.WEB_DIST ?? 'dist/web'),
    ffmpegPath: env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH ?? 'ffprobe',
    fontsDir: env.FONTS_DIR ? path.resolve(env.FONTS_DIR) : fileURLToPath(new URL('../fonts', import.meta.url)),
    renderTimeoutMs: Number(env.RENDER_TIMEOUT_MS ?? 10 * 60 * 1000),
  };
}
