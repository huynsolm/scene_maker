import { afterEach, describe, expect, it } from 'vitest';
import { makeApp, validSave } from './helpers';

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
async function setup() {
  const a = await makeApp();
  apps.push(a.app);
  return a;
}

describe('프로젝트 저장', () => {
  it('새 프로젝트는 장면 3개(각 10초)와 편집 중 상태로 만들어진다', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/projects' });
    expect(res.statusCode).toBe(201);
    const { project } = res.json();
    expect(project.status).toBe('editing');
    expect(project.scenes).toHaveLength(3);
    expect(project.scenes.map((s: any) => s.durationSec)).toEqual([10, 10, 10]);
    expect(project.scenes.every((s: any) => s.image === null)).toBe(true);
  });

  it('저장한 제목·문구·길이는 다시 조회해도 유지되고 서버를 다시 띄워도 남는다', async () => {
    const first = await setup();
    const { project } = (await first.app.inject({ method: 'POST', url: '/api/projects' })).json();
    const put = await first.app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: validSave({ title: '매장 재고 관리 사용법' }),
    });
    expect(put.statusCode).toBe(200);
    await first.app.close();
    apps.length = 0;

    const second = await makeApp(first.dataDir);
    apps.push(second.app);
    const got = (await second.app.inject({ url: `/api/projects/${project.id}` })).json().project;
    expect(got.title).toBe('매장 재고 관리 사용법');
    expect(got.scenes.map((s: any) => s.text)).toEqual(['하나', '둘', '셋']);
    const list = (await second.app.inject({ url: '/api/projects' })).json().projects;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: '매장 재고 관리 사용법', totalSec: 30, status: 'editing' });
  });

  it('없는 프로젝트는 404', async () => {
    const { app } = await setup();
    const res = await app.inject({ url: '/api/projects/00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('장면 길이 · 입력 검증', () => {
  const bad: Array<[string, unknown]> = [
    ['2초(최소 미만)', 2],
    ['31초(최대 초과)', 31],
    ['0초', 0],
    ['음수', -5],
    ['소수', 10.5],
    ['문자열', '10'],
    ['null', null],
  ];
  for (const [label, value] of bad) {
    it(`장면 길이 ${label}는 거부하고 기존 내용을 바꾸지 않는다`, async () => {
      const { app } = await setup();
      const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
      await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: validSave() });

      const res = await app.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}`,
        payload: validSave({
          title: '바뀌면 안 되는 제목',
          scenes: [{ text: 'x', durationSec: value }, { text: 'y', durationSec: 10 }, { text: 'z', durationSec: 10 }],
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_INPUT');

      const after = (await app.inject({ url: `/api/projects/${project.id}` })).json().project;
      expect(after.title).toBe('제목');
      expect(after.scenes[0].text).toBe('하나');
    });
  }

  it('경계값 3초와 30초는 허용한다', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: validSave({ scenes: [{ text: '', durationSec: 3 }, { text: '', durationSec: 30 }, { text: '', durationSec: 10 }] }),
    });
    expect(res.statusCode).toBe(200);
  });

  it('장면이 3개가 아니거나 글자 수·제목이 한도를 넘으면 거부한다', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    const put = (payload: unknown) => app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: payload as object });
    expect((await put(validSave({ scenes: [{ text: 'a', durationSec: 10 }] }))).statusCode).toBe(400);
    expect((await put(validSave({ title: 'a'.repeat(101) }))).statusCode).toBe(400);
    expect(
      (await put(validSave({ scenes: Array(3).fill({ text: 'a'.repeat(201), durationSec: 10 }) }))).statusCode,
    ).toBe(400);
    expect((await put({})).statusCode).toBe(400);
  });

  it('빈 제목과 빈 문구는 임시 저장으로 허용한다(누락 검사는 영상 생성 전에 한다)', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: validSave({ title: '', scenes: Array(3).fill({ text: '', durationSec: 10 }) }),
    });
    expect(res.statusCode).toBe(200);
  });
});
