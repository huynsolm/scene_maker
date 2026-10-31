import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { buildApp } from '../server/app';

// 이 환경에는 Playwright 와 Chromium 이 전역으로 설치돼 있다(NODE_PATH). ESM 에서는 require 로 읽는다.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

export interface Env {
  base: string;
  dataDir: string;
  browser: Browser;
  store: Awaited<ReturnType<typeof buildApp>>['store'];
  close: () => Promise<void>;
  newPage: (viewport?: { width: number; height: number }) => Promise<Page>;
}

export async function startEnv(dataDir?: string): Promise<Env> {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'scene-maker-e2e-'));
  const webDist = path.resolve('dist/web');
  if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('먼저 `npm run build` 로 화면을 빌드해 주세요.');
  const { app, store } = await buildApp({ dataDir: dir, webDist });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  // 로케일이 UTF-8 이 아닌 Linux(예: LANG 이 비어 있는 컨테이너)에서는 Chromium 이 한글 다운로드 파일명을
  // 만들지 못하고 'download' 로 저장한다. 서버 헤더(filename*=UTF-8'')는 올바르므로 테스트 브라우저만 UTF-8 로 띄운다.
  const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } as Record<string, string> });
  return {
    base: `http://127.0.0.1:${port}`,
    dataDir: dir,
    browser,
    store,
    newPage: (viewport = { width: 1440, height: 900 }) => browser.newPage({ viewport }),
    close: async () => {
      await browser.close();
      await app.close();
    },
  };
}
