import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { solidPng } from '../server/solidPng';
import { createSampleProject } from '../server/seed';
import { startEnv, type Env } from './harness';

let env: Env;
beforeAll(async () => {
  env = await startEnv();
});
afterAll(async () => {
  await env.close();
});

const tmp = (name: string, data: Buffer) => {
  const p = path.join(env.dataDir, `_fixture_${name}`);
  fs.writeFileSync(p, data);
  return p;
};
const saveState = (page: Page) => page.getByTestId('save-state');
const toast = (page: Page) => page.locator('.toast');

// Playwright 의 locator/expect 를 쓰기 위해 vitest expect 대신 간단한 대기 도우미를 둔다.
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
const text = (page: Page, sel: string) => page.locator(sel).first().innerText();
const hasText = (page: Page, sel: string, needle: string | RegExp) => async () => {
  const t = await page.locator(sel).first().innerText({ timeout: 500 });
  return typeof needle === 'string' ? t.includes(needle) : needle.test(t);
};
const visible = (page: Page, sel: string) => async () => page.locator(sel).first().isVisible();
const inputValue = (page: Page, sel: string, v: string) => async () => (await page.locator(sel).first().inputValue()) === v;
const count = (page: Page, sel: string, n: number) => async () => (await page.locator(sel).count()) === n;

async function newProject(page: Page) {
  await page.goto(env.base + '/');
  await page.locator('button:has-text("새 영상 만들기"), button:has-text("첫 영상 만들기")').last().click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await page.getByLabel('영상 제목').waitFor();
}
const projectIdOf = (page: Page) => page.url().split('/').pop()!;
const SAVE = '[data-testid=save-state]';

