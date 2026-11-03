import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

const db = () => (env.store as unknown as { db: import('better-sqlite3').Database }).db;
const api = async (p: string, init?: RequestInit) => {
  const res = await fetch(env.base + p, init);
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
async function eventually(fn: () => Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* 다시 시도 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 충족되지 않음: ${what}`);
}

/** 영상을 실제로 한 편 만든 프로젝트(장면 길이 3·4·5초). */
async function projectWithVideo(title: string) {
  const p = env.store.createProject({ title });
  env.store.saveProject(p.id, { title, scenes: [3, 4, 5].map((d, i) => ({ text: `장면 ${i + 1} 안내 문구입니다`, durationSec: d })) });
  ([[74, 93, 140], [64, 120, 104], [140, 98, 64]] as Array<[number, number, number]>).forEach((c, i) => env.store.attachImage(p.id, i, solidPng(1280, 720, c), `c${i}.png`));
  const { body } = await api(`/api/projects/${p.id}/renders`, { method: 'POST' });
  const id = body.job.id as string;
  for (let i = 0; i < 300; i++) {
    const j = (await api(`/api/renders/${id}`)).body.job;
    if (j.status === 'done') return { project: p, firstJob: id };
    if (j.status === 'failed') throw new Error(JSON.stringify(j.error));
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('렌더가 끝나지 않음');
}

/** 완성된 작업을 복제해 영상이 여러 편 있는 상태를 빠르게 만든다. 오래된 순서대로 시각을 준다. */
function cloneJob(sourceId: string, opts: { status?: 'done' | 'generating'; minutesAgo: number }): string {
  const row = db().prepare(`SELECT * FROM render_jobs WHERE id = ?`).get(sourceId) as Record<string, any>;
  const id = randomUUID();
  const t = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
  const active = opts.status === 'generating';
  db()
    .prepare(
      `INSERT INTO render_jobs (id, project_id, status, step, snapshot_json, video_file, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, row.project_id, active ? 'generating' : 'done', active ? 2 : 3, row.snapshot_json, active ? null : row.video_file, t, t, active ? null : t);
  db().prepare(`INSERT INTO render_job_images (job_id, image_id) SELECT ?, image_id FROM render_job_images WHERE job_id = ?`).run(id, sourceId);
  if (!active) {
    const dir = path.join(env.dataDir, 'videos', row.project_id);
    fs.copyFileSync(path.join(dir, `${sourceId}.mp4`), path.join(dir, `${id}.mp4`));
  }
  return id;
}
const videoExists = (projectId: string, jobId: string) => fs.existsSync(path.join(env.dataDir, 'videos', projectId, `${jobId}.mp4`));
const items = (page: Page) => page.locator('[data-testid=past-item]');
const ids = async (page: Page) => items(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.id));
/** 목록 조회(첫 페이지) 주소 */
const listUrl = (u: URL) => /\/api\/projects\/[^/]+\/renders$/.test(u.pathname) && u.searchParams.get('limit') === '10' && !u.searchParams.has('before');
const deleteUrl = (u: URL) => /\/api\/projects\/[^/]+\/renders\/[^/]+$/.test(u.pathname);
const shortTimeout = (page: Page) => page.addInitScript(() => ((window as unknown as { __SM_TIMEOUT_MS: number }).__SM_TIMEOUT_MS = 1500));
async function openDeleteDialog(page: Page, jobId: string) {
  await page.locator(`[data-testid=past-item][data-id="${jobId}"] [data-testid=past-delete]`).click();
  await page.locator('[role=dialog]').waitFor();
}

