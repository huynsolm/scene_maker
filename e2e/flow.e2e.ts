import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { solidPng } from '../server/solidPng';
import { startEnv, type Env } from './harness';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.close();
});

async function eventually(fn: () => Promise<boolean>, what: string, ms = 10_000) {
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

/**
 * 사용자가 처음부터 끝까지 하는 일을 화면만으로 따라간다.
 * 새 프로젝트 → 제목·장면 3개 입력(문구·이미지·길이) → 미리보기 → 저장 확인 → 영상 만들기 → 진행 확인(목록에서도)
 * → 완료·재생·다운로드 → 수정 → 이전 영상 보기 → 다시 만들기 → 삭제
 */
describe('전체 흐름', () => {
  it('프로젝트 생성부터 영상 다운로드, 수정 후 재생성, 삭제까지', async () => {
    const page = await env.newPage();
    const colors: Array<[number, number, number]> = [[74, 93, 140], [64, 120, 104], [140, 98, 64]];
    const texts = ['매장에 우유가 부족한지 확인하기 어려우셨나요?', '재고 화면에서 현재 수량과 부족한 품목을 확인하세요.', '발주 목록에 추가하고 입고 수량을 기록해 보세요.'];

    // 1) 빈 목록 → 첫 영상 만들기
    await page.goto(env.base + '/');
    await eventually(hasText(page, '.list-main', '아직 만든 영상이 없어요'), '빈 상태');
    await page.getByRole('button', { name: '첫 영상 만들기' }).click();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
    const projectId = page.url().split('/').pop()!;

    // 2) 제목과 장면 3개 입력(문구·이미지·길이). 길이는 빨리 끝나도록 3초.
    await page.getByLabel('영상 제목').fill('매장 재고 관리 사용법');
    for (let i = 0; i < 3; i++) {
      await eventually(hasText(page, '.col-inspector h2', `장면 ${i + 1} 편집`), `장면 ${i + 1} 선택`);
      await page.locator('#scene-text').fill(texts[i]!);
      await page.getByTestId('file-input').setInputFiles({ name: `s${i + 1}.png`, mimeType: 'image/png', buffer: solidPng(1280, 720, colors[i]!) });
      await eventually(hasText(page, '.image-row', `s${i + 1}.png`), `장면 ${i + 1} 이미지`);
      const dur = page.getByLabel('장면 길이(초)');
      await dur.fill('3');
      await dur.blur();
      if (i < 2) await page.getByRole('button', { name: new RegExp(`다음: 장면 ${i + 2} 편집`) }).click();
    }
    await eventually(hasText(page, '.total-chip', '9초'), '전체 길이 9초');

    // 3) 미리보기: 재생 버튼으로 선택 장면을 재생하면 진행 시간이 올라간다
    await page.locator('[data-testid=scene-card-0]').click();
    await page.getByRole('button', { name: '재생' }).click();
    await eventually(async () => !(await page.locator('.controls .mono').innerText()).startsWith('0:00 / 0:03'), '미리보기 재생 진행');
    // 미리보기 위에는 편집용 안내선이 있고(켜진 상태), 끄면 사라진다
    expect(await page.locator('.guide-box').count()).toBe(1);
    await page.getByRole('button', { name: '안내선 숨기기' }).click();
    expect(await page.locator('.guide-box').count()).toBe(0);

    // 4) 저장 확인 후 새로고침해도 유지
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    await page.reload();
    await eventually(async () => (await page.getByLabel('영상 제목').inputValue()) === '매장 재고 관리 사용법', '새로고침 후 제목');
    await eventually(hasText(page, '.total-chip', '9초'), '새로고침 후 길이');

    // 5) 영상 만들기 → 확인 모달 → 시작
    await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();
    const dialog = page.locator('[role=dialog]');
    await eventually(hasText(page, '[role=dialog]', '이 내용으로 영상을 만들까요?'), '확인 모달');
    expect((await dialog.innerText()).match(/준비됐어요/g)?.length).toBe(3);
    await dialog.getByRole('button', { name: '영상 만들기 시작' }).click();
    await page.waitForURL(/\/result$/);

    // 6) 화면을 닫아도(목록으로 나가도) 생성은 계속되고 목록에서 상태를 볼 수 있다
    await page.getByRole('link', { name: '← 프로젝트' }).click();
    await eventually(async () => /생성 대기|생성 중|생성 완료/.test(await page.locator('.row:has-text("매장 재고 관리 사용법")').innerText()), '목록에 생성 상태 표시');
    await eventually(async () => {
      await page.reload();
      return (await page.locator('.row:has-text("매장 재고 관리 사용법")').innerText({ timeout: 2000 })).includes('생성 완료');
    }, '목록에서 생성 완료', 60_000);

    // 7) 목록의 행을 눌러 결과 화면으로 → 재생 → 다운로드
    await page.locator('.row:has-text("매장 재고 관리 사용법")').click();
    await page.waitForURL(/\/result$/);
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '완성');
    await page.getByRole('button', { name: '재생' }).click();
    await eventually(async () => (await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).currentTime)) > 0.5, '결과 재생');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'MP4 다운로드' }).click()]);
    expect(download.suggestedFilename()).toBe('매장 재고 관리 사용법.mp4');
    const file = path.join(env.dataDir, '_flow.mp4');
    await download.saveAs(file);
    expect(fs.statSync(file).size).toBeGreaterThan(1000);

    // 8) 수정하러 편집 화면으로 → 문구 고침 → 목록은 편집 중
    await page.getByRole('link', { name: '수정하러 편집 화면으로' }).click();
    await page.getByLabel('영상 제목').waitFor();
    await eventually(async () => (await page.getByRole('link', { name: '마지막 생성 영상 보기' }).count()) === 1, '마지막 영상 링크');
    await page.locator('#scene-text').fill('고친 문구로 다시 만들어요');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '수정 저장됨');

    // 9) 편집 중에도 이전 영상은 볼 수 있고, 이전 버전임을 알려준다
    await page.getByRole('link', { name: '마지막 생성 영상 보기' }).click();
    await eventually(hasText(page, '[data-testid=outdated-note]', '이 영상을 만든 뒤에 내용을 고쳤어요'), '이전 버전 안내');
    await page.getByRole('link', { name: '수정하러 편집 화면으로' }).click();
    await page.getByLabel('영상 제목').waitFor();

    // 10) 고친 내용으로 다시 만들기 → 새 영상, 안내 사라짐
    await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();
    await page.locator('[role=dialog]').getByRole('button', { name: '영상 만들기 시작' }).click();
    await page.waitForURL(/\/result$/);
    await eventually(async () => (await status(page)) === 'done', '두 번째 영상 완료', 60_000);
    expect(await page.locator('[data-testid=outdated-note]').count()).toBe(0);
    expect(await page.locator('.scene-summary').innerText()).toContain('고친 문구로 다시 만들어요');
    const jobs = env.store['db'].prepare(`SELECT COUNT(*) c FROM render_jobs WHERE project_id = ?`).get(projectId) as { c: number };
    expect(jobs.c).toBe(2);

    // 11) 삭제: 안내를 먼저 보여주고, 확정하면 이미지·영상 파일까지 지운다
    await page.getByRole('link', { name: '← 프로젝트' }).click();
    const row = page.locator('.row:has-text("매장 재고 관리 사용법")');
    await row.getByRole('button', { name: /삭제/ }).click();
    await eventually(hasText(page, '[role=dialog]', '이미지와 만든 영상 파일도 함께 지워지고'), '삭제 안내');
    const uploads = path.join(env.dataDir, 'uploads', projectId);
    const videos = path.join(env.dataDir, 'videos', projectId);
    expect(fs.readdirSync(uploads).length).toBeGreaterThan(0);
    expect(fs.readdirSync(videos).length).toBe(2);
    await page.locator('[role=dialog]').getByRole('button', { name: '삭제', exact: true }).click();
    await eventually(async () => (await page.locator('.row:has-text("매장 재고 관리 사용법")').count()) === 0, '목록에서 삭제됨');
    expect(fs.existsSync(uploads)).toBe(false);
    expect(fs.existsSync(videos)).toBe(false);
    await page.close();
  }, 240_000);
});
