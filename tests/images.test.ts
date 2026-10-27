import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { solidPng } from '../server/solidPng';
import { GIF, fakeJpeg, fakeWebp, makeApp, upload } from './helpers';

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
async function setup() {
  const a = await makeApp();
  apps.push(a.app);
  const { project } = (await a.app.inject({ method: 'POST', url: '/api/projects' })).json();
  return { ...a, projectId: project.id as string };
}
const filesIn = (dir: string, projectId: string) => {
  const p = path.join(dir, 'uploads', projectId);
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
};

describe('이미지 업로드 검증', () => {
  it('PNG·JPEG·WebP 를 받아들이고 파일을 서버가 만든 이름으로 저장한다', async () => {
    const { app, projectId, dataDir } = await setup();
    const cases: Array<[Buffer, string, string]> = [
      [solidPng(64, 36, [1, 2, 3]), 'a.png', 'image/png'],
      [fakeJpeg(640, 360), 'b.jpg', 'image/jpeg'],
      [fakeWebp(640, 360), 'c.webp', 'image/webp'],
    ];
    for (const [i, [buf, name, mime]] of cases.entries()) {
      const res = await upload(app, projectId, i, buf, name, mime);
      expect(res.statusCode, name).toBe(200);
      const img = res.json().project.scenes[i].image;
      expect(img.fileName).toBe(name);
      const file = await app.inject({ url: img.url });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe(mime);
      expect(file.headers['x-content-type-options']).toBe('nosniff');
    }
    for (const f of filesIn(dataDir, projectId)) expect(f).toMatch(/^[0-9a-f-]{36}\.(png|jpg|webp)$/);
  });

  it('확장자와 Content-Type 이 이미지여도 실제 내용이 이미지가 아니면 거부한다', async () => {
    const { app, projectId, dataDir } = await setup();
    const res = await upload(app, projectId, 0, Buffer.from('<script>alert(1)</script>'), 'evil.png', 'image/png');
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('IMAGE_UNSUPPORTED_TYPE');
    expect(filesIn(dataDir, projectId)).toEqual([]);
  });

  it('허용하지 않는 이미지 형식(GIF)은 거부한다', async () => {
    const { app, projectId } = await setup();
    const res = await upload(app, projectId, 0, GIF, 'a.png', 'image/png');
    expect(res.statusCode).toBe(415);
  });

  it('확장자가 틀려도 내용이 허용 형식이면 받아들이되 저장 확장자는 실제 형식을 따른다', async () => {
    const { app, projectId, dataDir } = await setup();
    const res = await upload(app, projectId, 0, solidPng(32, 18, [9, 9, 9]), 'photo.exe', 'application/octet-stream');
    expect(res.statusCode).toBe(200);
    expect(filesIn(dataDir, projectId)[0]).toMatch(/\.png$/);
  });

  it('한 변이 4096px 를 넘으면 거부하고 4096px 는 허용한다', async () => {
    const { app, projectId } = await setup();
    expect((await upload(app, projectId, 0, solidPng(4097, 1, [0, 0, 0]))).statusCode).toBe(413);
    expect((await upload(app, projectId, 0, solidPng(1, 4097, [0, 0, 0]))).json().error.code).toBe('IMAGE_DIMENSIONS_TOO_LARGE');
    expect((await upload(app, projectId, 0, solidPng(4096, 2, [0, 0, 0]))).statusCode).toBe(200);
  });

  it('10MB 를 넘는 파일은 거부한다', async () => {
    const { app, projectId, dataDir } = await setup();
    const big = Buffer.concat([solidPng(8, 8, [0, 0, 0]), Buffer.alloc(10 * 1024 * 1024)]);
    const res = await upload(app, projectId, 0, big);
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('IMAGE_TOO_LARGE');
    expect(filesIn(dataDir, projectId)).toEqual([]);
  });

  it('빈 파일과 파일 없는 요청, 잘못된 장면 번호를 거부한다', async () => {
    const { app, projectId } = await setup();
    expect((await upload(app, projectId, 0, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload(app, projectId, 3, solidPng(8, 8, [0, 0, 0]))).statusCode).toBe(400);
    expect((await upload(app, projectId, -1, solidPng(8, 8, [0, 0, 0]))).statusCode).toBe(400);
  });

  it('경로를 담은 파일명은 표시용 이름만 남기고 저장 경로에 영향을 주지 않는다', async () => {
    const { app, projectId, dataDir } = await setup();
    const res = await upload(app, projectId, 0, solidPng(16, 9, [5, 5, 5]), '../../../etc/passwd.png');
    expect(res.statusCode).toBe(200);
    expect(res.json().project.scenes[0].image.fileName).toBe('passwd.png');
    expect(fs.existsSync(path.join(dataDir, 'etc'))).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, 'uploads')).sort()).toEqual([projectId]);
    expect(filesIn(dataDir, projectId)).toHaveLength(1);
  });

  it('없는 프로젝트에는 올릴 수 없다', async () => {
    const { app } = await setup();
    const res = await upload(app, '00000000-0000-4000-8000-000000000000', 0, solidPng(8, 8, [0, 0, 0]));
    expect(res.statusCode).toBe(404);
  });
});