describe('이전에 만든 영상 삭제(결과 화면)', () => {
  it('목록은 최신순으로 처음 10개와 "더 보기"로 나뉘고, 보고 있는 영상을 표시하며, 오래된 내용은 안내한다', async () => {
    const { project, firstJob } = await projectWithVideo('목록 확인');
    const all = [firstJob];
    for (let i = 1; i <= 11; i++) all.push(cloneJob(firstJob, { minutesAgo: 1000 - i * 10 })); // 12편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 2000 * 60_000).toISOString(), new Date(Date.now() - 2000 * 60_000).toISOString(), firstJob);
    // 편집 내용을 고친 것으로 만든다(이후의 모든 영상이 현재 내용보다 이전)
    env.store.saveProject(project.id, { title: '목록 확인(수정)', scenes: env.store.getProject(project.id).scenes.map((s) => ({ id: s.id, text: s.text, durationSec: s.durationSec })) });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${all[5]}`);
    await items(page).first().waitFor();
    expect(await items(page).count()).toBe(10);
    expect((await ids(page))[0]).toBe(all[11]); // 가장 최근이 맨 위
    await page.locator(`[data-id="${all[5]}"]`).waitFor();
    expect(await page.locator(`[data-id="${all[5]}"]`).getAttribute('data-current')).toBe('true');
    expect(await page.locator(`[data-id="${all[5]}"]`).innerText()).toContain('지금 보는 영상');
    expect(await page.locator(`[data-id="${all[5]}"] a:has-text("보기")`).count()).toBe(0); // 지금 보는 영상에는 "보기"가 없다
    expect(await items(page).first().innerText()).toContain('현재 내용보다 이전');
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 12, '더 보기 후 12편');
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);
    expect(new Set(await ids(page)).size).toBe(12);
    await page.close();
  });

  it('확인 창에서 취소하면 아무것도 지워지지 않고, 삭제하면 목록·파일·프로젝트의 마지막 영상이 갱신된다', async () => {
    const { project, firstJob } = await projectWithVideo('삭제 확인');
    const older = firstJob;
    const newer = cloneJob(firstJob, { minutesAgo: -1 }); // 가장 최근
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await items(page).first().waitFor();
    expect(await items(page).count()).toBe(2);

    await openDeleteDialog(page, older);
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('취소'); // 기본 초점은 취소
    await page.locator('[role=dialog] button:has-text("취소")').click();
    expect(await items(page).count()).toBe(2);
    expect(videoExists(project.id, older)).toBe(true);

    await openDeleteDialog(page, older);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await items(page).count()) === 1, '목록에서 사라짐');
    expect(videoExists(project.id, older)).toBe(false);
    expect((await api(`/api/renders/${older}`)).status).toBe(404);
    expect(videoExists(project.id, newer)).toBe(true);
    expect((await api(`/api/projects/${project.id}`)).body.project.lastVideo.jobId).toBe(newer);
    expect(page.url()).toContain(`/result/${newer}`); // 보고 있던 영상이 아니므로 이동하지 않는다
    await page.close();
  });

  it('보고 있던 영상을 지우면 남은 최신 영상으로 이동하고, 마지막 영상을 지우면 편집 화면으로 이동하며, 지운 주소는 찾을 수 없다고 안내한다', async () => {
    const { project, firstJob } = await projectWithVideo('이동 확인');
    const newer = cloneJob(firstJob, { minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await items(page).first().waitFor();
    await openDeleteDialog(page, newer);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await page.waitForURL(`**/projects/${project.id}/result/${firstJob}`);
    await page.locator(`[data-screen=result]`).waitFor();

    const gone = await env.newPage();
    await gone.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await gone.locator('text=영상을 찾을 수 없어요').waitFor();
    await gone.close();

    await items(page).first().waitFor();
    await openDeleteDialog(page, firstJob);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await page.waitForURL(`**/projects/${project.id}`);
    expect((await api(`/api/projects/${project.id}`)).body.project.lastVideo).toBeNull();
    await page.close();
  });

  it('진행 중인 영상 B를 보는 동안 이전 영상 A를 지워도 B의 화면과 갱신이 유지된다', async () => {
    const { project, firstJob } = await projectWithVideo('진행 중 유지');
    const B = cloneJob(firstJob, { status: 'generating', minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${B}`);
    await page.locator('[data-screen=result][data-status=generating]').waitFor();
    await openDeleteDialog(page, firstJob);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await items(page).count()) === 0, 'A가 목록에서 사라짐');
    expect(page.url()).toContain(`/result/${B}`);
    expect(await page.locator('[data-screen=result]').getAttribute('data-status')).toBe('generating');
    // 폴링이 이어지는지: 서버에서 B를 완성 처리하면 화면이 따라온다
    db().prepare(`UPDATE render_jobs SET status = 'done', step = 3, video_file = ?, finished_at = ? WHERE id = ?`).run('x', new Date().toISOString(), B);
    const dir = path.join(env.dataDir, 'videos', project.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${B}.mp4`), 'x');
    await page.locator('[data-screen=result][data-status=done]').waitFor({ timeout: 8000 });
    await eventually(async () => (await items(page).count()) === 1, '완성된 B가 목록에 나타남');
    await page.close();
  });

  it('삭제 전에 보낸 목록 조회가 삭제 뒤에 늦게 도착해도 지워진 영상이 되살아나지 않는다', async () => {
    const { project, firstJob } = await projectWithVideo('늦은 조회');
    const B = cloneJob(firstJob, { status: 'generating', minutesAgo: -1 });
    const page = await env.newPage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = 0;
    // 두 번째 목록 조회(B가 완성됐을 때의 새로고침)를 응답은 지금 받아 두고 전달은 미룬다 — 그 응답에는 A가 들어 있다.
    await page.route(listUrl, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      held++;
      if (held < 2) return route.continue();
      const response = await route.fetch();
      await gate;
      await route.fulfill({ response });
    });
    await page.goto(`${env.base}/projects/${project.id}/result/${B}`);
    await items(page).first().waitFor();
    db().prepare(`UPDATE render_jobs SET status = 'done', step = 3, video_file = ?, finished_at = ? WHERE id = ?`).run('x', new Date().toISOString(), B);
    fs.writeFileSync(path.join(env.dataDir, 'videos', project.id, `${B}.mp4`), 'x');
    await eventually(async () => held >= 2, '두 번째 조회가 대기 중');
    await openDeleteDialog(page, firstJob);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await page.locator(`[data-id="${firstJob}"]`).count()) === 0, 'A가 사라짐');
    release();
    await new Promise((r) => setTimeout(r, 600));
    expect(await page.locator(`[data-id="${firstJob}"]`).count()).toBe(0); // 늦은 응답이 A를 되살리지 않았다
    await page.close();
  });

  it('다른 영상으로 이동한 뒤에 이전 영상의 늦은 상태 응답이 도착해도 화면을 덮어쓰지 않는다', async () => {
    const { project, firstJob } = await projectWithVideo('늦은 상태 응답');
    const B = cloneJob(firstJob, { status: 'generating', minutesAgo: -1 });
    const page = await env.newPage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let polls = 0;
    await page.route((u) => u.pathname === `/api/projects/${project.id}/renders/${B}`, async (route) => {
      polls++;
      if (polls < 2) return route.continue(); // 처음 불러오기는 그대로
      const response = await route.fetch(); // 두 번째(첫 폴링)는 '진행 중' 응답을 받아 두고 전달을 미룬다
      await gate;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.goto(`${env.base}/projects/${project.id}/result/${B}`);
    await page.locator('[data-screen=result][data-status=generating]').waitFor();
    await eventually(async () => polls >= 2, '첫 폴링이 대기 중');
    await page.locator(`[data-id="${firstJob}"] a:has-text("보기")`).click();
    await page.waitForURL(`**/result/${firstJob}`);
    await page.locator('[data-screen=result][data-status=done]').waitFor();
    release();
    await new Promise((r) => setTimeout(r, 700));
    expect(await page.locator('[data-screen=result]').getAttribute('data-status')).toBe('done'); // 이전 영상(B)의 응답이 덮어쓰지 않았다
    await page.close();
  });

  it('다른 화면에서 이미 지운 영상을 지우려 하면 안내하고 목록을 새로 읽는다', async () => {
    const { project, firstJob } = await projectWithVideo('중복 삭제');
    const newer = cloneJob(firstJob, { minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await items(page).first().waitFor();
    await openDeleteDialog(page, firstJob);
    expect((await api(`/api/projects/${project.id}/renders/${firstJob}`, { method: 'DELETE' })).status).toBe(200); // 다른 화면에서 먼저 지움
    await page.locator('[data-testid=confirm-delete-video]').click();
    await page.locator('.toast:has-text("이미 삭제된 영상이에요")').waitFor();
    await eventually(async () => (await items(page).count()) === 1, '목록이 새로 읽혀 1편');
    expect(page.url()).toContain(`/result/${newer}`);
    await page.close();
  });

  it('삭제 응답이 시간 안에 오지 않으면 모든 삭제를 막고, 다시 확인해 지워지지 않았음이 확인되면 풀린다', async () => {
    const { project, firstJob } = await projectWithVideo('시간 초과 미삭제');
    const newer = cloneJob(firstJob, { minutesAgo: -1 });
    const page = await env.newPage();
    await shortTimeout(page);
    await page.route(deleteUrl, (route) => (route.request().method() === 'DELETE' ? undefined : route.continue())); // 요청이 서버에 닿지 않는다
    await page.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await items(page).first().waitFor();
    await openDeleteDialog(page, firstJob);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await page.locator('[data-testid=delete-unknown]').waitFor({ timeout: 6000 });
    const buttons = page.locator('[data-testid=past-delete]');
    for (let i = 0; i < (await buttons.count()); i++) expect(await buttons.nth(i).isDisabled()).toBe(true);
    await page.locator('[data-testid=delete-unknown] button:has-text("다시 확인")').click();
    await page.locator('.toast:has-text("삭제되지 않았어요")').waitFor();
    expect(await page.locator('[data-testid=delete-unknown]').count()).toBe(0);
    expect(await buttons.first().isDisabled()).toBe(false);
    expect(await items(page).count()).toBe(2);
    expect(videoExists(project.id, firstJob)).toBe(true);
    await page.close();
  });

  it('삭제는 처리됐지만 응답을 못 받은 경우, 다시 확인하면 삭제됨으로 확정하고, 목록 재조회가 실패하면 불명확 상태를 유지한다', async () => {
    const { project, firstJob } = await projectWithVideo('시간 초과 삭제됨');
    const newer = cloneJob(firstJob, { minutesAgo: -1 });
    const page = await env.newPage();
    await shortTimeout(page);
    await page.route(deleteUrl, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      await route.fetch(); // 서버는 처리한다
      // 응답은 돌려주지 않는다
    });
    await page.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await items(page).first().waitFor();
    await openDeleteDialog(page, firstJob);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await page.locator('[data-testid=delete-unknown]').waitFor({ timeout: 6000 });
    expect(videoExists(project.id, firstJob)).toBe(false);

    // 목록을 읽지 못하면 확정하지 않는다
    await page.route(listUrl, (route) => route.abort());
    await page.locator('[data-testid=delete-unknown] button:has-text("다시 확인")').click();
    await new Promise((r) => setTimeout(r, 800));
    expect(await page.locator('[data-testid=delete-unknown]').count()).toBe(1);
    expect(await page.locator('[data-testid=past-delete]').first().isDisabled()).toBe(true);

    await page.unroute(listUrl);
    await page.locator('[data-testid=delete-unknown] button:has-text("다시 확인")').click();
    await page.locator('.toast:has-text("삭제됐어요")').waitFor();
    await eventually(async () => (await page.locator('[data-testid=delete-unknown]').count()) === 0, '불명확 상태 해제');
    expect(await page.locator(`[data-id="${firstJob}"]`).count()).toBe(0);
    await page.close();
  });
});
