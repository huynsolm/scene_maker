import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { solidPng } from '../server/solidPng';
import { createSampleProject } from '../server/seed';
import { startEnv, type Env } from './harness';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.close();
});

async function eventually(fn: () => Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 충족되지 않음: ${what}${last ? ` (${String(last)})` : ''}`);
}
const hasText = (page: Page, sel: string, needle: string) => async () => (await page.locator(sel).first().innerText({ timeout: 500 })).includes(needle);
const status = (page: Page) => page.locator('[data-screen=result]').getAttribute('data-status');

/** 짧은 영상(장면 길이 지정)용 프로젝트. 렌더가 빨리 끝나도록 3~5초 장면을 쓴다. */
function quickProject(title: string, durations = [3, 4, 5]) {
  const colors: Array<[number, number, number]> = [[74, 93, 140], [64, 120, 104], [140, 98, 64]];
  const p = env.store.createProject({ title });
  env.store.saveProject(p.id, {
    title,
    scenes: durations.map((d, i) => ({ text: `장면 ${i + 1} 안내 문구입니다`, durationSec: d })),
  });
  colors.forEach((c, i) => env.store.attachImage(p.id, i, solidPng(1280, 720, c), `c${i}.png`));
  return p;
}
const api = async (p: string, init?: RequestInit) => (await fetch(env.base + p, init)).json() as Promise<any>;
async function renderDone(projectId: string) {
  const { job } = await api(`/api/projects/${projectId}/renders`, { method: 'POST' });
  for (let i = 0; i < 300; i++) {
    const j = (await api(`/api/renders/${job.id}`)).job;
    if (j.status === 'done') return j;
    if (j.status === 'failed') throw new Error(JSON.stringify(j.error));
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('렌더가 끝나지 않음');
}

describe('결과 화면', () => {
  it('완료: 16:9 플레이어, 장면 길이 비율의 진행 막대, 장면 이동·재생·다운로드, 편집용 안내선 없음', async () => {
    const p = quickProject('결과 화면 확인', [3, 4, 5]);
    const job = await renderDone(p.id);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${p.id}/result`);
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '완료 패널');

    // 영상 위에는 편집용 UI(안전 영역 안내선, 자막 자리 힌트)가 없다
    expect(await page.locator('.guide-box, .subtitle-hint').count()).toBe(0);
    const frame = (await page.locator('.player-frame').boundingBox())!;
    expect(frame.width / frame.height).toBeCloseTo(16 / 9, 2);

    // 진행 막대는 3개로 나뉘고 폭이 장면 길이(3:4:5) 비율이다
    const widths = await page.locator('.seg').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(widths).toHaveLength(3);
    const unit = widths[0]! / 3;
    expect(widths[1]! / unit).toBeGreaterThan(3.8);
    expect(widths[1]! / unit).toBeLessThan(4.2);
    expect(widths[2]! / unit).toBeGreaterThan(4.8);
    expect(widths[2]! / unit).toBeLessThan(5.2);

    // 장면 3 의 처음(3+4=7초)으로 이동
    await page.getByRole('button', { name: '장면 3부터 보기' }).click();
    await eventually(async () => Math.abs((await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).currentTime)) - 7) < 0.4, '7초로 이동');
    await eventually(hasText(page, '[data-testid=player-time]', '0:07 / 0:12'), '시간 표시');

    // 재생 / 일시정지
    await page.getByRole('button', { name: '재생' }).click();
    await eventually(async () => (await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).currentTime)) > 7.4, '재생 진행', 10_000);
    await page.getByRole('button', { name: '일시정지' }).click();
    await eventually(async () => (await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).paused)) === true, '일시정지');

    // 정보 목록과 다운로드(파일명 = 제목.mp4)
    const panel = await page.locator('.panel').innerText();
    for (const t of ['MP4', '1280 × 720 (가로형)', '12초 (0:12)', '없음']) expect(panel).toContain(t);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'MP4 다운로드' }).click()]);
    expect(download.suggestedFilename()).toBe('결과 화면 확인.mp4');
    const saved = path.join(env.dataDir, '_dl.mp4');
    await download.saveAs(saved);
    expect(fs.statSync(saved).size).toBe(fs.statSync(path.join(env.dataDir, 'videos', p.id, `${job.id}.mp4`)).size);
    await eventually(hasText(page, '.toast', '결과 화면 확인.mp4'), '다운로드 안내 토스트');
    await page.close();
  }, 120_000);

  it('진행 중: 단계 목록과 움직이는 막대가 보이고, 남은 시간·퍼센트는 지어내지 않으며, 요청 버튼은 막혀 있다', async () => {
    const sample = createSampleProject(env.store); // 30초 영상이라 몇 초 동안 '생성 중'에 머문다
    const page = await env.newPage();
    const { job } = await api(`/api/projects/${sample.id}/renders`, { method: 'POST' });
    await page.goto(`${env.base}/projects/${sample.id}/result`);
    await eventually(async () => ['waiting', 'generating'].includes((await status(page)) ?? ''), '진행 상태');
    expect(await page.locator('[data-testid=steps] .step').count()).toBe(4);
    expect(await page.locator('[data-testid=steps] .step[data-state=active]').count()).toBe(1);
    expect(await page.locator('.indet').count()).toBe(1);
    expect(await page.locator('.player-frame .stage-msg').count()).toBe(1);
    expect(await page.locator('.panel').innerText()).not.toMatch(/\d+\s*%/);
    expect(await page.getByRole('button', { name: '영상 만들기 요청됨' }).isDisabled()).toBe(true);
    await page.screenshot({ path: path.join(env.dataDir, 'result-busy.png') });
    await eventually(async () => (await status(page)) === 'done', '완료로 전환(폴링)', 60_000);
    await eventually(async () => (await page.locator('[data-testid=player]').count()) === 1, '플레이어 표시');
    void job;
    await page.close();
  }, 120_000);

  it('마지막 생성 영상 보기: 고쳐서 편집 중이 되어도 편집 화면에서 이전 영상에 접근하고, 이전 버전임을 알려준다', async () => {
    const p = quickProject('이전 영상 보기');
    const job = await renderDone(p.id);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${p.id}`);
    await page.getByLabel('영상 제목').waitFor();
    await page.locator('#scene-text').fill('완성 뒤에 고친 문구');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');

    await page.goto(env.base + '/');
    await eventually(hasText(page, `.row:has-text("이전 영상 보기")`, '편집 중'), '목록에서는 편집 중');
    await page.locator('.row:has-text("이전 영상 보기")').click();
    await page.getByLabel('영상 제목').waitFor();

    await page.getByRole('link', { name: '마지막 생성 영상 보기' }).click();
    await page.waitForURL(new RegExp(`/projects/${p.id}/result/${job.id}$`));
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '이전 영상 표시');
    await eventually(hasText(page, '[data-testid=outdated-note]', '이 영상을 만든 뒤에 내용을 고쳤어요'), '이전 버전 안내');
    expect(await page.locator('[data-testid=player]').count()).toBe(1);
    // 구성 장면은 영상을 만든 시점의 문구
    expect(await page.locator('.scene-summary').innerText()).toContain('장면 1 안내 문구입니다');
    expect(await page.locator('.scene-summary').innerText()).not.toContain('완성 뒤에 고친 문구');
    await page.close();
  }, 120_000);

  it('실패 → 직전 완성 영상 링크와 문제 장면 바로가기, 다시 시도하면 복구된다', async () => {
    const p = quickProject('실패 복구 동선');
    const good = await renderDone(p.id);
    // 3번 장면을 머리만 정상인 깨진 PNG 로 바꾼다
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(solidPng(1280, 720, [9, 9, 9]).subarray(0, 120))], { type: 'image/png' }), 'broken.png');
    expect((await fetch(`${env.base}/api/projects/${p.id}/scenes/2/image`, { method: 'POST', body: form })).status).toBe(200);

    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${p.id}`);
    await page.getByLabel('영상 제목').waitFor();
    await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();
    await page.locator('[role=dialog]').getByRole('button', { name: '영상 만들기 시작' }).click();
    await page.waitForURL(/\/result$/);
    await eventually(async () => (await status(page)) === 'failed', '실패 상태', 60_000);
    await eventually(hasText(page, '[role=alert]', '장면 3 이미지를 읽을 수 없어요'), '실패 이유');

    // 직전 완성 영상은 그대로 볼 수 있다
    await page.locator('.panel').getByRole('link', { name: '마지막 생성 영상 보기' }).click();
    await page.waitForURL(new RegExp(`/result/${good.id}$`));
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '직전 영상');
    await page.goBack();
    await eventually(async () => (await status(page)) === 'failed', '실패 화면으로 복귀');

    // 문제 장면(3)으로 바로 이동
    await page.locator('.panel').getByRole('link', { name: '장면 3 편집에서 확인하기' }).click();
    await eventually(hasText(page, '.col-inspector h2', '장면 3 편집'), '장면 3 선택');
    await page.getByTestId('file-input').setInputFiles({ name: 'fixed.png', mimeType: 'image/png', buffer: solidPng(1280, 720, [140, 98, 64]) });
    await eventually(hasText(page, '.image-row', 'fixed.png'), '이미지 교체');
    await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();
    await page.locator('[role=dialog]').getByRole('button', { name: '영상 만들기 시작' }).click();
    await page.waitForURL(/\/result$/);
    await eventually(async () => (await status(page)) === 'done', '재시도 완료', 60_000);
    await page.close();
  }, 180_000);

  it('다른 프로젝트의 작업 ID 로 결과 주소를 열면 그 영상·문구를 보여주지 않고 안내한다', async () => {
    const a = quickProject('프로젝트 A 비공개 제목');
    const b = quickProject('프로젝트 B 비공개 제목');
    const jobB = await renderDone(b.id);
    await renderDone(a.id);
    const page = await env.newPage();

    // 정상: B 의 작업은 B 경로에서 열린다
    await page.goto(`${env.base}/projects/${b.id}/result/${jobB.id}`);
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), 'B 경로의 B 작업');

    // 비정상: A 경로 + B 의 작업 ID
    await page.goto(`${env.base}/projects/${a.id}/result/${jobB.id}`);
    await eventually(hasText(page, '.center-msg', '영상을 찾을 수 없어요'), '안내 표시');
    const text = await page.locator('body').innerText();
    expect(text).not.toContain('프로젝트 B 비공개 제목');
    expect(text).not.toContain('장면 1 안내 문구입니다'); // B 의 구성 장면도 보이지 않는다
    expect(await page.locator('[data-testid=player]').count()).toBe(0);
    // 돌아갈 곳은 A 의 편집 화면과 목록
    expect(await page.getByRole('link', { name: '편집 화면으로 돌아가기' }).getAttribute('href')).toBe(`/projects/${a.id}`);
    await page.close();
  }, 120_000);

  for (const width of [390, 320]) {
    it(`${width}px 너비: 결과 화면(완료·실패)이 가로 스크롤 없이 쓰인다`, async () => {
      const p = quickProject(`좁은 화면 ${width}`, [3, 3, 3]);
      await renderDone(p.id);
      const page = await env.newPage({ width, height: 800 });
      await page.goto(`${env.base}/projects/${p.id}/result`);
      await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '완료');
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      expect(await page.locator('.seg').count()).toBe(3);
      await page.screenshot({ path: path.join(env.dataDir, `result-done-${width}.png`), fullPage: true });

      // 실패 화면(오류 문구가 긴 경우)도 확인: 깨진 이미지로 한 번 더 요청
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(solidPng(1280, 720, [9, 9, 9]).subarray(0, 120))], { type: 'image/png' }), 'broken.png');
      await fetch(`${env.base}/api/projects/${p.id}/scenes/1/image`, { method: 'POST', body: form });
      await fetch(`${env.base}/api/projects/${p.id}/renders`, { method: 'POST' });
      await page.goto(`${env.base}/projects/${p.id}/result`);
      await eventually(async () => (await status(page)) === 'failed', '실패', 60_000);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.screenshot({ path: path.join(env.dataDir, `result-failed-${width}.png`), fullPage: true });
      await page.close();
    }, 120_000);
  }
});