describe('이미지 정리', () => {
  it('이미지를 바꾸면 이전 파일은 지우고, 실패한 업로드는 기존 이미지를 건드리지 않는다', async () => {
    const { app, projectId, dataDir } = await setup();
    const first = (await upload(app, projectId, 0, solidPng(16, 9, [1, 1, 1]))).json().project.scenes[0].image;
    expect(filesIn(dataDir, projectId)).toHaveLength(1);

    expect((await upload(app, projectId, 0, GIF)).statusCode).toBe(415);
    expect((await app.inject({ url: first.url })).statusCode).toBe(200);

    const second = (await upload(app, projectId, 0, solidPng(16, 9, [2, 2, 2]))).json().project.scenes[0].image;
    expect(second.id).not.toBe(first.id);
    expect(filesIn(dataDir, projectId)).toHaveLength(1);
    expect((await app.inject({ url: first.url })).statusCode).toBe(404);
  });

  it('삭제한 이미지도 렌더 작업이 참조하고 있으면 남겨 둔다', async () => {
    const { app, store, projectId, dataDir } = await setup();
    const img = (await upload(app, projectId, 0, solidPng(16, 9, [1, 1, 1]))).json().project.scenes[0].image;
    const db = (store as any).db;
    db.prepare(
      `INSERT INTO render_jobs (id, project_id, status, snapshot_json, created_at) VALUES ('j1', ?, 'done', '{}', 'now')`,
    ).run(projectId);
    db.prepare(`INSERT INTO render_job_images (job_id, image_id) VALUES ('j1', ?)`).run(img.id);

    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/0/image` });
    expect(res.json().project.scenes[0].image).toBeNull();
    expect(filesIn(dataDir, projectId)).toHaveLength(1); // 렌더 작업이 쓰므로 보존
    expect((await app.inject({ url: img.url })).statusCode).toBe(200);
  });

  it('렌더 작업이 없으면 삭제 즉시 파일도 지운다', async () => {
    const { app, projectId, dataDir } = await setup();
    await upload(app, projectId, 1, solidPng(16, 9, [1, 1, 1]));
    await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}/scenes/1/image` });
    expect(filesIn(dataDir, projectId)).toEqual([]);
  });

  it('서버 시작 시 임시 파일·고아 파일을 정리하되 쓰는 이미지와 입력 내용은 보존한다', async () => {
    const first = await setup();
    const { project } = (await first.app.inject({ url: `/api/projects/${first.projectId}` })).json();
    await first.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: { title: '보존', scenes: [{ text: '문구', durationSec: 7 }, { text: '', durationSec: 10 }, { text: '', durationSec: 10 }] },
    });
    const kept = (await upload(first.app, project.id, 0, solidPng(16, 9, [1, 1, 1]))).json().project.scenes[0].image;
    const dir = path.join(first.dataDir, 'uploads', project.id);
    fs.writeFileSync(path.join(dir, 'half-written.png.part'), 'x');
    fs.writeFileSync(path.join(dir, 'stray.png'), 'x');
    await first.app.close();
    apps.length = 0;

    const second = await makeApp(first.dataDir);
    apps.push(second.app);
    expect(fs.readdirSync(dir).sort()).toEqual([`${kept.id}.png`]);
    const got = (await second.app.inject({ url: `/api/projects/${project.id}` })).json().project;
    expect(got.title).toBe('보존');
    expect(got.scenes[0]).toMatchObject({ text: '문구', durationSec: 7 });
    expect(got.scenes[0].image.id).toBe(kept.id);
  });
});

describe('프로젝트 삭제', () => {
  it('삭제하면 이미지 파일까지 지운다', async () => {
    const { app, projectId, dataDir } = await setup();
    await upload(app, projectId, 0, solidPng(16, 9, [1, 1, 1]));
    expect(filesIn(dataDir, projectId)).toHaveLength(1);
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });
    expect(res.statusCode).toBe(204);
    expect(fs.existsSync(path.join(dataDir, 'uploads', projectId))).toBe(false);
    expect((await app.inject({ url: `/api/projects/${projectId}` })).statusCode).toBe(404);
  });

  it('생성이 진행 중이면 삭제를 거부하고 아무것도 지우지 않는다', async () => {
    const { app, store, projectId, dataDir } = await setup();
    await upload(app, projectId, 0, solidPng(16, 9, [1, 1, 1]));
    (store as any).db
      .prepare(`INSERT INTO render_jobs (id, project_id, status, snapshot_json, created_at) VALUES ('j1', ?, 'generating', '{}', 'now')`)
      .run(projectId);
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${projectId}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROJECT_BUSY');
    expect(filesIn(dataDir, projectId)).toHaveLength(1);
  });
});

describe('상태 전환 · 중복 방지용 제약', () => {
  it('완료/실패 프로젝트를 고치면 편집 중으로 돌아가고, 생성 중에는 상태를 유지한다', async () => {
    const { app, store, projectId } = await setup();
    const db = (store as any).db;
    const save = () =>
      app.inject({
        method: 'PUT',
        url: `/api/projects/${projectId}`,
        payload: { title: 't', scenes: Array(3).fill({ text: 'x', durationSec: 10 }) },
      });
    for (const s of ['done', 'failed']) {
      db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(s, projectId);
      expect((await save()).json().project.status).toBe('editing');
    }
    db.prepare(`UPDATE projects SET status = 'generating' WHERE id = ?`).run(projectId);
    expect((await save()).json().project.status).toBe('generating');
  });

  it('프로젝트당 진행 중인 렌더 작업은 DB 제약으로 1개만 허용된다(2단계 중복 방지의 기반)', async () => {
    const { store, projectId } = await setup();
    const db = (store as any).db;
    const ins = db.prepare(
      `INSERT INTO render_jobs (id, project_id, status, snapshot_json, created_at) VALUES (?, ?, ?, '{}', 'now')`,
    );
    ins.run('a', projectId, 'waiting');
    expect(() => ins.run('b', projectId, 'generating')).toThrow(/UNIQUE/);
    db.prepare(`UPDATE render_jobs SET status = 'done' WHERE id = 'a'`).run();
    expect(() => ins.run('c', projectId, 'waiting')).not.toThrow();
  });
});
