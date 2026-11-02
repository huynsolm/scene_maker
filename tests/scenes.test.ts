import { describe, expect, it } from 'vitest';
import { SCENE_DEFAULT, SCENE_MAX, SCENE_MIN, TOTAL_MAX_SEC } from '../shared/limits';
import { solidPng } from '../server/solidPng';
import { makeApp, upload } from './helpers';

async function setup() {
  const a = await makeApp();
  const { project } = (await a.app.inject({ method: 'POST', url: '/api/projects' })).json();
  return { ...a, projectId: project.id as string, project };
}
const get = async (app: any, id: string) => (await app.inject({ url: `/api/projects/${id}` })).json().project;
const save = (app: any, id: string, scenes: unknown[], title = '제목') =>
  app.inject({ method: 'PUT', url: `/api/projects/${id}`, payload: { title, scenes } });

describe('장면 추가·삭제', () => {
  it('새 프로젝트는 기본 장면 3개에 고유 ID 와 0..2 순서를 가진다', async () => {
    const { project } = await setup();
    expect(project.scenes).toHaveLength(SCENE_DEFAULT);
    expect(new Set(project.scenes.map((s: any) => s.id)).size).toBe(SCENE_DEFAULT);
    expect(project.scenes.map((s: any) => s.position)).toEqual([0, 1, 2]);
  });

  it('장면을 맨 뒤에 추가하고 최대 개수에서 거절한다', async () => {
    const { app, projectId } = await setup();
    for (let n = SCENE_DEFAULT; n < SCENE_MAX; n++) {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes` });
      expect(res.statusCode).toBe(201);
      expect(res.json().project.scenes).toHaveLength(n + 1);
    }
    const over = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes` });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.code).toBe('SCENE_LIMIT');
    const p = await get(app, projectId);
    expect(p.scenes.map((s: any) => s.position)).toEqual(Array.from({ length: SCENE_MAX }, (_, i) => i));
    expect(TOTAL_MAX_SEC).toBe(300);
  });

  it('중간 장면을 지우면 뒤 장면의 내용·이미지가 그대로 앞으로 당겨진다', async () => {
    const { app, projectId } = await setup();
    const p0 = await get(app, projectId);
    await save(app, projectId, p0.scenes.map((s: any, i: number) => ({ id: s.id, text: `문구${i}`, durationSec: 4 + i })));
    await upload(app, projectId, 2, solidPng(16, 9, [9, 9, 9]), 'third.png');
    const before = await get(app, projectId);
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${before.scenes[1].id}` });
    expect(res.statusCode).toBe(200);
    const after = res.json().project;
    expect(after.scenes.map((s: any) => [s.id, s.position, s.text, s.durationSec])).toEqual([
      [before.scenes[0].id, 0, '문구0', 4],
      [before.scenes[2].id, 1, '문구2', 6],
    ]);
    expect(after.scenes[1].image.fileName).toBe('third.png');
  });

  it('마지막 한 장면은 지울 수 없고, 없는 장면은 404', async () => {
    const { app, projectId } = await setup();
    let p = await get(app, projectId);
    for (const s of p.scenes.slice(SCENE_MIN)) {
      expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${s.id}` })).statusCode).toBe(200);
    }
    p = await get(app, projectId);
    expect(p.scenes).toHaveLength(SCENE_MIN);
    const last = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${p.scenes[0].id}` });
    expect(last.statusCode).toBe(422);
    expect(last.json().error.code).toBe('SCENE_MIN');
    const none = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/00000000-0000-4000-8000-000000000000` });
    expect(none.statusCode).toBe(404);
  });

  it('지운 장면의 이미지는 어디에서도 쓰지 않을 때만 파일까지 정리한다', async () => {
    const { app, projectId, dataDir } = await setup();
    await upload(app, projectId, 0, solidPng(16, 9, [1, 1, 1]));
    const p = await get(app, projectId);
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(dataDir, 'uploads', projectId);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${p.scenes[0].id}` });
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('오래된 화면의 저장은 지워진 장면을 되살리지 못하고 409 로 거절된다', async () => {
    const { app, projectId } = await setup();
    const stale = (await get(app, projectId)).scenes; // 삭제 전 화면이 가진 목록
    await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${stale[1].id}` });
    const res = await save(app, projectId, stale.map((s: any) => ({ id: s.id, text: '되살림', durationSec: 9 })));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SCENES_CHANGED');
    const now = await get(app, projectId);
    expect(now.scenes).toHaveLength(2);
    expect(now.scenes.every((s: any) => s.text !== '되살림')).toBe(true);
  });

  it('추가 전의 화면이 보낸 저장도 거절되고, 추가 뒤의 목록으로는 저장된다', async () => {
    const { app, projectId } = await setup();
    const stale = (await get(app, projectId)).scenes;
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes` });
    expect((await save(app, projectId, stale.map((s: any) => ({ id: s.id, text: 'a', durationSec: 5 })))).statusCode).toBe(409);
    const fresh = (await get(app, projectId)).scenes;
    const ok = await save(app, projectId, fresh.map((s: any) => ({ id: s.id, text: 'a', durationSec: 5 })));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project.scenes).toHaveLength(4);
  });

  it('ID 를 일부만 보내거나 순서가 다르면 거절한다', async () => {
    const { app, projectId } = await setup();
    const s = (await get(app, projectId)).scenes;
    const partial = [{ id: s[0].id, text: 'a', durationSec: 5 }, { text: 'b', durationSec: 5 }, { text: 'c', durationSec: 5 }];
    expect((await save(app, projectId, partial)).statusCode).toBe(400);
    const swapped = [s[1], s[0], s[2]].map((x: any) => ({ id: x.id, text: 'a', durationSec: 5 }));
    expect((await save(app, projectId, swapped)).statusCode).toBe(409);
  });

  it('다른 프로젝트의 장면 ID 로는 이미지를 올리거나 지울 수 없다', async () => {
    const { app, projectId } = await setup();
    const other = (await app.inject({ method: 'POST', url: '/api/projects' })).json().project;
    const foreign = other.scenes[0].id;
    const form = (await import('form-data')).default;
    const f = new form();
    f.append('file', solidPng(8, 8, [0, 0, 0]), { filename: 'a.png', contentType: 'image/png' });
    const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes/${foreign}/image`, payload: f.getBuffer(), headers: f.getHeaders() });
    expect(up.statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${foreign}/image` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${foreign}` })).statusCode).toBe(404);
  });

  it('장면 수가 바뀐 프로젝트로도 영상 생성 요청이 그 장면 수로 스냅샷을 만든다', async () => {
    const { app, projectId } = await setup();
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes` }); // 4개
    let p = await get(app, projectId);
    await save(app, projectId, p.scenes.map((s: any, i: number) => ({ id: s.id, text: `문구${i}`, durationSec: 3 })));
    for (let i = 0; i < 4; i++) await upload(app, projectId, i, solidPng(16, 9, [i, i, i]));
    const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/renders` });
    expect(res.statusCode).toBe(202);
    expect(res.json().job.snapshot.scenes).toHaveLength(4);
    expect(res.json().job.snapshot.totalSec).toBe(12);
    p = await get(app, projectId);
    expect(p.scenes).toHaveLength(4);
  });

  it('프로젝트 목록이 장면 수(sceneCount)와 총 길이를 장면 추가·삭제에 맞춰 돌려준다', async () => {
    const { app, projectId } = await setup();
    const list = async () => (await app.inject({ url: '/api/projects' })).json().projects.find((p: any) => p.id === projectId);
    expect(await list()).toMatchObject({ sceneCount: 3, totalSec: 30 });
    await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scenes` });
    expect(await list()).toMatchObject({ sceneCount: 4, totalSec: 40 });
    const p = await get(app, projectId);
    await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/${p.scenes[0].id}` });
    expect(await list()).toMatchObject({ sceneCount: 3, totalSec: 30 });
  });
});
