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

describe('한글 정규화(NFC)', () => {
  it('분해된 한글(NFD)로 저장해도 NFC 로 저장되고, 글자 수 한도는 합친 뒤 센다', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    const nfdTitle = '매장 재고'.normalize('NFD');
    const nfdText = '매'.repeat(150).normalize('NFD'); // NFD 로는 450 칸이지만 NFC 로는 150자
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: validSave({ title: nfdTitle, scenes: [{ text: nfdText, durationSec: 10 }, { text: '둘', durationSec: 10 }, { text: '셋', durationSec: 10 }] }),
    });
    expect(res.statusCode).toBe(200);
    const saved = (await app.inject({ url: `/api/projects/${project.id}` })).json().project;
    expect(saved.title).toBe('매장 재고');
    expect(saved.title).toBe(saved.title.normalize('NFC'));
    expect(saved.scenes[0].text).toBe('매'.repeat(150));
    // 합쳐도 200자를 넘으면 거부
    const tooLong = await app.inject({
      method: 'PUT',
      url: `/api/projects/${project.id}`,
      payload: validSave({ scenes: [{ text: '매'.repeat(201).normalize('NFD'), durationSec: 10 }, { text: '', durationSec: 10 }, { text: '', durationSec: 10 }] }),
    });
    expect(tooLong.statusCode).toBe(400);
  });
});

describe('저장 경계의 문구 정리(보이지 않는 문자·줄바꿈)', () => {
  async function put(app: any, id: string, title: string, text: string) {
    return app.inject({
      method: 'PUT',
      url: `/api/projects/${id}`,
      payload: validSave({ title, scenes: [{ text, durationSec: 10 }, { text: '', durationSec: 10 }, { text: '', durationSec: 10 }] }),
    });
  }
  const textOf = async (app: any, id: string) => (await app.inject({ url: `/api/projects/${id}` })).json().project.scenes[0].text as string;

  it('제로폭 문자는 DB 에 남지 않고, 영상·미리보기와 같은 글자가 저장된다', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    expect((await put(app, project.id, 't', '가\u200B나다')).statusCode).toBe(200);
    expect(await textOf(app, project.id)).toBe('가나다');
    for (const junk of ['\u200D', '\uFEFF', '\uFE0F', '\u202E', '\u0007']) {
      await put(app, project.id, 't', `가${junk}나다`);
      expect(await textOf(app, project.id), `U+${junk.charCodeAt(0).toString(16)}`).toBe('가나다');
    }
  });

  it('글자 수 한도는 정리한 뒤의 글자로 센다(영상에서 제거될 문자 때문에 거부하지 않는다)', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    // 보이는 글자 200개 + 제로폭 문자 여러 개: 정리하면 200자라서 저장된다
    const ok = await put(app, project.id, 't', '가'.repeat(100) + '\u200B\u200D\uFEFF' + '나'.repeat(100) + '\u200B');
    expect(ok.statusCode).toBe(200);
    expect(Array.from(await textOf(app, project.id))).toHaveLength(200);
    // 보이는 글자가 201개면 제로폭 문자와 상관없이 거부
    const over = await put(app, project.id, 't', '가'.repeat(201) + '\u200B');
    expect(over.statusCode).toBe(400);
  });

  it('CRLF·CR 은 \\n 으로 통일되고, 제목은 한 줄로 정리된다', async () => {
    const { app } = await setup();
    const { project } = (await app.inject({ method: 'POST', url: '/api/projects' })).json();
    await put(app, project.id, '매장\n재고\u200B', '첫째\r\n둘째\r셋째');
    const saved = (await app.inject({ url: `/api/projects/${project.id}` })).json().project;
    expect(saved.scenes[0].text).toBe('첫째\n둘째\n셋째');
    expect(saved.title).toBe('매장 재고');
  });
});

describe('Store 쓰기 시점의 정리(저장 불변식)', () => {
  it('스키마를 거치지 않고 Store 를 직접 호출해도 보이지 않는 문자·NFD 는 저장되지 않는다', async () => {
    const a = await setup();
    const p = a.store.createProject({ title: '매\u200B장'.normalize('NFD') });
    expect(p.title).toBe('매장');
    const saved = a.store.saveProject(p.id, {
      title: '재고\u200B관리',
      scenes: [
        { text: '가\u200B나다', durationSec: 10 },
        { text: '라마'.normalize('NFD'), durationSec: 10 },
        { text: '바\r\n사', durationSec: 10 },
      ],
    });
    expect(saved.title).toBe('재고관리');
    expect(saved.scenes.map((s) => s.text)).toEqual(['가나다', '라마', '바\n사']);
    // 이미 정리된 값은 그대로(멱등)
    const again = a.store.saveProject(p.id, { title: saved.title, scenes: saved.scenes.map((s) => ({ text: s.text, durationSec: s.durationSec })) });
    expect(again.scenes.map((s) => s.text)).toEqual(['가나다', '라마', '바\n사']);
  });
});
