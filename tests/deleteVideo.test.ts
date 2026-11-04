import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSampleProject } from '../server/seed';
import { imageDecodeFailed } from '../server/render/errors';
import { solidPng } from '../server/solidPng';
import { FakeRenderer, makeApp, waitFor } from './helpers';

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
});

async function setup(opts: { auto?: boolean } = {}) {
  const renderer = new FakeRenderer();
  renderer.auto = opts.auto ?? true;
  const a = await makeApp(undefined, { renderer });
  apps.push(a.app);
  const project = createSampleProject(a.store);
  return { ...a, renderer, project };
}
type A = Awaited<ReturnType<typeof setup>>;

const tick = () => new Promise((r) => setTimeout(r, 6)); // 시각(밀리초) 비교가 같은 값이 되지 않게 한다
const db = (a: { store: any }) => a.store.db;
const getProject = (a: A, id = a.project.id) => a.store.getProject(id);
const projectRow = (a: A, id = a.project.id) => db(a).prepare(`SELECT status, updated_at FROM projects WHERE id = ?`).get(id) as { status: string; updated_at: string };
const del = (a: A, jobId: string, projectId = a.project.id) => a.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/renders/${jobId}` });
const list = async (a: A, q = '', projectId = a.project.id) => a.app.inject({ url: `/api/projects/${projectId}/renders${q}` });

/** 영상을 한 편 만들고 완료될 때까지 기다린다. */
async function render(a: A, projectId = a.project.id): Promise<string> {
  const res = await a.app.inject({ method: 'POST', url: `/api/projects/${projectId}/renders` });
  expect(res.statusCode).toBe(202);
  const id = res.json().job.id as string;
  await waitFor(async () => {
    const j = (await a.app.inject({ url: `/api/renders/${id}` })).json().job;
    return j.status === 'done' || j.status === 'failed' ? j : null;
  }, '작업 종료');
  await tick();
  return id;
}
const jobRow = (a: A, id: string) => db(a).prepare(`SELECT * FROM render_jobs WHERE id = ?`).get(id);
const linkedImages = (a: A, jobId: string) => (db(a).prepare(`SELECT image_id FROM render_job_images WHERE job_id = ?`).all(jobId) as Array<{ image_id: string }>).map((r) => r.image_id);
const videoFile = (a: A, jobId: string, projectId = a.project.id) => a.renders.videoPathFor(projectId, jobId);
const imageRow = (a: A, id: string) => !!db(a).prepare(`SELECT 1 FROM images WHERE id = ?`).get(id);
const imagePath = (a: A, id: string) => {
  const r = db(a).prepare(`SELECT project_id, stored_name FROM images WHERE id = ?`).get(id) as { project_id: string; stored_name: string } | undefined;
  return r ? a.store.imagePath(r.project_id, r.stored_name) : null;
};
/** 장면의 이미지를 새 파일로 바꾼다. 바꾸기 전 이미지 id 를 돌려준다. */
async function replaceImage(a: A, position: number, color: [number, number, number]) {
  const before = getProject(a).scenes[position]!.image!.id;
  a.store.attachImage(a.project.id, position, solidPng(64, 36, color), `new${position}.png`);
  await tick();
  return before;
}

describe('지난 영상 목록', () => {
  it('완성된 영상만 최신순으로 돌려주고, 실패·진행 중인 작업은 넣지 않는다', async () => {
    const a = await setup();
    const first = await render(a);
    a.renderer.failWith = imageDecodeFailed(1);
    const failed = await render(a);
    a.renderer.failWith = null;
    const second = await render(a);
    const res = await list(a);
    expect(res.statusCode).toBe(200);
    const l = res.json().list;
    expect(l.items.map((i: any) => i.id)).toEqual([second, first]); // 실패(failed)는 없다
    expect(l.total).toBe(2);
    expect(l.hasMore).toBe(false);
    expect(l.items[0]).toMatchObject({ totalSec: 30, sceneCount: 3, outdated: false, videoUrl: `/api/renders/${second}/video`, downloadUrl: `/api/renders/${second}/video?download=1` });
    expect(failed).not.toBe(first);
  });

  it('limit 과 before 로 나누어 읽고 hasMore·total 이 맞다', async () => {
    const a = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await render(a));
    const newest = [...ids].reverse();
    const p1 = (await list(a, '?limit=2')).json().list;
    expect(p1.items.map((i: any) => i.id)).toEqual(newest.slice(0, 2));
    expect(p1.hasMore).toBe(true);
    expect(p1.total).toBe(5);
    const p2 = (await list(a, `?limit=2&before=${p1.items[1].id}`)).json().list;
    expect(p2.items.map((i: any) => i.id)).toEqual(newest.slice(2, 4));
    expect(p2.hasMore).toBe(true);
    const p3 = (await list(a, `?limit=2&before=${p2.items[1].id}`)).json().list;
    expect(p3.items.map((i: any) => i.id)).toEqual(newest.slice(4));
    expect(p3.hasMore).toBe(false);
  });

  it('잘못된 limit 은 400, 없는 프로젝트는 404, 이미 지워진 기준 영상(before)은 404', async () => {
    const a = await setup();
    const id = await render(a);
    expect((await list(a, '?limit=0')).statusCode).toBe(400);
    expect((await list(a, '?limit=51')).statusCode).toBe(400);
    expect((await list(a, '?before=not-an-id')).statusCode).toBe(400);
    expect((await list(a, '', '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await del(a, id)).statusCode).toBe(200);
    const gone = await list(a, `?before=${id}`);
    expect(gone.statusCode).toBe(404); // 처음부터 다시 읽게 한다
  });

  it('다른 프로젝트의 영상은 목록에 섞이지 않고, before 로도 쓸 수 없다', async () => {
    const a = await setup();
    const mine = await render(a);
    const other = createSampleProject(a.store);
    const theirs = await render(a, other.id);
    expect((await list(a)).json().list.items.map((i: any) => i.id)).toEqual([mine]);
    expect((await list(a, `?before=${theirs}`)).statusCode).toBe(404);
  });

  it('같은 시각에 끝난 영상들도 목록·페이지·lastVideo 가 rowid 로 일관되게 정렬된다', async () => {
    const a = await setup();
    const ids = [await render(a), await render(a), await render(a)];
    db(a).prepare(`UPDATE render_jobs SET finished_at = '2026-01-01T00:00:00.000Z' WHERE project_id = ?`).run(a.project.id);
    const newest = [...ids].reverse(); // 같은 시각이면 rowid 가 큰(나중에 만든) 쪽이 먼저
    const all = (await list(a)).json().list.items.map((i: any) => i.id);
    expect(all).toEqual(newest);
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = (await list(a, `?limit=1${before ? `&before=${before}` : ''}`)).json().list;
      seen.push(page.items[0].id);
      before = page.items[0].id;
    }
    expect(seen).toEqual(newest); // 한 개씩 읽어도 빠지거나 겹치지 않는다
    expect(getProject(a).lastVideo!.jobId).toBe(newest[0]); // 대체로 보여 줄 영상도 목록 첫 항목과 같다
  });
});

describe('영상 삭제', () => {
  it('완성된 영상을 지우면 작업 기록·영상 파일·이미지 연결이 사라지고, 갱신된 목록과 lastVideo 를 돌려준다. 다시 지우면 404', async () => {
    const a = await setup();
    const keep = await render(a);
    const target = await render(a);
    expect(fs.existsSync(videoFile(a, target))).toBe(true);
    const res = await del(a, target);
    expect(res.statusCode).toBe(200);
    expect(jobRow(a, target)).toBeUndefined();
    expect(linkedImages(a, target)).toEqual([]);
    expect(fs.existsSync(videoFile(a, target))).toBe(false);
    expect(fs.existsSync(videoFile(a, keep))).toBe(true);
    expect(res.json().list.items.map((i: any) => i.id)).toEqual([keep]);
    expect(res.json().lastVideo.jobId).toBe(keep);
    expect((await del(a, target)).statusCode).toBe(404);
  });

  it('프로젝트 삭제 응답이 아닌 영상 삭제는 `projects.updated_at` 을 바꾸지 않아 남은 영상이 outdated 로 바뀌지 않는다', async () => {
    const a = await setup();
    await render(a);
    const target = await render(a);
    const before = projectRow(a).updated_at;
    await del(a, target);
    expect(projectRow(a).updated_at).toBe(before);
    expect((await list(a)).json().list.items.every((i: any) => i.outdated === false)).toBe(true);
  });

  it('이 영상에만 쓰이던 이전 이미지는 회수하고, 현재 장면이 쓰는 이미지와 다른 영상이 공유하는 이미지는 남긴다', async () => {
    const a = await setup();
    const s = getProject(a).scenes.map((x) => x.image!.id); // I0 I1 I2
    const A = await render(a); // 참조: I0 I1 I2
    const i0 = await replaceImage(a, 0, [200, 10, 10]); // I0 → I3 (I0 는 A 가 참조)
    expect(i0).toBe(s[0]);
    const B = await render(a); // 참조: I3 I1 I2
    expect(imageRow(a, s[0]!)).toBe(true); // A 가 있어 남아 있다

    expect((await del(a, A)).statusCode).toBe(200);
    expect(imageRow(a, s[0]!)).toBe(false); // 이제 아무도 안 쓰는 I0 는 회수
    expect(imagePath(a, s[0]!)).toBeNull();
    for (const id of [s[1]!, s[2]!]) {
      expect(imageRow(a, id)).toBe(true); // B 와 현재 장면이 쓴다
      expect(fs.existsSync(imagePath(a, id)!)).toBe(true);
    }
    const i3 = getProject(a).scenes[0]!.image!.id;
    expect(imageRow(a, i3)).toBe(true);

    // B 를 지워도 현재 장면이 쓰는 이미지는 남는다
    expect((await del(a, B)).statusCode).toBe(200);
    for (const id of [i3, s[1]!, s[2]!]) expect(fs.existsSync(imagePath(a, id)!)).toBe(true);
  });

  it('두 영상이 공유한 이미지는 하나를 지워도 남고, 마지막 참조가 사라지고 장면도 안 쓰면 회수된다', async () => {
    const a = await setup();
    const s = getProject(a).scenes.map((x) => x.image!.id);
    const A = await render(a); // I0 I1 I2
    const B = await render(a); // I0 I1 I2 (같은 이미지를 공유)
    await replaceImage(a, 1, [10, 200, 10]); // 현재 장면의 I1 → I3 (I1 은 A, B 가 참조)
    await del(a, A);
    expect(imageRow(a, s[1]!)).toBe(true); // B 가 아직 참조
    await del(a, B);
    expect(imageRow(a, s[1]!)).toBe(false); // 마지막 참조(B)가 사라졌고 장면도 안 씀
    expect(imageRow(a, s[0]!)).toBe(true); // 현재 장면이 쓴다
  });

  it('진행 중인 영상은 지울 수 없고(409), 실패한 작업 기록도 거절하며(409), 다른 프로젝트의 영상은 404', async () => {
    const a = await setup({ auto: false });
    const gen = (await a.app.inject({ method: 'POST', url: `/api/projects/${a.project.id}/renders` })).json().job.id as string;
    await waitFor(async () => (await a.app.inject({ url: `/api/renders/${gen}` })).json().job.status === 'generating', '생성 중');
    const busy = await del(a, gen);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('RENDER_NOT_DELETABLE');
    expect(jobRow(a, gen)).toBeDefined();
    a.renderer.fail(imageDecodeFailed(1));
    await waitFor(async () => (await a.app.inject({ url: `/api/renders/${gen}` })).json().job.status === 'failed', '실패');
    const failed = await del(a, gen);
    expect(failed.statusCode).toBe(409);
    expect(failed.json().error.code).toBe('RENDER_NOT_DELETABLE');
    expect(jobRow(a, gen)).toBeDefined();

    a.renderer.auto = true;
    const other = createSampleProject(a.store);
    const theirs = await render(a, other.id);
    const wrong = await del(a, theirs); // 내 프로젝트 경로로 다른 프로젝트의 작업을 지우려 한다
    expect(wrong.statusCode).toBe(404);
    expect(jobRow(a, theirs)).toBeDefined();
    expect(fs.existsSync(videoFile(a, theirs, other.id))).toBe(true);
  });

  it('다른 영상을 만드는 중에 이전 영상을 지워도 진행 중인 작업과 공유 이미지, 프로젝트 상태가 유지된다', async () => {
    const a = await setup();
    const A = await render(a);
    a.renderer.auto = false;
    const B = (await a.app.inject({ method: 'POST', url: `/api/projects/${a.project.id}/renders` })).json().job.id as string;
    await waitFor(async () => (await a.app.inject({ url: `/api/renders/${B}` })).json().job.status === 'generating', 'B 생성 중');
    const sharedImages = linkedImages(a, B);
    expect((await del(a, A)).statusCode).toBe(200);
    expect(projectRow(a).status).toBe('generating'); // 활성 작업이 있으면 상태를 건드리지 않는다
    for (const id of sharedImages) expect(fs.existsSync(imagePath(a, id)!)).toBe(true); // B 와 장면이 참조
    a.renderer.release();
    await waitFor(async () => (await a.app.inject({ url: `/api/renders/${B}` })).json().job.status === 'done', 'B 완료');
    expect(projectRow(a).status).toBe('done');
    expect(fs.existsSync(videoFile(a, B))).toBe(true);
  });
});

describe('삭제 뒤 프로젝트 상태 · 대체 영상', () => {
  it('유일한 영상을 지우면 편집 중이 되고 lastVideo 는 비는다', async () => {
    const a = await setup();
    const only = await render(a);
    expect(projectRow(a).status).toBe('done');
    await del(a, only);
    expect(projectRow(a).status).toBe('editing');
    expect(getProject(a).lastVideo).toBeNull();
  });

  it('내용을 고친 뒤 만든 최신 영상을 지우면, 남은 이전 영상은 현재 내용보다 오래되어 편집 중이 된다', async () => {
    const a = await setup();
    const A = await render(a);
    await replaceImage(a, 0, [9, 9, 200]); // 내용 변경(updated_at 이 A 의 생성 시각보다 늦다)
    const B = await render(a);
    expect(projectRow(a).status).toBe('done');
    await del(a, B);
    expect(projectRow(a).status).toBe('editing');
    expect(getProject(a).lastVideo!.jobId).toBe(A);
    expect((await list(a)).json().list.items[0].outdated).toBe(true);
  });

  it('내용을 고치지 않았다면 최신 영상을 지워도 남은 영상이 현재 내용이라 완료로 남는다', async () => {
    const a = await setup();
    const A = await render(a);
    const B = await render(a);
    await del(a, B);
    expect(projectRow(a).status).toBe('done');
    expect(getProject(a).lastVideo!.jobId).toBe(A);
  });

  it('완료 A → 실패 B → 완료 C 에서 C 를 지우면 표시할 대체 영상은 A, 프로젝트 상태는 생성 순서상 최신인 B(실패)를 기준으로 한다', async () => {
    const a = await setup();
    const A = await render(a);
    a.renderer.failWith = imageDecodeFailed(1);
    const B = await render(a);
    a.renderer.failWith = null;
    const C = await render(a);
    expect(jobRow(a, B)).toMatchObject({ status: 'failed' });
    expect(projectRow(a).status).toBe('done');
    const before = projectRow(a).updated_at;
    expect((await del(a, C)).statusCode).toBe(200);
    expect(getProject(a).lastVideo!.jobId).toBe(A); // 대체로 보여 줄 영상 = 남은 완성 영상 중 최신
    expect(projectRow(a).status).toBe('failed'); // 상태 = 생성 순서상 최신 작업(B)의 결과
    expect(projectRow(a).updated_at).toBe(before);
  });
});

describe('삭제 응답의 목록 범위(keep)', () => {
  it('keep 으로 요청한 개수만큼 삭제와 같은 응답에서 돌려주고, 기본은 10개이며, 지운 영상은 빠져 있다', async () => {
    const a = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 13; i++) ids.push(await render(a));
    const newest = [...ids].reverse();
    const r15 = await a.app.inject({ method: 'DELETE', url: `/api/projects/${a.project.id}/renders/${newest[3]}?keep=15` });
    expect(r15.statusCode).toBe(200);
    const l15 = r15.json().list;
    expect(l15.items.map((i: any) => i.id)).toEqual(newest.filter((x) => x !== newest[3])); // 12편 전부, 지운 영상 없음
    expect(l15.total).toBe(12);
    expect(l15.hasMore).toBe(false);

    const r5 = await a.app.inject({ method: 'DELETE', url: `/api/projects/${a.project.id}/renders/${newest[0]}?keep=5` });
    const l5 = r5.json().list;
    expect(l5.items.length).toBe(5);
    expect(l5.hasMore).toBe(true);
    expect(l5.total).toBe(11);

    const rDefault = await a.app.inject({ method: 'DELETE', url: `/api/projects/${a.project.id}/renders/${newest[1]}` });
    expect(rDefault.json().list.items.length).toBe(10); // keep 을 안 보내면 기존처럼 첫 페이지 10개
  });

  it('잘못된 keep(0·201·글자)은 400 이고, 검증이 삭제보다 먼저라 영상은 지워지지 않는다', async () => {
    const a = await setup();
    const id = await render(a);
    for (const bad of ['0', '201', 'abc', '-1', '1.5']) {
      const res = await a.app.inject({ method: 'DELETE', url: `/api/projects/${a.project.id}/renders/${id}?keep=${bad}` });
      expect(res.statusCode, `keep=${bad}`).toBe(400);
    }
    expect(jobRow(a, id)).toBeDefined();
    expect(fs.existsSync(videoFile(a, id))).toBe(true);
    const ok = await a.app.inject({ method: 'DELETE', url: `/api/projects/${a.project.id}/renders/${id}?keep=200` }); // 상한은 허용
    expect(ok.statusCode).toBe(200);
  });
});

describe('파일 삭제 실패와 재시작 회수', () => {
  const lock = (target: string) => {
    const real = fs.rmSync;
    return vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p) === target) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real(p, o);
    }) as typeof fs.rmSync);
  };

  it('영상 파일을 지우지 못해도 삭제는 성공하고 이미지 회수는 계속되며, 다음 시작 때 파일이 정리된다', async () => {
    const a = await setup();
    const s = getProject(a).scenes.map((x) => x.image!.id);
    const A = await render(a);
    await replaceImage(a, 0, [1, 2, 3]);
    await render(a);
    const file = videoFile(a, A);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    lock(file);
    const res = await del(a, A);
    expect(res.statusCode).toBe(200); // 기록은 이미 사라졌다
    expect(jobRow(a, A)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true); // 파일은 남았다
    expect(imageRow(a, s[0]!)).toBe(false); // 이미지 회수는 영상 파일 실패와 무관하게 이어졌다
    expect(warn.mock.calls.some((c) => String(c[0]).includes(file) && String(c[0]).includes('EBUSY'))).toBe(true);

    vi.restoreAllMocks(); // 잠금이 풀렸다고 보고 "재시작": 같은 데이터 폴더로 새 앱을 연다
    const dataDir = a.dataDir;
    const restarted = await makeApp(dataDir);
    apps.push(restarted.app);
    expect(fs.existsSync(file)).toBe(false); // 고아 영상이 시작 시 정리됐다
  });

  it('이미지 파일 하나를 지우지 못해도 나머지 이미지는 계속 회수되고 삭제는 성공하며, 다음 시작 때 남은 파일이 정리된다', async () => {
    const a = await setup();
    const s = getProject(a).scenes.map((x) => x.image!.id);
    const A = await render(a); // I0 I1 I2
    await replaceImage(a, 0, [5, 5, 5]);
    await replaceImage(a, 1, [6, 6, 6]);
    await replaceImage(a, 2, [7, 7, 7]);
    await render(a); // 새 이미지 3장. A 만 I0 I1 I2 를 참조
    const files = s.map((id) => imagePath(a, id)!);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    lock(files[1]!); // 두 번째 이미지 파일만 지워지지 않는다
    const res = await del(a, A);
    expect(res.statusCode).toBe(200);
    for (const id of s) expect(imageRow(a, id)).toBe(false); // 세 이미지의 DB 행은 모두 정리
    expect(fs.existsSync(files[0]!)).toBe(false);
    expect(fs.existsSync(files[1]!)).toBe(true); // 잠긴 하나만 남는다
    expect(fs.existsSync(files[2]!)).toBe(false); // 하나의 실패가 나머지를 막지 않았다
    expect(warn.mock.calls.some((c) => String(c[0]).includes('EBUSY'))).toBe(true);

    vi.restoreAllMocks();
    const restarted = await makeApp(a.dataDir);
    apps.push(restarted.app);
    expect(fs.existsSync(files[1]!)).toBe(false); // 시작 시 고아 이미지 파일 정리
  });

  it('시작 시 정리에서 여전히 잠긴 파일이 있어도 서버 시작은 실패하지 않고, 실패 개수를 보고하며, 다음에 다시 시도한다', async () => {
    const a = await setup();
    const A = await render(a);
    const orphanVideo = videoFile(a, A);
    db(a).prepare(`DELETE FROM render_jobs WHERE id = ?`).run(A); // 기록만 지워 영상 파일을 고아로 만든다(삭제 직후 중단과 같은 상태)
    const orphanImgDir = path.join(a.store.uploadsDir, a.project.id);
    const orphanImg = path.join(orphanImgDir, 'orphan-image.png');
    fs.writeFileSync(orphanImg, 'x');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const real = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if ([orphanVideo, orphanImg].includes(String(p))) throw Object.assign(new Error('locked'), { code: 'EPERM' });
      return real(p, o);
    }) as typeof fs.rmSync);

    const s1 = a.renders.sweepFiles();
    const s2 = a.store.sweepOrphans();
    expect(s1.failedFiles).toBeGreaterThanOrEqual(1);
    expect(s2.failedFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphanVideo)).toBe(true);
    expect(fs.existsSync(orphanImg)).toBe(true);
    expect(warn).toHaveBeenCalled();

    // 전체 시작(buildApp)도 같은 상황에서 실패하지 않는다
    const started = await makeApp(a.dataDir);
    apps.push(started.app);
    expect(fs.existsSync(orphanVideo)).toBe(true);

    vi.restoreAllMocks(); // 잠금이 풀리면 다음 정리에서 지워진다
    const again = a.renders.sweepFiles();
    const again2 = a.store.sweepOrphans();
    expect(again.failedFiles).toBe(0);
    expect(again2.failedFiles).toBe(0);
    expect(fs.existsSync(orphanVideo)).toBe(false);
    expect(fs.existsSync(orphanImg)).toBe(false);
  });
});
