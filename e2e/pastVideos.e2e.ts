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

  it('삭제 응답을 기다리는 동안 다른 영상으로 이동했다면, 늦게 도착한 삭제 응답이 사용자를 다시 이동시키지 않는다(코덱스 검수 P2)', async () => {
    const { project, firstJob } = await projectWithVideo('늦은 삭제 응답');
    const C = firstJob;
    const A = cloneJob(firstJob, { minutesAgo: 5 }); // 지금 보는 영상, 지울 영상
    const B = cloneJob(firstJob, { minutesAgo: -1 }); // 가장 최근 — 버그가 있으면 여기로 끌려간다
    const page = await env.newPage();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let seen = false;
    await page.route(deleteUrl, async (route) => {
      if (route.request().method() !== 'DELETE') return route.continue();
      seen = true;
      const response = await route.fetch(); // 서버는 바로 지운다
      await gate; // 응답은 사용자가 옮겨 간 뒤에 전달한다
      await route.fulfill({ response }).catch(() => undefined);
    });
    await page.goto(`${env.base}/projects/${project.id}/result/${A}`);
    await items(page).first().waitFor();
    await openDeleteDialog(page, A);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => seen, '삭제 요청이 보내짐');
    await page.locator(`[data-id="${C}"] a`).first().click(); // 응답을 기다리는 중에 C 로 이동
    await page.waitForURL(`**/result/${C}`);
    await page.locator('[data-screen=result][data-status=done]').waitFor();
    release();
    await new Promise((r) => setTimeout(r, 800));
    expect(page.url()).toContain(`/result/${C}`); // B 로 끌려가지 않았다
    expect(page.url()).not.toContain(B);
    expect(videoExists(project.id, A)).toBe(false); // 삭제 자체는 처리됐다
    await page.close();
  });

  it('보고 있지 않은 영상을 지운 뒤 초점이 문서 맨 앞으로 빠지지 않고, 반복되는 버튼은 영상을 구별하는 이름을 가진다(코덱스 검수)', async () => {
    const { project, firstJob } = await projectWithVideo('초점과 이름');
    const newer = cloneJob(firstJob, { minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newer}`);
    await items(page).first().waitFor();
    const labels = await page.locator('[data-testid=past-item] [aria-label]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
    expect(labels.length).toBe(5); // 보기(지금 보는 영상은 없음)·다운로드·삭제 = 2 + 3
    const deleteLabels = labels.filter((l) => l.endsWith('삭제'));
    expect(new Set(deleteLabels).size).toBe(deleteLabels.length); // 이름만으로 버튼을 구별할 수 있다
    expect(deleteLabels.every((l) => /\d+초 영상/.test(l))).toBe(true);

    await page.locator(`[data-id="${firstJob}"] [data-testid=past-delete]`).focus();
    await page.keyboard.press('Enter'); // 키보드로 연다
    await page.locator('[role=dialog]').waitFor();
    await page.keyboard.press('Tab'); // 취소 → 삭제
    await page.keyboard.press('Enter');
    await eventually(async () => (await items(page).count()) === 1, '목록에서 사라짐');
    await eventually(async () => page.evaluate(() => document.activeElement !== document.body && !!document.activeElement?.closest('[data-testid=past-videos]')), '초점이 목록 안에 있음');
    // 키보드로 조작 중이므로 초점 위치가 눈에 보여야 한다(outline 이 없으면 안 됨)
    expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle)).not.toBe('none');
    await page.close();
  });

  it('후속: 이미 "더 보기"로 펼친 목록은 영상을 지워도 접히지 않고, 남은 영상이 더 있으면 "더 보기"가 남는다', async () => {
    const { project, firstJob } = await projectWithVideo('펼친 목록 유지');
    const all = [firstJob];
    for (let i = 1; i <= 14; i++) all.push(cloneJob(firstJob, { minutesAgo: 2000 - i * 10 })); // 15편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 3000 * 60_000).toISOString(), new Date(Date.now() - 3000 * 60_000).toISOString(), firstJob);
    const newest = all[14]!;
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newest}`);
    await items(page).first().waitFor();
    expect(await items(page).count()).toBe(10);
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 15, '더 보기 후 15편');
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);

    // 펼친 목록 안(두 번째 페이지)의 영상을 지운다 — 접히지 않아야 한다
    const victim = all[2]!;
    await openDeleteDialog(page, victim);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await page.locator(`[data-id="${victim}"]`).count()) === 0, '지운 영상이 사라짐');
    expect(await items(page).count()).toBe(14); // 15 - 1, 첫 페이지(10개)로 접히지 않았다
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);
    expect(new Set(await ids(page)).size).toBe(14);
    await page.close();
  });

  it('후속 검수 P2: 펼친 목록을 보는 동안 다른 곳에서 새 영상이 완성돼도, 삭제 뒤 새 영상이 누락되지 않고 "더 보기"로 끝까지 이어진다', async () => {
    const { project, firstJob } = await projectWithVideo('새 영상 누락 방지');
    const all = [firstJob];
    for (let i = 1; i <= 14; i++) all.push(cloneJob(firstJob, { minutesAgo: 2000 - i * 10 })); // 15편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 3000 * 60_000).toISOString(), new Date(Date.now() - 3000 * 60_000).toISOString(), firstJob);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${all[14]}`);
    await items(page).first().waitFor();
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 15, '15편 모두 펼침');

    const fresh = cloneJob(firstJob, { minutesAgo: -5 }); // 다른 화면에서 가장 최근 영상이 새로 완성됨(이 화면은 모른다)
    const victim = all[3]!;
    await openDeleteDialog(page, victim);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await page.locator(`[data-id="${victim}"]`).count()) === 0, '지운 영상이 사라짐');

    expect((await ids(page))[0]).toBe(fresh); // 새 영상이 맨 위에 나타난다
    // 서버에는 15편(15 - 1 + 새 영상 1)이 있다 — 화면이 일부만 보이더라도 "더 보기"로 전부 닿을 수 있어야 한다
    for (let i = 0; i < 3 && (await page.locator('[data-testid=past-more]').count()) > 0; i++) {
      await page.locator('[data-testid=past-more]').click();
      await new Promise((r) => setTimeout(r, 300));
    }
    await eventually(async () => (await items(page).count()) === 15, '서버의 15편이 모두 보임');
    const seen = await ids(page);
    expect(new Set(seen).size).toBe(15);
    expect(seen).toContain(fresh);
    expect(seen).not.toContain(victim);
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);
    await page.close();
  });

  it('후속 검수 P2(재): 펼친 범위 안쪽(11번째 이후)을 다른 탭이 지운 뒤 여기서도 지워도, 화면이 서버와 정확히 같고 실제 영상이 빠지지 않는다', async () => {
    const { project, firstJob } = await projectWithVideo('안쪽 삭제 정합');
    const all = [firstJob];
    for (let i = 1; i <= 20; i++) all.push(cloneJob(firstJob, { minutesAgo: 2000 - i * 10 })); // 21편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 3000 * 60_000).toISOString(), new Date(Date.now() - 3000 * 60_000).toISOString(), firstJob);
    const newest = all[20]!;
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newest}`);
    await items(page).first().waitFor();
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 20, '최신 20편 펼침');

    const other = all[9]!; // 최신순 12번째 — 첫 페이지 밖
    expect((await api(`/api/projects/${project.id}/renders/${other}`, { method: 'DELETE' })).status).toBe(200); // 다른 탭의 삭제
    const victim = all[18]!; // 최신순 3번째
    await openDeleteDialog(page, victim);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await page.locator(`[data-id="${victim}"]`).count()) === 0, '지운 영상이 사라짐');

    const server = ((await api(`/api/projects/${project.id}/renders?limit=50`)).body.list.items as Array<{ id: string }>).map((i) => i.id);
    expect(server.length).toBe(19);
    await eventually(async () => JSON.stringify(await ids(page)) === JSON.stringify(server), '화면이 서버와 같음');
    expect(await page.locator(`[data-id="${other}"]`).count()).toBe(0); // 다른 탭이 지운 영상이 남지 않는다
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);
    await page.close();
  });

  it('후속 검수 P2(4차): 삭제 한 번에 서버 요청은 하나뿐이고(목록을 따로 다시 읽지 않는다), 시계 역행으로 목록 한가운데에 끼어든 영상도 화면에 정확히 반영된다', async () => {
    const { project, firstJob } = await projectWithVideo('단일 응답 일관성');
    const all = [firstJob];
    for (let i = 1; i <= 20; i++) all.push(cloneJob(firstJob, { minutesAgo: 3000 - i * 10 })); // 21편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 4000 * 60_000).toISOString(), new Date(Date.now() - 4000 * 60_000).toISOString(), firstJob);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${all[20]}`);
    await items(page).first().waitFor();
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 20, '최신 20편 펼침');

    // 다른 탭의 변화: 시계가 뒤로 가서 "나중에 완성된" 영상의 finished_at 이 기존 영상 사이(최신순 약 8번째)에 끼어든다 + 안쪽 영상 하나 삭제
    const middle = cloneJob(firstJob, { minutesAgo: 3000 - 13 * 10 - 5 });
    const inner = all[6]!; // 최신순 15번째
    expect((await api(`/api/projects/${project.id}/renders/${inner}`, { method: 'DELETE' })).status).toBe(200);

    const requests: string[] = [];
    page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`));
    const victim = all[18]!;
    await openDeleteDialog(page, victim);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await page.locator(`[data-id="${victim}"]`).count()) === 0, '지운 영상이 사라짐');
    await new Promise((r) => setTimeout(r, 600));
    expect(requests.filter((r) => r.startsWith('DELETE'))).toHaveLength(1);
    expect(requests.filter((r) => r.startsWith('GET') && /\/renders\?/.test(r))).toEqual([]); // 삭제 뒤 목록을 따로 다시 읽는 요청이 없다

    const server = ((await api(`/api/projects/${project.id}/renders?limit=50`)).body.list.items as Array<{ id: string }>).map((i) => i.id);
    const shown = await ids(page);
    expect(shown).toEqual(server.slice(0, shown.length)); // 한가운데에 끼어든 영상 포함, 지워진 안쪽 영상 제외
    expect(shown).toContain(middle);
    expect(shown).not.toContain(inner);
    expect(shown.length).toBe(19); // 펼쳐 둔 20개에서 지운 하나를 뺀 개수를 서버가 한 번에 돌려준다(서버는 총 20편)
    expect(await page.locator('[data-testid=past-more]').count()).toBe(1); // 나머지 1편은 "더 보기"로
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 20, '더 보기로 20편');
    expect(await ids(page)).toEqual(server);
    await page.close();
  });

  it('후속 검수 P2(재): 서버 목록이 비면 캐시에 남은 삭제된 항목도 사라진다', async () => {
    const { project, firstJob } = await projectWithVideo('빈 목록 정합');
    const C = cloneJob(firstJob, { minutesAgo: 5 });
    const B = cloneJob(firstJob, { status: 'generating', minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${B}`); // 진행 중 B를 본다 — 목록은 C, firstJob
    await page.locator('[data-screen=result][data-status=generating]').waitFor();
    await eventually(async () => (await items(page).count()) === 2, '목록 두 편');
    expect((await api(`/api/projects/${project.id}/renders/${firstJob}`, { method: 'DELETE' })).status).toBe(200); // 다른 탭이 firstJob 을 지움
    await openDeleteDialog(page, C);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await items(page).count()) === 0, '캐시에 남은 항목 없이 목록이 비어 사라짐');
    await page.close();
  });

  it('후속: 첫 페이지에서 지우면 첫 페이지가 다시 채워지고 "더 보기"가 남으며, 누르면 빠짐없이 이어진다', async () => {
    const { project, firstJob } = await projectWithVideo('첫 페이지 삭제');
    const all = [firstJob];
    for (let i = 1; i <= 14; i++) all.push(cloneJob(firstJob, { minutesAgo: 2000 - i * 10 })); // 15편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 3000 * 60_000).toISOString(), new Date(Date.now() - 3000 * 60_000).toISOString(), firstJob);
    const newest = all[14]!;
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${newest}`);
    await items(page).first().waitFor();
    const victim = all[13]!; // 최신순 두 번째
    await openDeleteDialog(page, victim);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await page.locator(`[data-id="${victim}"]`).count()) === 0, '지운 영상이 사라짐');
    expect(await items(page).count()).toBe(10); // 첫 페이지가 서버의 새 첫 페이지(10개)로 다시 채워진다
    expect(await page.locator('[data-testid=past-more]').count()).toBe(1); // 14편 중 10편만 보이므로 더 있다
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 14, '이어서 14편');
    expect(new Set(await ids(page)).size).toBe(14); // 겹치거나 빠지지 않는다
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);
    await page.close();
  });

  it('후속: 이전 영상 목록이 비면 초점이 문서 맨 앞으로 빠지지 않고 "구성 장면" 제목으로 간다', async () => {
    const { project, firstJob } = await projectWithVideo('빈 목록 초점');
    const B = cloneJob(firstJob, { status: 'generating', minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${B}`); // 진행 중 B를 보고 있어 목록에는 A만 있다
    await page.locator('[data-screen=result][data-status=generating]').waitFor();
    await items(page).first().waitFor();
    await openDeleteDialog(page, firstJob);
    await page.locator('[data-testid=confirm-delete-video]').click();
    await eventually(async () => (await items(page).count()) === 0, '목록이 비어 사라짐');
    await eventually(async () => page.evaluate(() => document.activeElement?.tagName === 'H3' && !!document.activeElement.textContent?.includes('구성 장면')), '초점이 구성 장면 제목에 있음');
    await page.close();
  });

  it('후속: 같은 분에 만든 같은 길이의 영상도 버튼 이름이 서로 다르다', async () => {
    const { project, firstJob } = await projectWithVideo('같은 분 같은 길이');
    const a = cloneJob(firstJob, { minutesAgo: 1 });
    const b = cloneJob(firstJob, { minutesAgo: 1 }); // 시각·길이가 같다
    db().prepare(`UPDATE render_jobs SET created_at = (SELECT created_at FROM render_jobs WHERE id = ?), finished_at = (SELECT finished_at FROM render_jobs WHERE id = ?) WHERE id = ?`).run(a, a, b);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${firstJob}`);
    await items(page).first().waitFor();
    const labels = await page.locator('[data-testid=past-delete]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!));
    expect(labels.length).toBe(3);
    expect(new Set(labels).size).toBe(3); // 같은 시각·길이여도 최신순 번호로 구별된다
    expect(labels.every((l) => l.endsWith('삭제'))).toBe(true); // 눈에 보이는 글자("삭제")를 이름에 포함
    await page.close();
  });

  it('복구 경로: 펼친 상태에서 다른 탭이 먼저 지운 영상을 지우려 하면(404) 목록을 다시 읽어도 첫 페이지로 접히지 않는다', async () => {
    const { project, firstJob } = await projectWithVideo('404 뒤 펼친 목록');
    const all = [firstJob];
    for (let i = 1; i <= 14; i++) all.push(cloneJob(firstJob, { minutesAgo: 2000 - i * 10 })); // 15편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 3000 * 60_000).toISOString(), new Date(Date.now() - 3000 * 60_000).toISOString(), firstJob);
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${all[14]}`);
    await items(page).first().waitFor();
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 15, '15편 펼침');
    const victim = all[3]!; // 최신순 12번째 — 두 번째 페이지
    await openDeleteDialog(page, victim);
    expect((await api(`/api/projects/${project.id}/renders/${victim}`, { method: 'DELETE' })).status).toBe(200); // 다른 탭이 먼저 지움
    await page.locator('[data-testid=confirm-delete-video]').click();
    await page.locator('.toast:has-text("이미 삭제된 영상이에요")').waitFor();
    await eventually(async () => (await page.locator(`[data-id="${victim}"]`).count()) === 0, '목록을 다시 읽음');
    expect(await items(page).count()).toBe(14); // 10개로 접히지 않고 남은 14편이 모두 보인다
    expect(await page.locator('[data-testid=past-more]').count()).toBe(0);
    await page.close();
  });

  it('복구 경로: 보고 있던 작업이 완성돼 목록을 다시 읽어도, 펼쳐 둔 목록이 첫 페이지로 접히지 않는다', async () => {
    const { project, firstJob } = await projectWithVideo('완성 뒤 펼친 목록');
    const all = [firstJob];
    for (let i = 1; i <= 14; i++) all.push(cloneJob(firstJob, { minutesAgo: 2000 - i * 10 })); // 완성 15편
    db().prepare(`UPDATE render_jobs SET created_at = ?, finished_at = ? WHERE id = ?`).run(new Date(Date.now() - 3000 * 60_000).toISOString(), new Date(Date.now() - 3000 * 60_000).toISOString(), firstJob);
    const B = cloneJob(firstJob, { status: 'generating', minutesAgo: -1 });
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/${project.id}/result/${B}`);
    await page.locator('[data-screen=result][data-status=generating]').waitFor();
    await items(page).first().waitFor();
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 15, '15편 펼침');
    // B 가 완성된다 → 화면이 목록을 다시 읽는다
    db().prepare(`UPDATE render_jobs SET status = 'done', step = 3, video_file = ?, finished_at = ? WHERE id = ?`).run('x', new Date().toISOString(), B);
    fs.writeFileSync(path.join(env.dataDir, 'videos', project.id, `${B}.mp4`), 'x');
    await page.locator('[data-screen=result][data-status=done]').waitFor({ timeout: 8000 });
    await eventually(async () => (await page.locator(`[data-id="${B}"]`).count()) === 1, '완성된 B가 목록에 나타남');
    expect(await items(page).count()).toBe(15); // 펼쳐 둔 개수만큼 다시 읽었다(10개로 접히지 않음)
    expect((await ids(page))[0]).toBe(B);
    expect(await page.locator('[data-testid=past-more]').count()).toBe(1); // 16편 중 15편 — 나머지 1편은 "더 보기"
    await page.locator('[data-testid=past-more]').click();
    await eventually(async () => (await items(page).count()) === 16, '더 보기로 16편');
    expect(new Set(await ids(page)).size).toBe(16);
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