describe('1단계 화면 흐름', () => {
  it('빈 목록에서 첫 영상 만들기 → 입력 → 저장됨 → 새로고침 후에도 유지', async () => {
    const page = await env.newPage();
    await page.goto(env.base + '/');
    await eventually(hasText(page, 'main', '아직 만든 영상이 없어요'), '빈 상태');

    await page.getByRole('button', { name: '첫 영상 만들기' }).click();
    await page.waitForURL(/\/projects\//);
    await page.getByLabel('영상 제목').fill('새로고침 테스트');
    await page.locator('#scene-text').fill('첫 장면 문구입니다');
    await page.getByLabel('1초 줄이기').click(); // 10 → 9
    await eventually(hasText(page, SAVE, '저장 중'), '저장 중 표시');
    await eventually(hasText(page, SAVE, '저장됨'), '저장됨 표시');

    await page.reload();
    await eventually(inputValue(page, '.title-input', '새로고침 테스트'), '제목 유지');
    await eventually(inputValue(page, '#scene-text', '첫 장면 문구입니다'), '문구 유지');
    await eventually(inputValue(page, 'input[aria-label="장면 길이(초)"]', '9'), '길이 유지');
    await eventually(hasText(page, '.total-chip strong', '29초'), '전체 길이 29초');

    await page.goto(env.base + '/');
    await eventually(hasText(page, '.table', '새로고침 테스트'), '목록에 표시');
    await eventually(hasText(page, '.table', '장면 3개 · 29초'), '구성 표시');
    await eventually(hasText(page, '.table', '편집 중'), '상태 표시');
    await page.close();
  });

  it('새 영상 만들기를 같은 틱에 두 번 눌러도 프로젝트는 1개만 만들어진다', async () => {
    const page = await env.newPage();
    await page.goto(env.base + '/');
    await eventually(visible(page, '.list-main'), '목록');
    const before = ((await (await fetch(`${env.base}/api/projects`)).json()) as any).projects.length;
    await page.getByRole('button', { name: '+ 새 영상 만들기' }).evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });
    await page.waitForURL(/\/projects\//);
    await page.getByLabel('영상 제목').waitFor();
    const after = ((await (await fetch(`${env.base}/api/projects`)).json()) as any).projects.length;
    expect(after - before).toBe(1);
    await page.close();
  });

  it('분해된 한글(NFD)을 붙여 넣으면 NFC 로 합쳐져 글자 수 한도에 잘리지 않는다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const nfd = '매'.repeat(150).normalize('NFD'); // 붙여 넣은 원문은 450 칸(maxLength 200 을 넘는다)
    await page.locator('#scene-text').focus();
    await page.evaluate((t) => {
      const el = document.getElementById('scene-text') as HTMLTextAreaElement;
      const data = new DataTransfer();
      data.setData('text', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, nfd);
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === '매'.repeat(150), 'NFC 로 합쳐 150자 모두 유지');
    await eventually(hasText(page, '.col-inspector', '150 / 40자 권장'), '글자 수 150');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    await page.reload();
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === '매'.repeat(150), '새로고침 후에도 유지');
    await page.close();
  });

  it('붙여 넣은 글의 제로폭 문자는 제거되어 글자 수와 저장 값에 들어가지 않는다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const pasted = '가\u200B나\u200D다\uFEFF라';
    await page.locator('#scene-text').focus();
    await page.evaluate((t) => {
      const el = document.getElementById('scene-text') as HTMLTextAreaElement;
      const data = new DataTransfer();
      data.setData('text', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === '가나다라', '제로폭 문자 제거');
    await eventually(hasText(page, '.col-inspector', '4 / 40자 권장'), '글자 수 4');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    const id = page.url().split('/').pop()!;
    const saved = (await (await fetch(`${env.base}/api/projects/${id}`)).json()) as any;
    expect(saved.project.scenes[0].text).toBe('가나다라');
    await page.close();
  });

  it('제목에도 붙여넣기 정리가 적용되어 제로폭 문자 때문에 보이는 글자가 잘리지 않는다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const visible100 = '가'.repeat(100);
    await page.getByLabel('영상 제목').focus();
    await page.evaluate((t) => {
      const el = document.querySelector('.title-input') as HTMLInputElement;
      const data = new DataTransfer();
      data.setData('text', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, '\u200B' + visible100); // 원문은 101 칸(maxLength 100 을 넘는다)
    await eventually(async () => (await page.getByLabel('영상 제목').inputValue()) === visible100, '보이는 100자가 모두 유지됨');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    const id = page.url().split('/').pop()!;
    expect(((await (await fetch(`${env.base}/api/projects/${id}`)).json()) as any).project.title).toBe(visible100);
    await page.close();
  });

  it('200자 경계에서 붙여 넣어도 이모지를 쪼개지 않는다(깨진 문자열이 되지 않음)', async () => {
    const page = await env.newPage();
    await newProject(page);
    await page.locator('#scene-text').fill('a'.repeat(199));
    await page.locator('#scene-text').focus();
    await page.evaluate(() => {
      const el = document.getElementById('scene-text') as HTMLTextAreaElement;
      el.setSelectionRange(el.value.length, el.value.length);
      const data = new DataTransfer();
      data.setData('text', '\u200B😀'); // 정리하면 이모지만 남아 합이 UTF-16 201 칸
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === 'a'.repeat(199), '이모지를 통째로 버리고 199자 유지');
    expect(await page.locator('#scene-text').evaluate((el) => (el as HTMLTextAreaElement).value.isWellFormed())).toBe(true);
    await page.close();
  });

  it('붙여넣기가 아닌 입력으로 들어온 보이지 않는 문자도 저장 뒤 화면이 서버가 정리한 값으로 맞춰진다', async () => {
    const page = await env.newPage();
    await newProject(page);
    // fill 은 paste 가 아니라 input 이벤트로 값을 넣는다(드래그 앤 드롭·자동 완성 같은 경로)
    await page.locator('#scene-text').fill('가\u200B나다');
    await page.getByLabel('영상 제목').fill('매\u200B장 재고');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === '가나다', '문구가 정리된 값으로 맞춰짐');
    await eventually(async () => (await page.getByLabel('영상 제목').inputValue()) === '매장 재고', '제목이 정리된 값으로 맞춰짐');
    await eventually(hasText(page, '.col-inspector', '3 / 40자 권장'), '글자 수 3');
    // 맞춘 값이 다시 저장되는 반복은 없다: 잠시 뒤에도 저장됨 상태
    await new Promise((r) => setTimeout(r, 1500));
    expect((await page.locator('[data-testid=save-state]').innerText()).includes('저장됨')).toBe(true);
    await page.reload();
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === '가나다', '새로고침 후에도 같음');
    await page.close();
  });

  it('붙여넣기가 아닌 입력으로 원문 100칸이지만 정리하면 101칸인 제목도 저장이 거절되지 않고 한도에 맞춰진다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const raw = 'A'.repeat(98) + '\u01FA' + '\u0323'; // maxLength 는 통과하지만 NFC 로 101칸
    await page.getByLabel('영상 제목').fill(raw);
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨(거절되지 않음)');
    await eventually(async () => (await page.getByLabel('영상 제목').inputValue()).length <= 100, '제목이 한도 이내로 맞춰짐');
    expect((await page.getByLabel('영상 제목').inputValue()).startsWith('A'.repeat(98))).toBe(true);
    await page.close();
  });

  it('실제 장면 수보다 큰 ?scene= 값(오래된 링크)으로 열어도 화면이 깨지지 않고 마지막 장면이 선택된다', async () => {
    const page = await env.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await newProject(page);
    const id = projectIdOf(page);
    await page.goto(`${env.base}/projects/${id}?scene=4`); // 기본 장면은 3개
    await page.getByLabel('영상 제목').waitFor();
    await eventually(hasText(page, '.col-inspector', '장면 3 편집'), '마지막 장면(3)이 선택됨');
    await page.goto(`${env.base}/projects/${id}?scene=10`);
    await page.getByLabel('영상 제목').waitFor();
    await eventually(hasText(page, '.col-inspector', '장면 3 편집'), '범위를 넘어도 마지막 장면');
    expect(errors).toEqual([]);
    await page.close();
  });

  describe('장면 추가·삭제', () => {
    const cards = (page: Page) => page.locator('[data-testid^=scene-card-]');
    const saved = (page: Page) => hasText(page, SAVE, '저장됨');

    it('장면을 추가하면 새 장면이 선택되고, 입력한 내용이 새로고침 뒤에도 남는다', async () => {
      const page = await env.newPage();
      await newProject(page);
      expect(await cards(page).count()).toBe(3);
      await page.getByTestId('add-scene').click();
      await eventually(async () => (await cards(page).count()) === 4, '장면 4개');
      await eventually(hasText(page, '.col-inspector', '장면 4 편집'), '새 장면(4)이 선택됨');
      await eventually(hasText(page, '.col-scenes', '장면 4개가 순서대로'), '개수 안내');
      await page.locator('#scene-text').fill('네 번째 장면');
      await eventually(saved(page), '저장됨');
      await page.reload();
      await page.getByLabel('영상 제목').waitFor();
      expect(await cards(page).count()).toBe(4);
      await cards(page).nth(3).click();
      await eventually(async () => (await page.locator('#scene-text').inputValue()) === '네 번째 장면', '내용 유지');
      await page.close();
    });

    it('최대 10개에서 추가 버튼이 막히고, 최소 1개에서 삭제 버튼이 막힌다', async () => {
      const page = await env.newPage();
      await newProject(page);
      for (let n = 3; n < 10; n++) {
        await page.getByTestId('add-scene').click();
        await eventually(async () => (await cards(page).count()) === n + 1, `장면 ${n + 1}개`);
      }
      expect(await page.getByTestId('add-scene').isDisabled()).toBe(true);
      expect(await page.getByTestId('add-scene').innerText()).toContain('최대 10개');
      for (let n = 10; n > 1; n--) {
        await page.getByTestId('delete-scene').click();
        await page.getByTestId('confirm-delete-scene').click();
        await eventually(async () => (await cards(page).count()) === n - 1, `장면 ${n - 1}개`);
      }
      expect(await page.getByTestId('delete-scene').isDisabled()).toBe(true);
      await page.close();
    });

    it('삭제는 확인을 거치고(취소하면 그대로), 지운 뒤 뒤 장면의 내용이 앞으로 당겨진다. 삭제 직전에 입력한 내용도 잃지 않는다', async () => {
      const page = await env.newPage();
      await newProject(page);
      for (let i = 0; i < 3; i++) {
        await cards(page).nth(i).click();
        await page.locator('#scene-text').fill(`문구 ${i + 1}`);
      }
      await cards(page).nth(1).click();
      await page.getByTestId('delete-scene').click();
      await page.getByRole('button', { name: '취소' }).click();
      expect(await cards(page).count()).toBe(3); // 취소하면 그대로
      // 마지막 입력이 아직 저장되기 전(디바운스 중)에 삭제를 확인해도 먼저 저장된다
      await page.getByTestId('delete-scene').click();
      await page.getByTestId('confirm-delete-scene').click();
      await eventually(async () => (await cards(page).count()) === 2, '장면 2개');
      await eventually(hasText(page, '[data-testid=scene-card-1]', '문구 3'), '뒤 장면이 당겨짐');
      await eventually(saved(page), '저장됨');
      await page.reload();
      await page.getByLabel('영상 제목').waitFor();
      expect(await cards(page).count()).toBe(2);
      expect(await cards(page).nth(0).innerText()).toContain('문구 1');
      expect(await cards(page).nth(1).innerText()).toContain('문구 3');
      await page.close();
    });

    it('프로젝트 목록 카드가 실제 장면 수를 보여준다', async () => {
      const page = await env.newPage();
      await newProject(page);
      await page.getByTestId('add-scene').click();
      await eventually(async () => (await cards(page).count()) === 4, '장면 4개');
      await eventually(saved(page), '저장됨');
      await page.goto(env.base + '/');
      await eventually(async () => (await page.locator('body').innerText()).includes('장면 4개'), '목록에 장면 4개');
      await page.close();
    });

    /** 문구·이미지가 모두 채워진 프로젝트(바로 영상을 만들 수 있다). */
    function completeProject(title: string) {
      const p = env.store.createProject({ title });
      env.store.saveProject(p.id, { title, scenes: [0, 1, 2].map((i) => ({ text: `장면 ${i + 1} 문구`, durationSec: 3 })) });
      [0, 1, 2].forEach((i) => env.store.attachImage(p.id, i, solidPng(1280, 720, [40 * i + 20, 90, 160]), `c${i}.png`));
      return p;
    }
    /** 서버는 바로 처리하고 응답만 늦게 돌려준다(응답 순서가 뒤바뀌는 상황을 만든다). */
    const delayResponse = async (page: Page, urlRe: RegExp, method: string, ms: number, log?: string[], tag?: string) =>
      page.route(urlRe, async (route) => {
        if (route.request().method() !== method) return route.continue();
        log?.push(`${tag}:request`);
        const res = await route.fetch();
        await new Promise((r) => setTimeout(r, ms));
        log?.push(`${tag}:response`);
        await route.fulfill({ response: res });
      });

    it('삭제 확인 창: Tab 이 창 안에서만 돌고, Esc 로 닫으면 열었던 버튼으로 초점이 돌아온다', async () => {
      const page = await env.newPage();
      await newProject(page);
      const del = page.getByTestId('delete-scene');
      await del.focus();
      await del.press('Enter');
      const dialog = page.getByRole('dialog');
      await dialog.waitFor();
      const inDialog = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('취소'); // 안전한 쪽에서 시작
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press('Tab');
        expect(await inDialog(), `Tab ${i + 1}`).toBe(true);
      }
      // 취소(첫 요소)에서 Shift+Tab 은 마지막 요소(삭제)로 간다
      await page.evaluate(() => (document.querySelector('[role=dialog] [data-autofocus]') as HTMLElement).focus());
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('confirm-delete-scene');
      await page.keyboard.press('Escape');
      await eventually(async () => (await dialog.count()) === 0, '창 닫힘');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('delete-scene');
      await page.close();
    });

    it('장면을 추가·삭제하는 중에는 영상 만들기를 시작할 수 없고, 끝나면 다시 쓸 수 있다', async () => {
      const p = completeProject('구조 변경 중 생성');
      const page = await env.newPage();
      await page.goto(`${env.base}/projects/${p.id}`);
      await page.getByLabel('영상 제목').waitFor();
      await delayResponse(page, /\/api\/projects\/[^/]+\/scenes$/, 'POST', 1500);
      await page.getByTestId('add-scene').click();
      await eventually(async () => await page.getByTestId('open-render').isDisabled(), '진행 중에는 비활성화');
      await eventually(async () => (await cards(page).count()) === 4, '장면 4개');
      await eventually(async () => !(await page.getByTestId('open-render').isDisabled()), '끝나면 활성화');
      await page.close();
    });

    it('이미지 업로드가 끝나기 전에 영상을 요청해도 업로드가 끝난 뒤의 내용으로 만들어진다', async () => {
      const p = completeProject('업로드 중 생성');
      const page = await env.newPage();
      await page.goto(`${env.base}/projects/${p.id}`);
      await page.getByLabel('영상 제목').waitFor();
      const log: string[] = [];
      await delayResponse(page, /\/api\/projects\/[^/]+\/scenes\/[^/]+\/image$/, 'POST', 1500, log, 'upload');
      page.on('request', (r) => r.method() === 'POST' && /\/renders$/.test(r.url()) && log.push('render:request'));
      await page.getByTestId('file-input').setInputFiles(tmp('replace.png', solidPng(320, 180, [250, 10, 10])));
      await eventually(async () => log.includes('upload:request'), '업로드 요청이 서버에 도착');
      await page.getByTestId('open-render').click();
      await page.getByRole('button', { name: '영상 만들기 시작' }).click();
      await eventually(async () => log.includes('render:request'), '렌더 요청', 12000);
      expect(log.indexOf('upload:response')).toBeGreaterThanOrEqual(0);
      expect(log.indexOf('render:request')).toBeGreaterThan(log.indexOf('upload:response')); // 업로드가 끝난 뒤에 요청한다
      await page.close();
    });

    it('늦게 도착한 장면 추가 응답이 그 사이 올린 이미지를 화면에서 지우지 않는다', async () => {
      const p = completeProject('응답 순서');
      const page = await env.newPage();
      await page.goto(`${env.base}/projects/${p.id}`);
      await page.getByLabel('영상 제목').waitFor();
      await delayResponse(page, /\/api\/projects\/[^/]+\/scenes$/, 'POST', 1500);
      await page.getByTestId('add-scene').click(); // 서버는 바로 처리하지만 응답은 1.5초 뒤에 도착한다
      await cards(page).nth(0).click();
      await page.getByTestId('file-input').setInputFiles(tmp('late.png', solidPng(320, 180, [10, 250, 10])));
      await eventually(async () => (await cards(page).count()) === 4, '장면 4개');
      const thumbSrc = async () => page.locator('[data-testid=scene-card-0] img').getAttribute('src');
      await eventually(async () => (await page.locator('[data-testid=scene-card-0] img').count()) === 1, '썸네일이 보임');
      const shown = await page.evaluate(async () => {
        const img = document.querySelector('[data-testid=scene-card-0] img') as HTMLImageElement;
        return { w: img.naturalWidth, h: img.naturalHeight };
      });
      expect(shown).toEqual({ w: 320, h: 180 }); // 새로 올린 이미지(320x180)가 보인다(원래 1280x720 이 아니다)
      expect(await thumbSrc()).toBeTruthy();
      await page.close();
    });

    it('새로 불러온 뒤에 도착한 이전 저장의 409 응답이 충돌 안내를 다시 켜지 않는다', async () => {
      const a = await env.newPage();
      await newProject(a);
      const id = projectIdOf(a);
      const b = await env.newPage();
      await b.goto(`${env.base}/projects/${id}`);
      await b.getByLabel('영상 제목').waitFor();
      await a.locator('[data-testid=scene-card-1]').click();
      await a.getByTestId('delete-scene').click();
      await a.getByTestId('confirm-delete-scene').click();
      await eventually(async () => (await cards(a).count()) === 2, 'a: 장면 2개');
      await b.locator('#scene-text').fill('첫 입력'); // 첫 저장은 바로 409
      await eventually(async () => (await b.getByTestId('scenes-conflict').count()) === 1, '충돌 안내');
      // 이후의 저장 요청은 서버가 처리한 응답(409)을 3초 늦게 돌려준다
      let inFlight = 0;
      await b.route(new RegExp(`/api/projects/${id}$`), async (route) => {
        if (route.request().method() !== 'PUT') return route.continue();
        inFlight++;
        const res = await route.fetch();
        await new Promise((r) => setTimeout(r, 3000));
        await route.fulfill({ response: res });
      });
      await b.locator('#scene-text').fill('두 번째 입력');
      await eventually(async () => inFlight === 1, '늦은 저장 요청이 나감');
      await b.getByRole('button', { name: '새로 불러오기' }).click();
      await eventually(async () => (await b.getByTestId('scenes-conflict').count()) === 0 && (await cards(b).count()) === 2, '새로 불러옴');
      // 늦은 409 가 도착하기 전에(이전 저장이 아직 진행 중일 때) 새 화면에서 입력한다. 이 입력도 저장되어야 한다.
      await b.locator('#scene-text').fill('새로 불러온 뒤 입력');
      await new Promise((r) => setTimeout(r, 3500)); // 늦은 409 가 도착할 시간
      expect(await b.getByTestId('scenes-conflict').count()).toBe(0);
      await eventually(hasText(b, SAVE, '저장됨'), '새 입력이 저장됨(멈추지 않음)', 10000);
      const after = await fetch(`${env.base}/api/projects/${id}`).then((r) => r.json());
      expect(after.project.scenes[0].text).toBe('새로 불러온 뒤 입력');
      await a.close();
      await b.close();
    });

    it('새로 불러오기 전에 줄 서 있던 이미지 요청은 새로 불러온 뒤 실행되지 않는다', async () => {
      const p = completeProject('줄 선 요청');
      const a = await env.newPage();
      await a.goto(`${env.base}/projects/${p.id}`);
      await a.getByLabel('영상 제목').waitFor();
      const b = await env.newPage();
      await b.goto(`${env.base}/projects/${p.id}`);
      await b.getByLabel('영상 제목').waitFor();
      // a 에서 장면 3을 지워 b 를 오래된 화면으로 만든다
      await a.locator('[data-testid=scene-card-2]').click();
      await a.getByTestId('delete-scene').click();
      await a.getByTestId('confirm-delete-scene').click();
      await eventually(async () => (await cards(a).count()) === 2, 'a: 장면 2개');
      await b.locator('#scene-text').fill('충돌 유발');
      await eventually(async () => (await b.getByTestId('scenes-conflict').count()) === 1, '충돌 안내');
      // b: 장면 1의 이미지를 바꾸는 업로드가 나간 뒤(요청이 서버에 닿는 데 3초 걸린다), 장면 2의 이미지 삭제를 줄 세운다
      await b.route(/\/api\/projects\/[^/]+\/scenes\/[^/]+\/image$/, async (route) => {
        if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 3000));
        await route.continue();
      });
      await b.getByTestId('file-input').setInputFiles(tmp('queued.png', solidPng(320, 180, [10, 10, 250])));
      await b.locator('[data-testid=scene-card-1]').click();
      await b.getByRole('button', { name: '삭제', exact: true }).click(); // 이미지 삭제(장면 삭제 버튼은 'delete-scene')
      await b.getByRole('button', { name: '새로 불러오기' }).click();
      await new Promise((r) => setTimeout(r, 4500)); // 업로드가 끝나고 줄 선 삭제가 (실행된다면) 실행될 시간
      await eventually(async () => (await cards(b).count()) === 2, 'b: 새로 불러옴');
      const server = await fetch(`${env.base}/api/projects/${p.id}`).then((r) => r.json());
      expect(server.project.scenes[1].image).not.toBeNull(); // 줄 서 있던 삭제는 실행되지 않았다
      const shown = await b.locator('[data-testid=scene-card-1] img').getAttribute('src');
      expect(shown).toBe(server.project.scenes[1].image.url); // 화면과 서버가 같다
      // 새로 불러오기가 나간 업로드가 끝나기를 기다렸으므로 화면이 업로드 결과를 보여준다
      expect(await b.locator('[data-testid=scene-card-0] img').getAttribute('src')).toBe(server.project.scenes[0].image.url);
      expect(server.project.scenes[0].image.fileName).toBe('_fixture_queued.png'); // 테스트 도우미가 붙이는 접두사
      await a.close();
      await b.close();
    });

    it('다른 화면에서 장면이 바뀌면 저장이 거절되고 안내 후 새로 불러올 수 있다(지운 장면이 되살아나지 않는다)', async () => {
      const a = await env.newPage();
      await newProject(a);
      const id = projectIdOf(a);
      const b = await env.newPage();
      await b.goto(`${env.base}/projects/${id}`);
      await b.getByLabel('영상 제목').waitFor();
      // a 에서 장면 2를 지운다
      await a.locator('[data-testid=scene-card-1]').click();
      await a.getByTestId('delete-scene').click();
      await a.getByTestId('confirm-delete-scene').click();
      await eventually(async () => (await cards(a).count()) === 2, 'a: 장면 2개');
      // 오래된 화면 b 에서 입력하면 자동 저장이 409 로 거절된다
      await b.locator('#scene-text').fill('오래된 화면의 입력');
      await eventually(async () => (await b.getByTestId('scenes-conflict').count()) === 1, '충돌 안내');
      const server = await fetch(`${env.base}/api/projects/${id}`).then((r) => r.json());
      expect(server.project.scenes).toHaveLength(2);
      expect(server.project.scenes.every((s: any) => s.text !== '오래된 화면의 입력')).toBe(true);
      await b.getByRole('button', { name: '새로 불러오기' }).click();
      await eventually(async () => (await cards(b).count()) === 2 && (await b.getByTestId('scenes-conflict').count()) === 0, '새로 불러옴');
      await a.close();
      await b.close();
    });
  });

  it('붙여넣기: 꽉 찬 제목의 기존 뒷글자는 지워지지 않고, 커서는 삽입 끝에 놓인다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const paste = (selector: string, start: number, end: number, text: string) =>
      page.evaluate(
        ([sel, st, en, t]) => {
          const el = document.querySelector(sel as string) as HTMLInputElement | HTMLTextAreaElement;
          el.focus();
          el.setSelectionRange(st as number, en as number);
          const data = new DataTransfer();
          data.setData('text', t as string);
          el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        },
        [selector, start, end, text] as const,
      );
    // 1) 제목이 가득(100자)일 때 맨 앞에 붙여 넣어도 기존 글(Z)은 그대로
    await page.getByLabel('영상 제목').fill('A'.repeat(99) + 'Z');
    await paste('.title-input', 0, 0, '\u200BX');
    await new Promise((r) => setTimeout(r, 200));
    expect(await page.getByLabel('영상 제목').inputValue()).toBe('A'.repeat(99) + 'Z');
    // 2) 남은 자리만큼만 들어간다
    await page.getByLabel('영상 제목').fill('A'.repeat(90));
    await paste('.title-input', 0, 0, '\u200B' + 'X'.repeat(20));
    await eventually(async () => (await page.getByLabel('영상 제목').inputValue()) === 'X'.repeat(10) + 'A'.repeat(90), '남은 10자리만 삽입');
    // 3) 앞부분에 보이지 않는 문자가 있어도 커서는 삽입한 글 바로 뒤
    await page.locator('#scene-text').fill('\u200BABC');
    await paste('#scene-text', 2, 2, '\u200BX'); // 원문에서 A 바로 뒤
    await eventually(async () => (await page.locator('#scene-text').inputValue()) === 'AXBC', 'AXBC');
    await eventually(async () => (await page.locator('#scene-text').evaluate((el) => (el as HTMLTextAreaElement).selectionStart)) === 2, '커서는 X 뒤(2)');
    await page.close();
  });

  it('IME 조합 중에 받은 정리 응답은 조합이 끝난 뒤 반영되고, 그 사이 더 입력했다면 오래된 응답으로 덮어쓰지 않는다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const box = page.locator('#scene-text');
    const fire = (type: string) => box.evaluate((el, t) => el.dispatchEvent(new CompositionEvent(t, { bubbles: true })), type);

    // A) 조합 중 저장 응답이 도착해도 값은 바뀌지 않고(조합 보호), 조합이 끝나면 정리된 값으로 맞춰진다
    await box.focus();
    await fire('compositionstart');
    await box.fill('매\u200B장');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '조합 중에도 저장됨');
    await new Promise((r) => setTimeout(r, 400));
    expect(await box.inputValue()).toBe('매\u200B장'); // 조합 중이라 아직 그대로
    await fire('compositionend'); // 이후 추가 입력(onChange)이 없다
    await eventually(async () => (await box.inputValue()) === '매장', '조합 종료 후 정리된 값으로 맞춰짐');
    expect(await page.locator('[data-testid=save-state]').innerText()).toContain('저장됨');

    // B) 조합이 끝나는 순간 마지막 입력이 이어지면(브라우저에 따라 순서가 다르다) 보관한 응답은 오래된 것이므로 버린다
    await box.focus();
    await fire('compositionstart');
    await box.fill('가\u200B나');
    await eventually(async () => (await page.locator('[data-testid=save-state]').innerText()).includes('저장됨'), '저장됨(응답 보관)');
    await new Promise((r) => setTimeout(r, 300));
    // compositionend 와 마지막 input 이 **같은 틱**에 연달아 온다(별도 evaluate 로 보내면 그 사이에 타이머가 먼저 돌아 경쟁이 생기지 않는다)
    await box.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(el, '가\u200B나\u200B다');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await eventually(async () => (await box.inputValue()) === '가나다', '최신 입력을 지우지 않고 정리된 값으로 수렴');
    await eventually(hasText(page, '[data-testid=save-state]', '저장됨'), '저장됨');
    const id = page.url().split('/').pop()!;
    expect(((await (await fetch(`${env.base}/api/projects/${id}`)).json()) as any).project.scenes[0].text).toBe('가나다');
    await page.close();
  });

  it('이미지 업로드: 올리면 미리보기에 나오고, 새로고침 후에도 남고, 삭제하면 비어 있는 상태로 돌아간다', async () => {
    const page = await env.newPage();
    await newProject(page);
    await page.getByTestId('file-input').setInputFiles(tmp('ok.png', solidPng(320, 180, [10, 120, 200])));
    await eventually(visible(page, '.image-row'), '이미지 행');
    await eventually(visible(page, '.frame img.bg'), '미리보기 이미지');
    await page.reload();
    await eventually(visible(page, '.image-row'), '새로고침 후 이미지');
    await page.locator('.image-row').getByRole('button', { name: '삭제' }).click();
    await eventually(visible(page, 'text=이미지가 있어야 영상을 만들 수 있어요.'), '삭제 후 안내');
    await page.close();
  });

  it('잘못된 이미지: 가짜 확장자·GIF·해상도 초과·10MB 초과는 알리고 기존 상태를 유지한다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const input = page.getByTestId('file-input');
    const noImage = visible(page, 'text=이미지가 있어야 영상을 만들 수 있어요.');

    // 브라우저가 보내는 MIME 은 image/png 지만 실제 내용은 텍스트 → 서버가 거부
    await input.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') });
    await eventually(hasText(page, '.toast', 'JPG, PNG, WebP'), '가짜 PNG 거부 안내');
    await eventually(noImage, '이미지 없음 유지');

    // 허용하지 않는 형식(클라이언트 사전 확인)
    await input.setInputFiles({ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    await eventually(hasText(page, '.toast', 'JPG, PNG, WebP'), 'GIF 안내');

    // 해상도 초과(서버 검증)
    await input.setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: solidPng(4097, 8, [0, 0, 0]) });
    await eventually(hasText(page, '.toast', '4096px'), '해상도 초과 안내');
    await eventually(noImage, '해상도 초과 후 이미지 없음 유지');

    // 10MB 초과(클라이언트 사전 확인은 통과하지 못하고 막힌다)
    await input.setInputFiles({
      name: 'big.png',
      mimeType: 'image/png',
      buffer: Buffer.concat([solidPng(8, 8, [0, 0, 0]), Buffer.alloc(10 * 1024 * 1024 + 10)]),
    });
    await eventually(hasText(page, '.toast', '10MB'), '용량 초과 안내');
    await eventually(noImage, '용량 초과 후 이미지 없음 유지');

    // 이미지가 있는 상태에서 잘못된 파일로 바꾸려 해도 기존 이미지는 그대로
    await input.setInputFiles({ name: 'ok.png', mimeType: 'image/png', buffer: solidPng(64, 36, [200, 10, 10]) });
    await eventually(visible(page, '.image-row'), '정상 이미지');
    await input.setInputFiles({ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('nope') });
    await eventually(hasText(page, '.toast', 'JPG, PNG, WebP'), '교체 실패 안내');
    await eventually(visible(page, '.image-row'), '기존 이미지 유지');
    await page.close();
  });

  it('잘못된 길이: 범위 밖 입력은 3~30 으로 맞추고 안내하며, 경계에서 −/+ 가 멈춘다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const D = 'input[aria-label="장면 길이(초)"]';
    const dur = page.locator(D);

    await dur.fill('2');
    await dur.blur();
    await eventually(inputValue(page, D, '3'), '2 → 3');
    await eventually(hasText(page, '[data-testid=duration-note]', '3초에서 30초'), '범위 안내');
    await eventually(async () => page.getByLabel('1초 줄이기').isDisabled(), '− 비활성');

    await dur.fill('99');
    await dur.blur();
    await eventually(inputValue(page, D, '30'), '99 → 30');
    await eventually(async () => page.getByLabel('1초 늘리기').isDisabled(), '+ 비활성');

    await dur.fill('0');
    await dur.blur();
    await eventually(inputValue(page, D, '3'), '0 → 3');

    await dur.fill('');
    await dur.blur();
    await eventually(inputValue(page, D, '3'), '빈 값은 이전 값');
    await eventually(hasText(page, '[data-testid=duration-note]', '숫자'), '숫자 안내');

    await dur.fill('7.4');
    await dur.blur();
    await eventually(inputValue(page, D, '7'), '7.4 → 7');

    await eventually(hasText(page, SAVE, '저장됨'), '저장됨');
    await page.reload();
    await eventually(inputValue(page, D, '7'), '새로고침 후 7');
    await page.close();
  });

  it('저장 실패: 입력을 보존하고 [다시 저장]으로 복구한다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const id = projectIdOf(page);

    await page.route(`**/api/projects/${id}`, (route) =>
      route.request().method() === 'PUT' ? route.abort('failed') : route.continue(),
    );
    await page.getByLabel('영상 제목').fill('실패해도 남아야 해요');
    await page.locator('#scene-text').fill('저장 실패 중에 쓴 문구');
    await eventually(hasText(page, SAVE, '저장하지 못했어요'), '저장 실패 표시');
    // 화면의 입력값은 그대로
    await eventually(inputValue(page, '.title-input', '실패해도 남아야 해요'), '제목 보존');
    await eventually(inputValue(page, '#scene-text', '저장 실패 중에 쓴 문구'), '문구 보존');
    // 서버에는 아직 반영되지 않았다
    const before = (await (await fetch(`${env.base}/api/projects/${id}`)).json()) as any;
    expect(before.project.title).toBe('');

    // 실패 중에 더 고쳐도 입력은 유지된다
    await page.locator('#scene-text').fill('저장 실패 중에 쓴 문구 (수정)');
    await eventually(hasText(page, SAVE, '저장하지 못했어요'), '재실패 표시');

    await page.unroute(`**/api/projects/${id}`);
    await page.getByRole('button', { name: '다시 저장' }).click();
    await eventually(hasText(page, SAVE, '저장됨'), '복구 후 저장됨');

    await page.reload();
    await eventually(inputValue(page, '.title-input', '실패해도 남아야 해요'), '새로고침 후 제목');
    await eventually(inputValue(page, '#scene-text', '저장 실패 중에 쓴 문구 (수정)'), '새로고침 후 문구');
    await page.close();
  });

  it('서버가 400 으로 거절해도 입력을 지우지 않고 실패로 표시한다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const id = projectIdOf(page);
    await page.route(`**/api/projects/${id}`, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'INVALID_INPUT', message: '입력한 내용을 확인해 주세요.' } }),
          })
        : route.continue(),
    );
    await page.locator('#scene-text').fill('거절돼도 남는 문구');
    await eventually(hasText(page, SAVE, '저장하지 못했어요'), '거절 시 실패 표시');
    await eventually(inputValue(page, '#scene-text', '거절돼도 남는 문구'), '문구 보존');
    await page.close();
  });

  it('저장하는 동안 계속 입력해도 마지막 내용이 저장된다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const id = projectIdOf(page);
    await page.route(`**/api/projects/${id}`, async (route) => {
      if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 700)); // 느린 저장
      await route.continue();
    });
    const box = page.locator('#scene-text');
    await box.fill('첫 번째');
    await page.waitForTimeout(1200); // 첫 저장이 진행 중인 시점
    await box.fill('두 번째 최종 문구');
    await eventually(hasText(page, SAVE, '저장됨'), '저장됨', 20000);
    await eventually(inputValue(page, '#scene-text', '두 번째 최종 문구'), '입력 유지');
    await page.unroute(`**/api/projects/${id}`);
    await page.reload();
    await eventually(inputValue(page, '#scene-text', '두 번째 최종 문구'), '새로고침 후 최종 문구');
    await page.close();
  });

  it('영상 만들기 확인: 누락 7개(제목 1 + 장면별 문구·이미지 6)를 보여주고 [채우기]로 해당 장면에 이동한다', async () => {
    const page = await env.newPage();
    await newProject(page);
    await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();
    const d = '[role=dialog]';
    await eventually(hasText(page, d, '아직 채우지 않은 항목이 있어요'), '모달 제목');
    await eventually(hasText(page, d, '빠진 항목이 7개 있어요'), '누락 개수');
    await eventually(hasText(page, d, '제목이 비어 있어요'), '제목 누락');
    expect(await page.locator(`${d} .check-row`).count()).toBe(3);
    expect((await text(page, d)).match(/문구·이미지 없음/g)?.length).toBe(3);
    await eventually(hasText(page, d, 'MP4 · 1280 × 720 · 소리 없음'), '출력 형식');
    expect(await page.locator(`${d} .btn-primary`).isDisabled()).toBe(true);
    await page.locator(`${d} .check-row`).nth(1).getByRole('button', { name: '채우기' }).click();
    await eventually(count(page, d, 0), '모달 닫힘');
    await eventually(hasText(page, '.col-inspector h2', '장면 2 편집'), '장면 2 선택');
    await page.close();
  });

  it('샘플 프로젝트: 단색 플레이스홀더가 "샘플"로 구분되고 누락 없이 점검을 통과한다', async () => {
    const sample = createSampleProject(env.store);
    const page = await env.newPage();
    await page.goto(env.base + '/');
    await eventually(visible(page, '.row:has-text("매장 재고 관리 사용법") .sample-tag'), '목록 샘플 표시');
    await page.goto(`${env.base}/projects/${sample.id}`);
    await eventually(inputValue(page, '.title-input', '매장 재고 관리 사용법'), '샘플 제목');
    await eventually(visible(page, 'text=샘플 이미지 · 실제 이미지가 아니에요'), '미리보기 샘플 안내');
    await eventually(visible(page, '.image-row .sample-tag'), '이미지 행 샘플 표시');
    await eventually(inputValue(page, '#scene-text', '매장에 우유가 부족한지 확인하기 어려우셨나요?'), '샘플 문구');
    await page.locator('.topbar').getByRole('button', { name: '영상 만들기' }).click();
    await eventually(hasText(page, '[role=dialog]', '이 내용으로 영상을 만들까요?'), '점검 통과');
    expect((await text(page, '[role=dialog]')).match(/준비됐어요/g)?.length).toBe(3);
    expect(await page.locator('[role=dialog] .btn-primary').isEnabled()).toBe(true); // 누락 없으면 시작 가능
    await page.close();
  });

  it('삭제: 안내 문구를 먼저 보여주고, 취소하면 남기며, 확정하면 파일까지 지운다', async () => {
    const page = await env.newPage();
    await newProject(page);
    const id = projectIdOf(page);
    await page.getByLabel('영상 제목').fill('삭제 테스트');
    await page.getByTestId('file-input').setInputFiles(tmp('del.png', solidPng(64, 36, [1, 2, 3])));
    await eventually(visible(page, '.image-row'), '이미지 행');
    await eventually(hasText(page, SAVE, '저장됨'), '저장됨');
    const uploads = path.join(env.dataDir, 'uploads', id);
    expect(fs.readdirSync(uploads)).toHaveLength(1);

    await page.goto(env.base + '/');
    const row = page.locator('.row:has-text("삭제 테스트")');
    await row.getByRole('button', { name: /삭제/ }).click();
    await eventually(hasText(page, '[role=dialog]', '이미지와 만든 영상 파일도 함께 지워지고, 되돌릴 수 없어요'), '삭제 안내');
    await page.locator('[role=dialog]').getByRole('button', { name: '취소' }).click();
    await eventually(visible(page, '.row:has-text("삭제 테스트")'), '취소 후 유지');
    expect(fs.readdirSync(uploads)).toHaveLength(1);

    await row.getByRole('button', { name: /삭제/ }).click();
    await page.locator('[role=dialog]').getByRole('button', { name: '삭제', exact: true }).click();
    await eventually(count(page, '.row:has-text("삭제 테스트")', 0), '목록에서 사라짐');
    expect(fs.existsSync(uploads)).toBe(false);
    await page.close();
  });

  it('없는 프로젝트 주소는 안내 화면을 보여준다', async () => {
    const page = await env.newPage();
    await page.goto(`${env.base}/projects/00000000-0000-4000-8000-000000000000`);
    await eventually(visible(page, 'text=프로젝트를 찾을 수 없어요'), '404 안내');
    await page.close();
  });
});

