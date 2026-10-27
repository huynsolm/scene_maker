import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SUBTITLE, VIDEO } from '../shared/limits';
import { loadMeasurer } from '../server/render/font';
import { layoutSubtitle } from '../server/render/layout';
import { createSampleProject, SAMPLE } from '../server/seed';
import { solidPng } from '../server/solidPng';
import { makeApp, upload, validSave, waitFor } from './helpers';

// 실제 ffmpeg/ffprobe 를 쓰는 테스트. 두 도구가 없는 환경에서는 건너뛴다.
const hasTools = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const d = hasTools ? describe : describe.skip;

const apps: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const frame = (file: string, t: number): Buffer =>
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 16 * 1024 * 1024,
  });
const px = (f: Buffer, x: number, y: number) => {
  const i = (y * VIDEO.width + x) * 3;
  return [f[i]!, f[i + 1]!, f[i + 2]!] as const;
};
const near = (a: readonly number[], b: readonly number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

/** 배경색(왼쪽 위 모서리)과 다른 픽셀의 경계 상자 = 자막 상자 */
function boxBounds(f: Buffer) {
  const bg = px(f, 4, 4);
  let x1: number = VIDEO.width, y1: number = VIDEO.height, x2 = -1, y2 = -1;
  for (let y = VIDEO.height / 2; y < VIDEO.height; y++) {
    for (let x = 0; x < VIDEO.width; x++) {
      if (!near(px(f, x, y), bg, 14)) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}
const whitePixels = (f: Buffer, b: { x: number; y: number; w: number; h: number }) => {
  let n = 0;
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (near(px(f, x, y), [255, 255, 255], 30)) n++;
  return n;
};
const probe = (file: string) =>
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,pix_fmt,width,height,r_frame_rate:format=duration', '-of', 'json', file]).toString(),
  );

d('실제 ffmpeg 렌더링', () => {
  it('샘플 프로젝트로 1280x720 · 30fps · 무음 · 30초 H.264 MP4 가 만들어지고, 한글 자막이 설계한 위치에 그려진다', async () => {
    const a = await makeApp(undefined, {});
    apps.push(a.app);
    const project = createSampleProject(a.store);
    const created = (await a.app.inject({ method: 'POST', url: `/api/projects/${project.id}/renders` })).json().job;

    const job = await waitFor(async () => {
      const j = (await a.app.inject({ url: `/api/renders/${created.id}` })).json().job;
      if (j.status === 'failed') throw new Error(`렌더 실패: ${JSON.stringify(j.error)}`);
      return j.status === 'done' ? j : null;
    }, '실제 렌더 완료', 90_000);
    expect(job.output).toEqual({ width: 1280, height: 720, fps: 30 });

    const file = a.renders.videoPathFor(project.id, created.id);
    const info = probe(file);
    const streams = info.streams as Array<{ codec_type: string; codec_name: string; pix_fmt: string; width: number; height: number; r_frame_rate: string }>;
    expect(streams).toHaveLength(1); // 소리 트랙 없음
    expect(streams[0]).toMatchObject({ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1280, height: 720, r_frame_rate: '30/1' });
    expect(Number(info.format.duration)).toBeGreaterThan(29.9);
    expect(Number(info.format.duration)).toBeLessThan(30.1);

    // HTTP 로 받은 파일도 같은 파일이다
    const http = await a.app.inject({ url: job.downloadUrl });
    expect(http.statusCode).toBe(200);
    expect(http.rawPayload.length).toBe(fs.statSync(file).size);

    const measurer = loadMeasurer(path.resolve('fonts/NotoSansKR-SemiBold.ttf'));
    for (const [i, s] of SAMPLE.scenes.entries()) {
      const f = frame(file, i * 10 + 5);
      expect(near(px(f, 4, 4), s.color, 4), `장면 ${i + 1} 배경색`).toBe(true);
      const want = layoutSubtitle(s.text, measurer).box;
      const got = boxBounds(f);
      // 설계한 상자 위치·크기와 실제 프레임의 차이(px)
      expect(Math.abs(got.x - want.x), `장면 ${i + 1} x`).toBeLessThanOrEqual(3);
      expect(Math.abs(got.y - want.y), `장면 ${i + 1} y`).toBeLessThanOrEqual(3);
      expect(Math.abs(got.w - want.w), `장면 ${i + 1} w`).toBeLessThanOrEqual(4);
      expect(Math.abs(got.h - want.h), `장면 ${i + 1} h`).toBeLessThanOrEqual(4);
      // 안전 영역 안, 글자(흰 픽셀)가 실제로 그려졌다
      expect(got.x).toBeGreaterThanOrEqual((VIDEO.width * SUBTITLE.sideMarginPct) / 100 - 2);
      expect(got.x + got.w).toBeLessThanOrEqual(VIDEO.width - (VIDEO.width * SUBTITLE.sideMarginPct) / 100 + 2);
      expect(whitePixels(f, got)).toBeGreaterThan(400);
    }

    // 장면 전환은 10초·20초(±1프레임)
    expect(near(px(frame(file, 9.9), 4, 4), SAMPLE.scenes[0]!.color, 4)).toBe(true);
    expect(near(px(frame(file, 10.1), 4, 4), SAMPLE.scenes[1]!.color, 4)).toBe(true);
    expect(near(px(frame(file, 19.9), 4, 4), SAMPLE.scenes[1]!.color, 4)).toBe(true);
    expect(near(px(frame(file, 20.1), 4, 4), SAMPLE.scenes[2]!.color, 4)).toBe(true);
    // 작업 폴더는 정리됐다
    expect(fs.existsSync(path.join(a.dataDir, 'tmp', created.id))).toBe(false);
  }, 120_000);

  it('실제 JPEG·WebP·PNG 파일(ffmpeg 로 만든 진짜 이미지, 가로형·세로형·작은 크기 포함)도 업로드부터 영상까지 이어진다', async () => {
    const a = await makeApp(undefined, {});
    apps.push(a.app);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-realimg-'));
    // 색 막대 테스트 화면을 서로 다른 크기·형식으로 만든다
    const make = (name: string, size: string, args: string[] = []) => {
      const out = path.join(dir, name);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=1`, '-frames:v', '1', ...args, out]);
      return fs.readFileSync(out);
    };
    const jpg = make('wide.jpg', '1600x900');
    const webp = make('portrait.webp', '540x960');
    const png = make('small.png', '320x180');
    const p = a.store.createProject({ title: '실제 이미지 형식' });
    a.store.saveProject(p.id, { title: '실제 이미지 형식', scenes: ['가로 JPEG', '세로 WebP', '작은 PNG'].map((text) => ({ text, durationSec: 3 })) });
    expect((await upload(a.app, p.id, 0, jpg, 'wide.jpg', 'image/jpeg')).statusCode).toBe(200);
    expect((await upload(a.app, p.id, 1, webp, 'portrait.webp', 'image/webp')).statusCode).toBe(200);
    expect((await upload(a.app, p.id, 2, png, 'small.png', 'image/png')).statusCode).toBe(200);

    const j = (await a.app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` })).json().job;
    const done = await waitFor(async () => {
      const v = (await a.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      if (v.status === 'failed') throw new Error(JSON.stringify(v.error));
      return v.status === 'done' ? v : null;
    }, '렌더 완료', 90_000);
    expect(done.output).toEqual({ width: 1280, height: 720, fps: 30 });
    const file = a.renders.videoPathFor(p.id, j.id);
    expect(Number(probe(file).format.duration)).toBeGreaterThan(8.9);
    // 세로 이미지는 cover 로 가득 채워지고(검은 여백 없음) 자막이 있다
    for (const t of [1.5, 4.5, 7.5]) {
      const f = frame(file, t);
      expect(whitePixels(f, boxBounds(f))).toBeGreaterThan(300);
      const corner = px(f, 2, 2);
      expect(corner.some((v) => v > 20)).toBe(true); // 모서리가 검은색 여백이 아니다
    }
  }, 120_000);

  it('EXIF 회전 JPEG 는 사진 앱에서 보이는 방향으로, 투명 PNG 는 프레임 배경색 위에 합성되어 나온다(미리보기와 같은 모양)', async () => {
    const a = await makeApp(undefined, {});
    apps.push(a.app);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-orient-'));
    // 반투명 흰색(알파 50%) PNG: 알파를 무시하면 순백, 배경 위에 합성하면 회색
    const half = path.join(dir, 'half.png');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white@0.5:s=640x360,format=rgba', '-frames:v', '1', half]);
    // 600x300 픽셀(왼쪽 빨강·오른쪽 파랑)에 EXIF orientation=6(시계 방향 90°)이 들어 있다 → 화면에는 세로(위 빨강·아래 파랑)
    const rot = fs.readFileSync(path.resolve('tests/fixtures/exif-rotate6.jpg'));

    const p = a.store.createProject({ title: '방향과 투명도' });
    a.store.saveProject(p.id, { title: '방향과 투명도', scenes: [{ text: '회전', durationSec: 3 }, { text: '투명', durationSec: 3 }, { text: '회전2', durationSec: 3 }] });
    expect((await upload(a.app, p.id, 0, rot, 'rot.jpg', 'image/jpeg')).statusCode).toBe(200);
    expect((await upload(a.app, p.id, 1, fs.readFileSync(half), 'half.png', 'image/png')).statusCode).toBe(200);
    expect((await upload(a.app, p.id, 2, rot, 'rot2.jpg', 'image/jpeg')).statusCode).toBe(200);
    const j = (await a.app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` })).json().job;
    await waitFor(async () => {
      const v = (await a.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      if (v.status === 'failed') throw new Error(JSON.stringify(v.error));
      return v.status === 'done';
    }, '렌더 완료', 90_000);
    const file = a.renders.videoPathFor(p.id, j.id);

    const f1 = frame(file, 1.5);
    expect(near(px(f1, 100, 100), [220, 30, 30], 12), '회전 JPEG 위쪽은 빨강').toBe(true);
    expect(near(px(f1, 100, 620), [30, 30, 220], 12), '회전 JPEG 아래쪽은 파랑(자막 상자 밖 지점)').toBe(true);

    const f2 = frame(file, 4.5);
    const bg = [27, 28, 32];
    const expectGray = bg.map((c) => (255 + c) / 2); // 흰색 50% + 배경 50%
    expect(near(px(f2, 4, 4), expectGray, 8), '반투명 흰색은 배경과 섞인 회색').toBe(true);
    expect(near(px(f2, 4, 4), [255, 255, 255], 20), '알파를 무시한 순백이면 안 된다').toBe(false);
  }, 120_000);

  it('긴 한국어 3줄 문구도 상자가 안전 영역 안에 있고 글자가 잘리지 않는다', async () => {
    const a = await makeApp(undefined, {});
    apps.push(a.app);
    const p = createSampleProject(a.store);
    const long = '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.';
    await a.app.inject({
      method: 'PUT',
      url: `/api/projects/${p.id}`,
      payload: validSave({ title: '긴 문구', scenes: [{ text: long, durationSec: 3 }, { text: '둘', durationSec: 3 }, { text: '셋', durationSec: 3 }] }),
    });
    const j = (await a.app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` })).json().job;
    await waitFor(async () => {
      const v = (await a.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      if (v.status === 'failed') throw new Error(JSON.stringify(v.error));
      return v.status === 'done';
    }, '렌더 완료', 90_000);
    const f = frame(a.renders.videoPathFor(p.id, j.id), 1.5);
    const b = boxBounds(f);
    const want = layoutSubtitle(long, loadMeasurer(path.resolve('fonts/NotoSansKR-SemiBold.ttf')));
    expect(want.lines.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(b.h - want.box.h)).toBeLessThanOrEqual(4);
    expect(b.x).toBeGreaterThanOrEqual(126);
    expect(b.x + b.w).toBeLessThanOrEqual(1154);
    expect(b.y + b.h).toBeLessThanOrEqual(VIDEO.height - 70); // 아래 11% 여백 확보
  }, 120_000);
});

