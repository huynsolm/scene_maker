import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSampleProject } from '../server/seed';
import { RenderError, imageDecodeFailed } from '../server/render/errors';
import { solidPng } from '../server/solidPng';
import { FakeRenderer, makeApp, upload, validSave, waitFor } from './helpers';

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
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
const post = (app: any, id: string) => app.inject({ method: 'POST', url: `/api/projects/${id}/renders` });
const job = async (app: any, id: string) => (await app.inject({ url: `/api/renders/${id}` })).json().job;
const proj = async (app: any, id: string) => (await app.inject({ url: `/api/projects/${id}` })).json().project;
const db = (a: { store: any }) => a.store.db;

describe('생성 요청과 상태', () => {
  it('요청은 접수만 하고 바로 202 로 돌려주며, 상태는 별도 조회로 대기 → 생성 중 → 완료로 바뀐다', async () => {
    const a = await setup({ auto: false });
    const res = await post(a.app, a.project.id);
    expect(res.statusCode).toBe(202);
    const created = res.json().job;
    expect(created.status).toBe('waiting');
    expect(created.videoUrl).toBeNull();

    await waitFor(async () => (await job(a.app, created.id)).status === 'generating', '생성 중');
    expect((await job(a.app, created.id)).step).toBe(2);
    expect((await proj(a.app, a.project.id)).status).toBe('generating');
    const list = (await a.app.inject({ url: '/api/projects' })).json().projects;
    expect(list[0].status).toBe('generating');

    a.renderer.release();
    const done = await waitFor(async () => {
      const j = await job(a.app, created.id);
      return j.status === 'done' ? j : null;
    }, '완료');
    expect(done.videoUrl).toBe(`/api/renders/${created.id}/video`);
    expect(done.output).toEqual({ width: 1280, height: 720, fps: 30 });
    expect((await proj(a.app, a.project.id)).status).toBe('done');
    const latest = (await a.app.inject({ url: `/api/projects/${a.project.id}/renders/latest` })).json().job;
    expect(latest.id).toBe(created.id);
  });

  it('제목·문구·이미지가 비어 있으면 422 로 거부하고 작업을 만들지 않는다', async () => {
    const a = await setup();
    const empty = (await a.app.inject({ method: 'POST', url: '/api/projects' })).json().project;
    const res = await post(a.app, empty.id);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('RENDER_INCOMPLETE');
    expect(res.json().error.missing).toHaveLength(7);
    expect(db(a).prepare(`SELECT COUNT(*) c FROM render_jobs WHERE project_id = ?`).get(empty.id).c).toBe(0);
    expect((await proj(a.app, empty.id)).status).toBe('editing');
    expect(a.renderer.calls).toHaveLength(0);
  });

  it('없는 프로젝트·없는 작업은 404', async () => {
    const a = await setup();
    expect((await post(a.app, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await a.app.inject({ url: '/api/renders/nope' })).statusCode).toBe(404);
  });
});

describe('중복 방지', () => {
  it('진행 중에 다시 요청하면 새 작업을 만들지 않고 409 로 기존 작업을 알려준다', async () => {
    const a = await setup({ auto: false });
    const first = (await post(a.app, a.project.id)).json().job;
    await waitFor(() => a.renderer.calls.length === 1, '렌더 시작');
    const again = await post(a.app, a.project.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('RENDER_IN_PROGRESS');
    expect(again.json().error.job.id).toBe(first.id);
    expect(db(a).prepare(`SELECT COUNT(*) c FROM render_jobs`).get().c).toBe(1);
    a.renderer.release();
  });

  it('동시에 10번 눌러도 작업은 1개, 렌더도 1번만 실행된다', async () => {
    const a = await setup({ auto: false });
    const results = await Promise.all(Array.from({ length: 10 }, () => post(a.app, a.project.id)));
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect(db(a).prepare(`SELECT COUNT(*) c FROM render_jobs`).get().c).toBe(1);
    await waitFor(() => a.renderer.calls.length === 1, '렌더 시작');
    a.renderer.release();
    await waitFor(async () => (await proj(a.app, a.project.id)).status === 'done', '완료');
    expect(a.renderer.calls).toHaveLength(1);
  });

  it('끝난 뒤에는 다시 요청할 수 있고 새 작업이 만들어진다', async () => {
    const a = await setup();
    const first = (await post(a.app, a.project.id)).json().job;
    await waitFor(async () => (await job(a.app, first.id)).status === 'done', '첫 완료');
    const second = await post(a.app, a.project.id);
    expect(second.statusCode).toBe(202);
    expect(second.json().job.id).not.toBe(first.id);
  });

  it('프로젝트가 달라도 한 번에 하나씩만 처리한다(두 번째는 대기)', async () => {
    const a = await setup({ auto: false });
    const other = createSampleProject(a.store);
    const j1 = (await post(a.app, a.project.id)).json().job;
    const j2 = (await post(a.app, other.id)).json().job;
    await waitFor(() => a.renderer.calls.length === 1, '첫 렌더 시작');
    expect((await job(a.app, j1.id)).status).toBe('generating');
    expect((await job(a.app, j2.id)).status).toBe('waiting');
    expect((await proj(a.app, other.id)).status).toBe('waiting');
    a.renderer.release(0);
    await waitFor(() => a.renderer.calls.length === 2, '두 번째 렌더 시작');
    expect((await job(a.app, j2.id)).status).toBe('generating');
    a.renderer.release(1);
    await waitFor(async () => (await job(a.app, j2.id)).status === 'done', '두 번째 완료');
  });
});

describe('생성 중 편집과 영상 버전', () => {
  it('요청 시점의 내용으로 만들고, 생성 중에 고친 내용은 섞이지 않는다', async () => {
    const a = await setup({ auto: false });
    const created = (await post(a.app, a.project.id)).json().job;
    await waitFor(() => a.renderer.calls.length === 1, '렌더 시작');

    // 생성 중 편집: 제목·문구·길이 변경 + 1번 장면 이미지 교체
    const save = await a.app.inject({
      method: 'PUT',
      url: `/api/projects/${a.project.id}`,
      payload: validSave({
        title: '나중에 바꾼 제목',
        scenes: [{ text: '나중에 바꾼 문구', durationSec: 5 }, { text: '둘', durationSec: 10 }, { text: '셋', durationSec: 10 }],
      }),
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().project.status).toBe('generating'); // 생성 중에는 상태 유지
    const oldImage = a.project.scenes[0]!.image!;
    const oldFile = a.store.imageFileForRender(oldImage.id);
    await upload(a.app, a.project.id, 0, solidPng(64, 36, [1, 2, 3]), 'new.png');
    expect(fs.existsSync(oldFile)).toBe(true); // 렌더 작업이 쓰는 이미지는 지우지 않는다

    // 렌더러가 받은 입력은 요청 시점 값
    expect(a.renderer.calls[0]!.scenes[0]).toMatchObject({ text: '매장에 우유가 부족한지 확인하기 어려우셨나요?', durationSec: 10, imagePath: oldFile });

    a.renderer.release();
    const done = await waitFor(async () => {
      const j = await job(a.app, created.id);
      return j.status === 'done' ? j : null;
    }, '완료');
    // 작업 기록은 요청 시점 내용
    expect(done.snapshot.title).toBe('매장 재고 관리 사용법');
    expect(done.snapshot.scenes[0].text).toBe('매장에 우유가 부족한지 확인하기 어려우셨나요?');
    expect(done.snapshot.totalSec).toBe(30);
    // 프로젝트는 그 뒤로 고쳐졌으므로 '편집 중'(영상은 이전 버전)
    const p = await proj(a.app, a.project.id);
    expect(p.status).toBe('editing');
    expect(p.title).toBe('나중에 바꾼 제목');
    expect(p.scenes[0].text).toBe('나중에 바꾼 문구');
  });

  it('완료/실패 뒤에 고치면 편집 중으로 돌아간다', async () => {
    const a = await setup();
    const j = (await post(a.app, a.project.id)).json().job;
    await waitFor(async () => (await job(a.app, j.id)).status === 'done', '완료');
    expect((await proj(a.app, a.project.id)).status).toBe('done');
    await a.app.inject({ method: 'PUT', url: `/api/projects/${a.project.id}`, payload: validSave() });
    expect((await proj(a.app, a.project.id)).status).toBe('editing');
  });
});

describe('실패와 재시도', () => {
  it('실패하면 이유를 남기고 입력·이미지는 그대로이며, 재시도는 새 작업으로 성공한다', async () => {
    const a = await setup();
    a.renderer.failWith = imageDecodeFailed(2, 'ffmpeg: Invalid data found');
    const first = (await post(a.app, a.project.id)).json().job;
    const failed = await waitFor(async () => {
      const j = await job(a.app, first.id);
      return j.status === 'failed' ? j : null;
    }, '실패');
    expect(failed.error).toMatchObject({ code: 'IMAGE_DECODE_FAILED', title: '장면 2 이미지를 읽을 수 없어요' });
    expect(failed.error.body).toContain('다시 올린 뒤');
    expect(JSON.stringify(failed)).not.toContain('Invalid data found'); // 개발자용 상세는 응답에 싣지 않는다
    expect(db(a).prepare(`SELECT error_detail d FROM render_jobs WHERE id = ?`).get(first.id).d).toContain('Invalid data found');

    const p = await proj(a.app, a.project.id);
    expect(p.status).toBe('failed');
    expect(p.title).toBe('매장 재고 관리 사용법');
    expect(p.scenes.map((s: any) => s.text)).toHaveLength(3);
    expect(p.scenes.every((s: any) => s.image)).toBe(true);

    a.renderer.failWith = null;
    const retry = await post(a.app, a.project.id);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().job.id).not.toBe(first.id);
    await waitFor(async () => (await job(a.app, retry.json().job.id)).status === 'done', '재시도 완료');
    expect((await proj(a.app, a.project.id)).status).toBe('done');
  });

  it('예상하지 못한 오류도 사용자에게는 일반 문구만 보여주고 상세는 서버에만 남긴다', async () => {
    const a = await setup();
    a.renderer.failWith = new Error('secret path /srv/data exploded');
    const j = (await post(a.app, a.project.id)).json().job;
    const failed = await waitFor(async () => {
      const x = await job(a.app, j.id);
      return x.status === 'failed' ? x : null;
    }, '실패');
    expect(failed.error.code).toBe('INTERNAL');
    expect(JSON.stringify(failed)).not.toContain('secret path');
  });

  it('실패한 작업은 대기·생성 중이 아니므로 바로 다시 요청할 수 있다(진행 중 제약에 걸리지 않음)', async () => {
    const a = await setup();
    a.renderer.failWith = new RenderError('RENDER_FAILED', 't', 'b');
    const j = (await post(a.app, a.project.id)).json().job;
    await waitFor(async () => (await job(a.app, j.id)).status === 'failed', '실패');
    a.renderer.failWith = null;
    expect((await post(a.app, a.project.id)).statusCode).toBe(202);
  });
});

describe('서버 재시작 복구', () => {
  it('생성 중·대기 중이던 작업은 실패(서버 재시작)로 표시하고, 임시 파일은 지우되 입력·이미지·완성 영상은 보존한다', async () => {
    const renderer1 = new FakeRenderer();
    const first = await makeApp(undefined, { renderer: renderer1 });
    const p1 = createSampleProject(first.store);
    const p2 = createSampleProject(first.store);
    const p3 = createSampleProject(first.store);

    // p3: 정상 완료된 영상 하나를 만들어 둔다
    const done = (await post(first.app, p3.id)).json().job;
    await waitFor(async () => (await job(first.app, done.id)).status === 'done', 'p3 완료');
    const videoPath = first.renders.videoPathFor(p3.id, done.id);
    expect(fs.existsSync(videoPath)).toBe(true);

    // p1 은 생성 중, p2 는 대기 중인 채로 서버가 멈춘다
    renderer1.auto = false;
    const j1 = (await post(first.app, p1.id)).json().job;
    const j2 = (await post(first.app, p2.id)).json().job;
    await waitFor(() => renderer1.calls.length === 2, 'p1 렌더 시작'); // p3 + p1
    expect((await job(first.app, j1.id)).status).toBe('generating');
    expect((await job(first.app, j2.id)).status).toBe('waiting');

    // 쓰다 만 임시 파일들
    fs.mkdirSync(path.join(first.dataDir, 'tmp', 'stale-job'), { recursive: true });
    fs.writeFileSync(path.join(first.dataDir, 'tmp', 'stale-job', 'output.mp4'), 'half');
    const strayVideo = path.join(first.dataDir, 'videos', p3.id, 'stray.mp4.part');
    fs.writeFileSync(strayVideo, 'half');
    await first.app.close(); // 비정상 종료와 같은 상태(작업은 DB 에 '생성 중'으로 남음)

    const second = await makeApp(first.dataDir, { renderer: new FakeRenderer() });
    apps.push(second.app);
    for (const j of [j1, j2]) {
      const v = await job(second.app, j.id);
      expect(v.status).toBe('failed');
      expect(v.error).toMatchObject({ code: 'SERVER_RESTARTED', title: '서버가 다시 시작되어 생성이 중단됐어요' });
    }
    expect((await proj(second.app, p1.id)).status).toBe('failed');
    expect((await proj(second.app, p2.id)).status).toBe('failed');
    // 입력·이미지 보존
    const kept = await proj(second.app, p1.id);
    expect(kept.title).toBe('매장 재고 관리 사용법');
    expect(kept.scenes.map((s: any) => s.text)[0]).toContain('우유');
    expect(kept.scenes.every((s: any) => s.image && fs.existsSync(second.store.imageFileForRender(s.image.id)))).toBe(true);
    // 임시 파일 정리, 완성 영상 보존
    expect(fs.existsSync(path.join(second.dataDir, 'tmp'))).toBe(false);
    expect(fs.existsSync(strayVideo)).toBe(false);
    expect(fs.existsSync(videoPath)).toBe(true);
    expect((await job(second.app, done.id)).status).toBe('done');
    expect((await second.app.inject({ url: `/api/renders/${done.id}/video` })).statusCode).toBe(200);

    // 사용자가 직접 다시 시도
    const retry = await post(second.app, p1.id);
    expect(retry.statusCode).toBe(202);
    await waitFor(async () => (await job(second.app, retry.json().job.id)).status === 'done', '재시도 완료');
  });

  it('재시작 직후에는 자동으로 다시 돌리지 않는다', async () => {
    const r1 = new FakeRenderer();
    r1.auto = false;
    const first = await makeApp(undefined, { renderer: r1 });
    const p = createSampleProject(first.store);
    await post(first.app, p.id);
    await waitFor(() => r1.calls.length === 1, '시작');
    await first.app.close();
    const r2 = new FakeRenderer();
    const second = await makeApp(first.dataDir, { renderer: r2 });
    apps.push(second.app);
    await new Promise((r) => setTimeout(r, 200));
    expect(r2.calls).toHaveLength(0);
  });
});

describe('영상 전달', () => {
  async function withVideo() {
    const a = await setup();
    const j = (await post(a.app, a.project.id)).json().job;
    await waitFor(async () => (await job(a.app, j.id)).status === 'done', '완료');
    return { ...a, jobId: j.id as string };
  }

  it('MP4 로 재생하고, Range 요청에 부분 응답한다', async () => {
    const a = await withVideo();
    const full = await a.app.inject({ url: `/api/renders/${a.jobId}/video` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('video/mp4');
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.rawPayload.length).toBe(20);

    const part = await a.app.inject({ url: `/api/renders/${a.jobId}/video`, headers: { range: 'bytes=5-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 5-9/20');
    expect(part.body).toBe('56789');
    const tail = await a.app.inject({ url: `/api/renders/${a.jobId}/video`, headers: { range: 'bytes=-4' } });
    expect(tail.body).toBe('ghij');
    const bad = await a.app.inject({ url: `/api/renders/${a.jobId}/video`, headers: { range: 'bytes=50-60' } });
    expect(bad.statusCode).toBe(416);
  });

  it('다운로드는 제목으로 만든 안전한 파일명을 쓴다', async () => {
    const a = await withVideo();
    const res = await a.app.inject({ url: `/api/renders/${a.jobId}/video?download=1` });
    const cd = res.headers['content-disposition'] as string;
    expect(cd).toContain('attachment');
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('매장 재고 관리 사용법.mp4')}`);

    // 제목에 경로·특수 문자가 있어도 파일명에 반영되지 않는다
    await a.app.inject({ method: 'PUT', url: `/api/projects/${a.project.id}`, payload: validSave({ title: '../../a/b:c*?.mp4' }) });
    const j2 = (await post(a.app, a.project.id)).json().job;
    await waitFor(async () => (await job(a.app, j2.id)).status === 'done', '두 번째 완료');
    const cd2 = (await a.app.inject({ url: `/api/renders/${j2.id}/video?download=1` })).headers['content-disposition'] as string;
    expect(cd2).not.toMatch(/[/\\]/);
    expect(decodeURIComponent(cd2.split("UTF-8''")[1]!)).toBe('abc.mp4.mp4');
  });

  it('완료되지 않은 작업의 영상은 404', async () => {
    const a = await setup({ auto: false });
    const j = (await post(a.app, a.project.id)).json().job;
    expect((await a.app.inject({ url: `/api/renders/${j.id}/video` })).statusCode).toBe(404);
    a.renderer.release();
  });

  it('프로젝트를 삭제하면 완성 영상도 함께 지운다', async () => {
    const a = await withVideo();
    const file = a.renders.videoPathFor(a.project.id, a.jobId);
    expect(fs.existsSync(file)).toBe(true);
    expect((await a.app.inject({ method: 'DELETE', url: `/api/projects/${a.project.id}` })).statusCode).toBe(204);
    expect(fs.existsSync(file)).toBe(false);
    expect((await a.app.inject({ url: `/api/renders/${a.jobId}` })).statusCode).toBe(404);
  });
});