describe('긴 한국어 문구 · 좁은 화면', () => {
  const LONG =
    '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.';

  it('긴 문구도 자막이 프레임 안(좌우 10% 여백 안쪽)에 머문다', async () => {
    const page = await env.newPage({ width: 1440, height: 900 });
    await newProject(page);
    await page.locator('#scene-text').fill(LONG);
    const frame = (await page.getByTestId('preview-frame').boundingBox())!;
    const sub = (await page.getByTestId('preview-subtitle').boundingBox())!;
    expect(sub.x).toBeGreaterThanOrEqual(frame.x + frame.width * 0.1 - 1);
    expect(sub.x + sub.width).toBeLessThanOrEqual(frame.x + frame.width * 0.9 + 1);
    expect(sub.y).toBeGreaterThanOrEqual(frame.y);
    expect(sub.y + sub.height).toBeLessThanOrEqual(frame.y + frame.height);
    await eventually(visible(page, 'text=문구가 길어서 자막이 3줄 이상이 될 수 있어요'), '긴 문구 경고');
    await page.screenshot({ path: path.join(env.dataDir, 'long-wide.png') });
    await page.close();
  });

  for (const width of [390, 320]) {
    it(`${width}px 너비에서 가로 스크롤 없이 편집·목록 화면이 쓰인다`, async () => {
      const page = await env.newPage({ width, height: 800 });
      await newProject(page);
      await page.getByLabel('영상 제목').fill('아주 긴 제목입니다 '.repeat(5));
      await page.locator('#scene-text').fill(LONG);
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      const frame = (await page.getByTestId('preview-frame').boundingBox())!;
      const sub = (await page.getByTestId('preview-subtitle').boundingBox())!;
      expect(sub.x).toBeGreaterThanOrEqual(frame.x);
      expect(sub.x + sub.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
      await eventually(hasText(page, SAVE, '저장됨'), '저장됨');
      await page.screenshot({ path: path.join(env.dataDir, `long-${width}.png`), fullPage: true });

      await page.getByRole('button', { name: '← 프로젝트' }).click();
      await eventually(visible(page, '.table'), '목록 화면');
      expect(await overflow()).toBeLessThanOrEqual(0);
      await page.close();
    });
  }
});