describe('자막 글꼴', () => {
  it('자막만 Noto Sans KR 웹 글꼴을 쓰고 일반 UI 는 Pretendard 를 유지하며, 샘플·긴 문구의 모든 글자가 웹 글꼴에 들어 있다', async () => {
    const sample = createSampleProject(env.store);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${sample.id}`);
    await page.getByTestId('preview-subtitle').waitFor();
    const fonts = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      subtitle: getComputedStyle(document.querySelector('[data-testid=preview-subtitle]')!).fontFamily,
    }));
    expect(fonts.body.startsWith('"Pretendard Variable"') || fonts.body.startsWith('Pretendard Variable')).toBe(true);
    expect(fonts.subtitle).toContain('Subtitle KR');

    const texts = [
      '매장에 우유가 부족한지 확인하기 어려우셨나요?',
      '재고 화면에서 현재 수량과 부족한 품목을 확인하세요.',
      '발주 목록에 추가하고 입고 수량을 기록해 보세요.',
      '가나다라마바사아자차카타파하 쌍기역 ㄲㄸㅃㅆㅉ, “따옴표”와 — 줄표… 100% (2) 3,000원 ₩ 1㎏ 25℃',
    ];
    const covered = await page.evaluate(
      (ts) => Promise.all(ts.map((t) => document.fonts.load("600 40px 'Subtitle KR'", t).then(() => document.fonts.check("600 40px 'Subtitle KR'", t)))),
      texts,
    );
    expect(covered).toEqual([true, true, true, true]);
    await page.close();
  });
});
