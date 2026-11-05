import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RenderStore } from '../server/renderStore';
import { createSampleProject } from '../server/seed';
import { imageDecodeFailed } from '../server/render/errors';
import { solidPng } from '../server/solidPng';
import { FakeRenderer, makeApp, waitFor } from './helpers';

// 실패한 작업이 붙잡은 이미지 회수(docs/plan-reclaim-failed-job-images.md).
// 실패 기록은 남기고 이미지 연결만 끊으며, 아무도 쓰지 않게 된 이미지는 지운다.

type Closable = { close(): Promise<void> };
const apps: Closable[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
});

async function setup(dataDir?: string) {
  const renderer = new FakeRenderer();
  const a = await makeApp(dataDir, { renderer });
  apps.push(a.app);
  return { ...a, renderer };
}
type A = Awaited<ReturnType<typeof setup>>;

/** 앱을 닫는다(다음 시작을 흉내 내기 전에). */
async function close(a: A) {
  const i = apps.indexOf(a.app);
  if (i >= 0) apps.splice(i, 1);
  await a.app.close();
}
/** 같은 데이터 폴더로 서버를 다시 시작한다. */
async function restart(a: A) {
  await close(a);
  return setup(a.dataDir);
}

const tick = () => new Promise((r) => setTimeout(r, 6));
const db = (a: A) => (a.store as any).db;
const scenesOf = (a: A, projectId: string) => a.store.getProject(projectId).scenes;
const sceneImageIds = (a: A, projectId: string) => scenesOf(a, projectId).map((s) => s.image!.id);
const linkedImages = (a: A, jobId: string) =>
  (db(a).prepare(`SELECT image_id FROM render_job_images WHERE job_id = ?`).all(jobId) as Array<{ image_id: string }>).map((r) => r.image_id);
const imageRow = (a: A, id: string) => !!db(a).prepare(`SELECT 1 FROM images WHERE id = ?`).get(id);
const imageFile = (a: A, id: string) => {
  const r = db(a).prepare(`SELECT project_id, stored_name FROM images WHERE id = ?`).get(id) as { project_id: string; stored_name: string } | undefined;
  return r ? a.store.imagePath(r.project_id, r.stored_name) : null;
};
/** 이미지가 행·파일 모두 남아 있는지. */
const imageKept = (a: A, id: string) => {
  const f = imageFile(a, id);
  return !!f && fs.existsSync(f);
};
const jobStatus = (a: A, id: string) => (db(a).prepare(`SELECT status FROM render_jobs WHERE id = ?`).get(id) as { status: string } | undefined)?.status;
const getJob = async (a: A, id: string) => (await a.app.inject({ url: `/api/renders/${id}` })).json().job;

async function startRender(a: A, projectId: string): Promise<string> {
  const res = await a.app.inject({ method: 'POST', url: `/api/projects/${projectId}/renders` });
  expect(res.statusCode).toBe(202);
  return res.json().job.id as string;
}
async function waitEnd(a: A, id: string) {
  const j = await waitFor(async () => {
    const j = await getJob(a, id);
    return j.status === 'done' || j.status === 'failed' ? j : null;
  }, '작업 종료');
  await tick();
  return j;
}
async function waitGenerating(a: A, id: string) {
  await waitFor(() => a.renderer.calls.length > 0 && jobStatus(a, id) === 'generating', '생성 중');
}
/** 끝까지 렌더한다(성공). */
async function renderDone(a: A, projectId: string) {
  a.renderer.auto = true;
  a.renderer.failWith = null;
  const id = await startRender(a, projectId);
  expect((await waitEnd(a, id)).status).toBe('done');
  return id;
}
/** 바로 실패하는 렌더. */
async function renderFailed(a: A, projectId: string) {
  a.renderer.auto = true;
  a.renderer.failWith = imageDecodeFailed(1);
  const id = await startRender(a, projectId);
  expect((await waitEnd(a, id)).status).toBe('failed');
  a.renderer.failWith = null;
  return id;
}
/**
 * 렌더를 '생성 중'으로 멈춰 두고, 그동안 장면 이미지를 바꾼 뒤 실패시킨다.
 * 바꾸기 전 이미지는 이 작업만 참조하게 된다(장면 교체 때는 진행 중 작업이 쓰므로 남는다).
 */