d('렌더 실패 처리(실제 ffmpeg)', () => {
  async function failingProject(a: Awaited<ReturnType<typeof makeApp>>) {
    const p = createSampleProject(a.store);
    return p;
  }
  const run = async (a: Awaited<ReturnType<typeof makeApp>>, id: string) => {
    const j = (await a.app.inject({ method: 'POST', url: `/api/projects/${id}/renders` })).json().job;
    return waitFor(async () => {
      const v = (await a.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      return v.status === 'done' || v.status === 'failed' ? v : null;
    }, '종료', 60_000);
  };

  it('머리만 정상이고 본문이 잘린 이미지는 업로드는 통과해도 렌더에서 몇 번째 장면인지 알려주며 실패한다', async () => {
    const a = await makeApp(undefined, {});
    apps.push(a.app);
    const p = await failingProject(a);
    const truncated = solidPng(1280, 720, [9, 9, 9]).subarray(0, 120);
    const up = await upload(a.app, p.id, 1, truncated, 'broken.png');
    expect(up.statusCode).toBe(200); // 업로드 검증은 머리(시그니처·크기)만 본다
    const v = await run(a, p.id);
    expect(v.status).toBe('failed');
    expect(v.error).toMatchObject({ code: 'IMAGE_DECODE_FAILED', title: '장면 2 이미지를 읽을 수 없어요' });
    // 입력과 이미지는 그대로
    const after = (await a.app.inject({ url: `/api/projects/${p.id}` })).json().project;
    expect(after.status).toBe('failed');
    expect(after.scenes[1].image.fileName).toBe('broken.png');
    expect(after.scenes[0].text).toContain('우유');
  }, 90_000);

  it('ffmpeg 가 없으면 FFMPEG_NOT_FOUND 로 실패한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-noffmpeg-'));
    const { buildApp } = await import('../server/app');
    const built = await buildApp({ dataDir: dir, webDist: null, ffmpegPath: '/nonexistent/ffmpeg' });
    apps.push(built.app);
    const p = createSampleProject(built.store);
    const j = (await built.app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` })).json().job;
    const v = await waitFor(async () => {
      const x = (await built.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      return x.status === 'failed' ? x : null;
    }, '실패');
    expect(v.error.code).toBe('FFMPEG_NOT_FOUND');
  });

  it('글꼴이 없으면 FONT_MISSING 으로 실패한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-nofont-'));
    const { buildApp } = await import('../server/app');
    const built = await buildApp({ dataDir: dir, webDist: null, fontsDir: path.join(dir, 'empty') });
    apps.push(built.app);
    const p = createSampleProject(built.store);
    const j = (await built.app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` })).json().job;
    const v = await waitFor(async () => {
      const x = (await built.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      return x.status === 'failed' ? x : null;
    }, '실패');
    expect(v.error.code).toBe('FONT_MISSING');
  });

  it('제한 시간을 넘으면 RENDER_TIMEOUT 으로 실패하고 작업 폴더를 정리한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-timeout-'));
    const { buildApp } = await import('../server/app');
    const built = await buildApp({ dataDir: dir, webDist: null, renderTimeoutMs: 1 });
    apps.push(built.app);
    const p = createSampleProject(built.store);
    const j = (await built.app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` })).json().job;
    const v = await waitFor(async () => {
      const x = (await built.app.inject({ url: `/api/renders/${j.id}` })).json().job;
      return x.status === 'failed' ? x : null;
    }, '실패');
    expect(v.error.code).toBe('RENDER_TIMEOUT');
    expect(fs.existsSync(path.join(dir, 'tmp', j.id))).toBe(false);
  });
});
