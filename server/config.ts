import path from 'node:path';

export interface Config {
  dataDir: string;
  port: number;
  host: string;
  /** 빌드된 웹 파일 위치. 없으면 API만 제공한다(개발 중에는 Vite가 화면을 제공). */
  webDist: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    dataDir: path.resolve(env.DATA_DIR ?? 'data'),
    port: Number(env.PORT ?? 3001),
    // 로그인이 없는 단일 사용자 앱이므로 기본은 로컬 접속만 허용한다.
    host: env.HOST ?? '127.0.0.1',
    webDist: path.resolve(env.WEB_DIST ?? 'dist/web'),
  };
}