async function failAfterReplacing(a: A, projectId: string, positions: number[], beforeFail?: () => void) {
  const before = a.renderer.calls.length;
  a.renderer.auto = false;
  a.renderer.failWith = null;
  const id = await startRender(a, projectId);
  await waitFor(() => a.renderer.calls.length > before && jobStatus(a, id) === 'generating', '생성 중');
  const old = positions.map((p) => scenesOf(a, projectId)[p]!.image!.id);
  positions.forEach((p, i) => a.store.attachImage(projectId, p, solidPng(64, 36, [10 + i, 20, 30]), `new${p}.png`));
  old.forEach((id) => expect(imageKept(a, id)).toBe(true)); // 생성 중인 작업이 쓰므로 교체 때는 남는다
  beforeFail?.(); // 장면 교체가 끝난 뒤에 실패 주입을 건다(교체 때의 회수에는 걸리지 않게)
  a.renderer.fail(imageDecodeFailed(1), a.renderer.calls.length - before - 1);
  const j = await waitEnd(a, id);
  expect(j.status).toBe('failed');
  a.renderer.auto = true;
  return { id, old };
}
const silenceWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined);

describe('실패하는 순간 회수', () => {
  it('실패한 작업의 연결을 끊고, 그 작업만 쓰던 이미지(장면에서 이미 교체됨)의 행·파일을 지운다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const { id, old } = await failAfterReplacing(a, p.id, [0, 1]);
    expect(linkedImages(a, id)).toEqual([]);
    for (const o of old) {
      expect(imageRow(a, o)).toBe(false);
    }
    // 현재 장면 이미지는 모두 남는다(행·파일)
    for (const cur of sceneImageIds(a, p.id)) expect(imageKept(a, cur)).toBe(true);
  });

  it('지운 이미지 파일이 디스크에서도 사라진다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const files = [imageFile(a, sceneImageIds(a, p.id)[0]!)!];
    await failAfterReplacing(a, p.id, [0]);
    expect(fs.existsSync(files[0]!)).toBe(false);
  });

  it('현재 장면이 쓰는 이미지는 실패해도 남는다(연결만 끊긴다)', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const ids = sceneImageIds(a, p.id);
    const f = await renderFailed(a, p.id);
    expect(linkedImages(a, f)).toEqual([]);
    for (const id of ids) expect(imageKept(a, id)).toBe(true);
  });

  it('완성 작업과 같은 이미지를 쓰면 남고, 완성 작업의 연결도 그대로다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const d = await renderDone(a, p.id);
    const doneLinks = linkedImages(a, d).sort();
    const { old } = await failAfterReplacing(a, p.id, [0]);
    expect(imageKept(a, old[0]!)).toBe(true); // 완성 영상이 아직 쓴다
    expect(linkedImages(a, d).sort()).toEqual(doneLinks);
    expect((await getJob(a, d)).snapshot.scenes.every((s: any) => typeof s.imageUrl === 'string')).toBe(true);
  });

  it('완성된 작업은 연결을 끊지 않는다(완료 뒤에도 모든 이미지가 연결돼 있다)', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const ids = sceneImageIds(a, p.id);
    const d = await renderDone(a, p.id);
    expect(linkedImages(a, d).sort()).toEqual([...ids].sort());
  });

  it('다른 진행 중 작업이 같은 이미지를 참조하면 남는다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const q = createSampleProject(a.store);
    // q 의 작업을 먼저 대기열에 넣어 두기 위해, p 작업이 생성 중인 동안 q 작업을 요청한다.
    a.renderer.auto = false;
    const pj = await startRender(a, p.id);
    await waitGenerating(a, pj);
    const qj = await startRender(a, q.id); // 큐는 하나씩 처리하므로 '대기' 상태로 남는다
    expect(jobStatus(a, qj)).toBe('waiting');
    const old = sceneImageIds(a, p.id)[0]!;
    a.store.attachImage(p.id, 0, solidPng(64, 36, [1, 2, 3]), 'n.png');
    // 진행 중 작업이 같은 이미지를 참조하는 상황(프로젝트당 진행 중 작업은 하나라 실제 흐름으로는 만들 수 없어 직접 넣는다)
    db(a).prepare(`INSERT INTO render_job_images (job_id, image_id) VALUES (?, ?)`).run(qj, old);
    a.renderer.fail(imageDecodeFailed(1), 0);
    await waitFor(() => jobStatus(a, pj) === 'failed', 'p 실패');
    expect(linkedImages(a, pj)).toEqual([]);
    expect(imageKept(a, old)).toBe(true);
    expect(linkedImages(a, qj)).toContain(old); // 다른 작업의 연결은 건드리지 않는다
    a.renderer.release(1);
  });

  it('여러 실패 작업이 쓴 이미지: 앞선 실패 뒤엔 장면·진행 중 작업이 써서 남고, 마지막 실패 때 회수된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const x = sceneImageIds(a, p.id)[0]!;
    const f1 = await renderFailed(a, p.id); // 장면이 아직 x 를 쓴다
    expect(imageKept(a, x)).toBe(true);
    const { id: f2, old } = await failAfterReplacing(a, p.id, [0]); // 두 번째 작업도 x 를 참조, 생성 중에 장면은 교체
    expect(old[0]).toBe(x);
    expect(linkedImages(a, f1)).toEqual([]);
    expect(linkedImages(a, f2)).toEqual([]);
    expect(imageRow(a, x)).toBe(false);
  });

  it('실패 기록과 오류 정보는 남고, 실패 기록 삭제는 여전히 409 다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const { id } = await failAfterReplacing(a, p.id, [0]);
    const j = await getJob(a, id);
    expect(j.status).toBe('failed');
    expect(j.error.code).toBe('IMAGE_DECODE_FAILED');
    expect(j.error.scene).toBe(1);
    expect(j.snapshot.scenes).toHaveLength(scenesOf(a, p.id).length);
    expect(j.snapshot.scenes[0].imageFileName).toBeTruthy();
    const res = await a.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/renders/${id}` });
    expect(res.statusCode).toBe(409);
  });

  it('실패 작업의 장면 imageUrl 은 null, 완성 작업은 주소를 준다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const d = await renderDone(a, p.id);
    const f = await renderFailed(a, p.id);
    expect((await getJob(a, f)).snapshot.scenes.every((s: any) => s.imageUrl === null)).toBe(true);
    expect((await getJob(a, d)).snapshot.scenes.every((s: any) => /^\/api\/images\/.+\/file$/.test(s.imageUrl))).toBe(true);
  });

  it('회수가 실패해 이미지가 남아 있어도 실패 작업의 imageUrl 은 null 이다(상태 기준)', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    silenceWarn();
    const { id, old } = await failAfterReplacing(a, p.id, [0], () =>
      vi.spyOn(a.store, 'collectImageIfUnused').mockImplementation(() => {
        throw new Error('boom');
      }),
    );
    expect(imageKept(a, old[0]!)).toBe(true);
    expect((await getJob(a, id)).snapshot.scenes.every((s: any) => s.imageUrl === null)).toBe(true);
  });

  it('실패 뒤 다시 시도(새 작업)는 현재 장면 이미지로 정상 렌더된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    await failAfterReplacing(a, p.id, [0, 2]);
    const d = await renderDone(a, p.id);
    const input = a.renderer.calls.at(-1)!;
    const expected = sceneImageIds(a, p.id).map((id) => imageFile(a, id));
    expect(input.scenes.map((s) => s.imagePath)).toEqual(expected);
    expect(linkedImages(a, d).sort()).toEqual(sceneImageIds(a, p.id).sort());
  });
});

describe('회수 단계별 실패 주입 — 상태는 실패로 남고 큐는 계속 돈다', () => {
  async function expectQueueAlive(a: A, projectId: string) {
    await renderDone(a, projectId);
  }

  it('연결 이미지 id 읽기가 던져도 실패로 기록되고, 다음 작업이 처리되며, 다음 시작 때 정리된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const warn = silenceWarn();
    vi.spyOn(a.renders, 'linkedImageIds').mockImplementation(() => {
      throw new Error('select boom');
    });
    const { id, old } = await failAfterReplacing(a, p.id, [0]);
    expect(jobStatus(a, id)).toBe('failed');
    expect(linkedImages(a, id)).toContain(old[0]);
    expect(imageKept(a, old[0]!)).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('연결 해제 실패'))).toBe(true);
    await expectQueueAlive(a, p.id);

    vi.restoreAllMocks();
    const b = await restart(a);
    expect(linkedImages(b, id)).toEqual([]);
    expect(imageRow(b, old[0]!)).toBe(false);
  });

  it('연결 삭제가 던져도 실패로 기록되고, 다음 작업이 처리되며, 다음 시작 때 정리된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const warn = silenceWarn();
    vi.spyOn(a.renders, 'unlinkImages').mockImplementation(() => {
      throw new Error('delete boom');
    });
    const { id, old } = await failAfterReplacing(a, p.id, [0]);
    expect(jobStatus(a, id)).toBe('failed');
    expect(linkedImages(a, id)).toContain(old[0]);
    expect(imageKept(a, old[0]!)).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('연결 해제 실패'))).toBe(true);
    await expectQueueAlive(a, p.id);

    vi.restoreAllMocks();
    const b = await restart(a);
    expect(linkedImages(b, id)).toEqual([]);
    expect(imageRow(b, old[0]!)).toBe(false);
  });

  it('첫 이미지 회수가 던져도 나머지 이미지는 회수되고, 남은 하나는 다음 시작 때 정리된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const warn = silenceWarn();
    const real = a.store.collectImageIfUnused.bind(a.store);
    let first = true;
    const { id, old } = await failAfterReplacing(a, p.id, [0, 1, 2], () =>
      vi.spyOn(a.store, 'collectImageIfUnused').mockImplementation((imageId: string) => {
        if (first) {
          first = false;
          throw new Error('collect boom');
        }
        return real(imageId);
      }),
    );
    expect(jobStatus(a, id)).toBe('failed');
    expect(linkedImages(a, id)).toEqual([]);
    const left = old.filter((o) => imageRow(a, o));
    expect(left).toHaveLength(1); // 던진 하나만 남는다
    expect(warn.mock.calls.some((c) => String(c[0]).includes('이미지 회수 실패'))).toBe(true);
    await expectQueueAlive(a, p.id);

    vi.restoreAllMocks();
    const b = await restart(a);
    expect(imageRow(b, left[0]!)).toBe(false);
  });
});

describe('서버 시작 때 회수', () => {
  it('연결이 남은 실패 기록(이 기능 이전 데이터)을 정리하고, 다시 시작해도 문제없다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const { id, old } = await failAfterReplacing(a, p.id, [0]);
    // 이 기능 이전 상태를 흉내 낸다: 지워진 이미지 대신 새 이미지를 만들어 실패 작업에 연결해 둔다.
    a.store.attachImage(p.id, 0, solidPng(64, 36, [7, 7, 7]), 'legacy.png');
    const legacyId = scenesOf(a, p.id)[0]!.image!.id;
    db(a).prepare(`INSERT INTO render_job_images (job_id, image_id) VALUES (?, ?)`).run(id, legacyId);
    a.store.attachImage(p.id, 0, solidPng(64, 36, [8, 8, 8]), 'cur.png'); // 장면은 다른 이미지로
    expect(imageKept(a, legacyId)).toBe(true); // 실패 작업 연결이 붙잡고 있다
    const legacyFile = imageFile(a, legacyId)!;
    expect(old).toHaveLength(1);

    const b = await restart(a);
    expect(linkedImages(b, id)).toEqual([]);
    expect(imageRow(b, legacyId)).toBe(false);
    expect(fs.existsSync(legacyFile)).toBe(false);
    for (const cur of sceneImageIds(b, p.id)) expect(imageKept(b, cur)).toBe(true);

    const c = await restart(b); // 멱등
    expect(c.renders.releaseFailedImages()).toBe(0);
    for (const cur of sceneImageIds(c, p.id)) expect(imageKept(c, cur)).toBe(true);
  });

  it('여러 실패 기록이 같은 옛 이미지를 붙잡고 있어도 시작 때 모두 놓아 회수한다. 완성 작업이 함께 쓰면 남긴다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    const f1 = await renderFailed(a, p.id);
    const f2 = await renderFailed(a, p.id);
    const d = await renderDone(a, p.id);
    const [x, y] = sceneImageIds(a, p.id);
    // 두 실패 기록이 x·y 를 붙잡은 옛 데이터를 만든다
    const ins = db(a).prepare(`INSERT INTO render_job_images (job_id, image_id) VALUES (?, ?)`);
    for (const f of [f1, f2]) for (const i of [x!, y!]) ins.run(f, i);
    // 장면에서 x·y 를 교체하고, 완성 작업 d 에서는 x 연결만 남긴다(y 는 실패 기록만 참조)
    db(a).prepare(`DELETE FROM render_job_images WHERE job_id = ? AND image_id = ?`).run(d, y);
    a.store.attachImage(p.id, 0, solidPng(64, 36, [1, 1, 1]), 'a.png');
    a.store.attachImage(p.id, 1, solidPng(64, 36, [2, 2, 2]), 'b.png');
    expect(imageKept(a, x!)).toBe(true);
    expect(imageKept(a, y!)).toBe(true);

    const b = await restart(a);
    expect(linkedImages(b, f1)).toEqual([]);
    expect(linkedImages(b, f2)).toEqual([]);
    expect(imageRow(b, y!)).toBe(false); // 실패 기록만 붙잡던 이미지
    expect(imageKept(b, x!)).toBe(true); // 완성 작업이 쓴다
    expect(linkedImages(b, d)).toContain(x);
  });

  it('충돌 복구 (a): 실패 기록 커밋 뒤 연결 삭제 전에 멈췄어도 다음 시작 때 회수된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    vi.spyOn(a.renders as any, 'releaseImagesOf').mockImplementation(() => undefined); // 후처리 직전에 멈춘 것과 같다
    const { id, old } = await failAfterReplacing(a, p.id, [0]);
    expect(jobStatus(a, id)).toBe('failed');
    expect(linkedImages(a, id)).toContain(old[0]);
    vi.restoreAllMocks();

    const b = await restart(a);
    expect(linkedImages(b, id)).toEqual([]);
    expect(imageRow(b, old[0]!)).toBe(false);
  });

  it('충돌 복구 (b): 연결 삭제 뒤 이미지 회수 전에 멈췄어도 다음 시작 때 회수된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    // 회수 직전에 멈춘 것과 같다
    const { id, old } = await failAfterReplacing(a, p.id, [0], () => vi.spyOn(a.store, 'collectImageIfUnused').mockImplementation(() => false));
    expect(linkedImages(a, id)).toEqual([]);
    const file = imageFile(a, old[0]!)!;
    expect(fs.existsSync(file)).toBe(true);
    vi.restoreAllMocks();

    const b = await restart(a);
    expect(imageRow(b, old[0]!)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('서버가 멈춰 중단된 작업(failInterrupted)도 시작 때 연결이 정리되고 이미지가 회수된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    a.renderer.auto = false;
    const id = await startRender(a, p.id);
    await waitGenerating(a, id);
    const old = sceneImageIds(a, p.id)[0]!;
    a.store.attachImage(p.id, 0, solidPng(64, 36, [4, 5, 6]), 'n.png');
    expect(imageKept(a, old)).toBe(true);

    const b = await restart(a); // 생성 중에 멈춤
    expect(jobStatus(b, id)).toBe('failed');
    expect(linkedImages(b, id)).toEqual([]);
    expect(imageRow(b, old)).toBe(false);
    for (const cur of sceneImageIds(b, p.id)) expect(imageKept(b, cur)).toBe(true);
  });

  it('시작 때 정리가 던져도 서버는 시작되고, 다음 시작 때 정리된다', async () => {
    const a = await setup();
    const p = createSampleProject(a.store);
    vi.spyOn(a.renders as any, 'releaseImagesOf').mockImplementation(() => undefined);
    const { id, old } = await failAfterReplacing(a, p.id, [0]);
    vi.restoreAllMocks();

    await close(a);
    const warn = silenceWarn();
    vi.spyOn(RenderStore.prototype, 'releaseFailedImages').mockImplementation(() => {
      throw new Error('startup boom');
    });
    const b = await setup(a.dataDir);
    expect((await b.app.inject({ url: `/api/projects/${p.id}` })).statusCode).toBe(200);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('이미지 연결 정리 실패'))).toBe(true);
    expect(linkedImages(b, id)).toContain(old[0]); // 이번에는 남는다
    expect(imageKept(b, old[0]!)).toBe(true);
    vi.restoreAllMocks();

    const c = await restart(b);
    expect(linkedImages(c, id)).toEqual([]);
    expect(imageRow(c, old[0]!)).toBe(false);
  });
});
