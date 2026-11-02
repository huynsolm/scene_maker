import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { createSampleProject } from '../server/seed';
import { solidPng } from '../server/solidPng';
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
const jobs = async (projectId: string) =>
  ((await (await fetch(`${env.base}/api/projects/${projectId}/renders/latest`)).json()) as any).job;
const openConfirm = (page: Page) => page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();

describe('2단계 생성 흐름(실제 ffmpeg)', () => {
  it('요청 → 진행 상태 → 완료: MP4 가 만들어지고 다운로드·재생 정보가 연결된다', async () => {
    const sample = createSampleProject(env.store);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${sample.id}`);
    await page.getByLabel('영상 제목').waitFor();

    // 마지막 편집 직후(자동 저장 대기 중)에 바로 눌러도 그 내용으로 만들어져야 한다
    await page.locator('#scene-text').fill('방금 입력한 문구로 영상을 만듭니다');
    await openConfirm(page);
    // 같은 틱에 연속으로 두 번 눌러도(화면이 다시 그려지기 전) 작업은 1개
    await page.locator('[role=dialog]').getByRole('button', { name: '영상 만들기 시작' }).evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });
    await page.waitForURL(/\/result$/);
    await eventually(async () => ['waiting', 'generating', 'done'].includes((await page.locator('[data-screen=result]').getAttribute('data-status')) ?? ''), '결과 화면 상태');

    const first = await jobs(sample.id);
    expect(first.snapshot.scenes[0].text).toBe('방금 입력한 문구로 영상을 만듭니다');
    const all = env.store['db'].prepare(`SELECT COUNT(*) c FROM render_jobs WHERE project_id = ?`).get(sample.id) as { c: number };
    expect(all.c).toBe(1);

    // 진행 중에는 요청 버튼이 막혀 있고 남은 시간(퍼센트)을 지어내지 않는다
    const status = await page.locator('[data-screen=result]').getAttribute('data-status');
    if (status !== 'done') {
      await eventually(hasText(page, '.panel', '영상 만들기 요청됨'), '요청됨 버튼');
      expect(await page.locator('.panel').innerText()).not.toMatch(/\d+\s*%/);
    }

    await eventually(async () => (await page.locator('[data-screen=result]').getAttribute('data-status')) === 'done', '완료', 90_000);
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '완성 문구');
    const href = (await page.getByRole('link', { name: 'MP4 다운로드' }).getAttribute('href'))!;
    expect(href).toMatch(/\/video\?download=1$/);

    // 내려받은 파일을 ffprobe 로 확인
    const res = await fetch(env.base + href);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(encodeURIComponent('매장 재고 관리 사용법.mp4'));
    const file = path.join(env.dataDir, '_downloaded.mp4');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', file]).toString());
    expect(probe.streams).toHaveLength(1);
    expect(probe.streams[0]).toMatchObject({ codec_type: 'video', width: 1280, height: 720 });
    expect(Number(probe.format.duration)).toBeGreaterThan(29.9);

    // 브라우저 재생: 이 Chromium 이 H.264 를 지원할 때만 확인한다(지원하지 않으면 '미확인'으로 남긴다)
    const canPlay = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"'));
    console.log(`[e2e] 이 Chromium 의 H.264 재생 지원: ${canPlay || '없음'}`);
    if (canPlay) {
      await eventually(
        async () => (await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).duration)) > 29.5,
        '브라우저가 읽은 영상 길이',
        15_000,
      );
      // 실제로 재생이 진행되고(currentTime 증가) 디코딩 오류가 없다
      await page.evaluate(() => {
        const v = document.querySelector('[data-testid=player]') as HTMLVideoElement;
        v.muted = true;
        return v.play();
      });
      await eventually(async () => (await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).currentTime)) > 0.5, '재생 진행', 15_000);
      expect(await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement).error)).toBeNull();
    }

    // 새로고침해도 결과가 유지된다
    await page.reload();
    await eventually(hasText(page, '.panel', '영상이 완성됐어요'), '새로고침 후에도 완료');
    // 완료 뒤 고치면 목록에서는 편집 중으로 돌아간다
    await page.goto(`${env.base}/projects/${sample.id}`);
    await page.locator('#scene-text').fill('완료 뒤에 고친 문구');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    await page.goto(env.base + '/');
    await eventually(hasText(page, '.row:has-text("매장 재고 관리 사용법")', '편집 중'), '편집 중으로 복귀');
    await page.close();
  }, 180_000);

  it('실패: 깨진 이미지는 몇 번째 장면인지 알려주고 입력은 그대로이며, 이미지를 바꾼 뒤 다시 시도하면 성공한다', async () => {
    const sample = createSampleProject(env.store);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${sample.id}`);
    await page.getByLabel('영상 제목').waitFor();
    // 2번 장면을 머리만 정상인 깨진 PNG 로 교체
    await page.locator('[data-testid=scene-card-1]').click();
    await page.getByTestId('file-input').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: solidPng(1280, 720, [9, 9, 9]).subarray(0, 120) });
    await eventually(hasText(page, '.image-row', 'broken.png'), '깨진 이미지 업로드됨');

    await openConfirm(page);
    await page.locator('[role=dialog]').getByRole('button', { name: '영상 만들기 시작' }).click();
    await page.waitForURL(/\/result$/);
    await eventually(async () => (await page.locator('[data-screen=result]').getAttribute('data-status')) === 'failed', '실패 상태', 60_000);
    await eventually(hasText(page, '[role=alert]', '장면 2 이미지를 읽을 수 없어요'), '실패 이유');
    await eventually(hasText(page, '[role=alert]', 'IMAGE_DECODE_FAILED'), '오류 코드');
    expect(await page.locator('.panel').innerText()).toContain('입력한 내용은 그대로 저장되어 있어요');

    // 그대로 다시 시도하면 같은 이유로 또 실패한다(새 작업이 만들어지고 중복되지 않는다)
    const before = await jobs(sample.id);
    await page.getByRole('button', { name: '다시 시도' }).click();
    await eventually(async () => (await jobs(sample.id)).id !== before.id, '새 작업 생성');
    await eventually(async () => (await page.locator('[data-screen=result]').getAttribute('data-status')) === 'failed', '다시 실패', 60_000);

    // 편집 화면: 입력과 이미지가 보존되어 있다 → 이미지를 올바른 파일로 바꾼다
    await page.locator('.panel').getByRole('link', { name: /편집에서 확인하기/ }).click(); // 문제가 된 장면 편집으로 바로 이동
    await page.getByLabel('영상 제목').waitFor();
    expect(await page.getByLabel('영상 제목').inputValue()).toBe('매장 재고 관리 사용법');
    // 링크(?scene=2)로 들어왔으므로 이미 장면 2가 선택되어 있다
    await eventually(hasText(page, '.col-inspector h2', '장면 2 편집'), '장면 2 자동 선택');
    expect(await page.locator('#scene-text').inputValue()).toContain('재고 화면에서');
    await page.getByTestId('file-input').setInputFiles({ name: 'fixed.png', mimeType: 'image/png', buffer: solidPng(1280, 720, [64, 120, 104]) });
    await eventually(hasText(page, '.image-row', 'fixed.png'), '이미지 교체');

    await openConfirm(page);
    await page.locator('[role=dialog]').getByRole('button', { name: '영상 만들기 시작' }).click();
    await page.waitForURL(/\/result$/);
    await eventually(async () => (await page.locator('[data-screen=result]').getAttribute('data-status')) === 'done', '재시도 후 완료', 90_000);
    await page.close();
  }, 240_000);

  it('진행 중인 프로젝트의 편집 화면은 안내 배너를 보여주고 새 요청을 막는다', async () => {
    const sample = createSampleProject(env.store);
    const page = await env.newPage();
    // 렌더가 오래 걸리게: 요청 직후 바로 편집 화면으로 이동
    const created = await fetch(`${env.base}/api/projects/${sample.id}/renders`, { method: 'POST' });
    expect(created.status).toBe(202);
    await page.goto(`${env.base}/projects/${sample.id}`);
    await eventually(hasText(page, '.busy-banner', '지금 영상을 만드는 중이에요'), '진행 중 배너');
    await eventually(hasText(page, '.topbar', '생성 진행 상황 보기'), '진행 상황 버튼');
    expect(await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).count()).toBe(0);
    // API 도 중복 요청을 거부한다
    const again = await fetch(`${env.base}/api/projects/${sample.id}/renders`, { method: 'POST' });
    expect(again.status).toBe(409);
    await page.close();
    await eventually(async () => (await jobs(sample.id)).status === 'done', '정리를 위해 완료까지 대기', 90_000);
  }, 180_000);
});
