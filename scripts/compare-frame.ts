/**
 * 화면 미리보기와 실제 렌더 영상의 자막 차이를 재는 스크립트.
 *
 *   npm run build && npm run compare:frame -- [--pretendard <PretendardVariable.ttf>] [--out report.md]
 *
 * 같은 샘플로 (1) ffmpeg 로 영상을 만들어 프레임을 뽑고, (2) 편집 화면 미리보기를 1280x720 크기로 캡처해
 * 두 이미지에 같은 픽셀 분석(자막 상자·글자 경계·줄 수)을 돌려 차이를 표로 낸다.
 * 미리보기 글꼴을 바꿔 가며 재서 차이의 원인(글꼴 vs 배치 엔진)을 나눈다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { VIDEO } from '../shared/limits';
import { buildApp } from '../server/app';
import { loadMeasurer } from '../server/render/font';
import { layoutSubtitle } from '../server/render/layout';
import { solidPng } from '../server/solidPng';
import { boxBounds, frameFromImage, frameFromVideo, inkAnalysis, type Box } from './frames';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const CASES: Array<{ label: string; text: string; color: [number, number, number] }> = [
  { label: '짧은 1줄', text: '매장에 우유가 부족한지 확인하기 어려우셨나요?', color: [74, 93, 140] },
  { label: '중간 1줄', text: '재고 화면에서 현재 수량과 부족한 품목을 확인하세요.', color: [64, 120, 104] },
  { label: '긴 3줄(76자)', text: '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 한눈에 확인하고 발주 목록에 바로 추가해 보세요.', color: [140, 98, 64] },
  { label: '사용자 줄바꿈', text: '첫째 줄입니다\n둘째 줄은 조금 더 길게 써 봅니다', color: [90, 70, 130] },
  { label: '2줄', text: '발주 목록에 추가하고 입고 수량을 기록해 보세요. 부족한 품목은 먼저 확인하세요.', color: [60, 110, 140] },
  { label: '영문·숫자 혼합', text: 'Stock 12개 남음 — order now: 3 boxes of milk (2%) 확인', color: [120, 90, 70] },
];

interface Variant {
  id: string;
  title: string;
  /** 미리보기에 주입할 글꼴 파일. 없으면 배포 CSS 그대로 */
  font?: { file: string; weight: string };
}

async function main() {
  const fontsDir = path.resolve('fonts');
  const noto = path.join(fontsDir, 'NotoSansKR-SemiBold.ttf');
  const pretendard = arg('pretendard');
  const variants: Variant[] = [
    { id: 'served', title: '배포 CSS 그대로 (CDN 글꼴을 못 받는 환경에서는 시스템 대체 글꼴)' },
    { id: 'noto', title: '미리보기 글꼴을 영상과 같은 Noto Sans KR 로 강제 (배치·렌더링 차이만 분리)', font: { file: noto, weight: '100 900' } },
    ...(pretendard ? [{ id: 'pretendard', title: '미리보기에 Pretendard 주입 (CDN 이 열릴 때 사용자가 실제로 보는 모습)', font: { file: path.resolve(pretendard), weight: '45 920' } }] : []),
  ];

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-maker-compare-'));
  const { app, store, renders } = await buildApp({ dataDir, webDist: path.resolve('dist/web') });
  if (!fs.existsSync(path.resolve('dist/web/index.html'))) throw new Error('먼저 `npm run build` 를 실행해 주세요.');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  // 1) 영상 만들기: 장면 3개씩 프로젝트 2개
  const measurer = loadMeasurer(noto);
  const projects: Array<{ id: string; cases: typeof CASES }> = [];
  for (let k = 0; k < CASES.length; k += 3) {
    const cases = CASES.slice(k, k + 3);
    const p = store.createProject({ title: `비교 ${k / 3 + 1}` });
    store.saveProject(p.id, { title: `비교 ${k / 3 + 1}`, scenes: cases.map((c) => ({ text: c.text, durationSec: 3 })) });
    cases.forEach((c, i) => store.attachImage(p.id, i, solidPng(VIDEO.width, VIDEO.height, c.color), `c${k + i}.png`));
    projects.push({ id: p.id, cases });
  }
  const videos: string[] = [];
  for (const p of projects) {
    const job = await (await fetch(`${base}/api/projects/${p.id}/renders`, { method: 'POST' })).json() as { job: { id: string } };
    for (;;) {
      const j = ((await (await fetch(`${base}/api/renders/${job.job.id}`)).json()) as { job: { status: string; error?: unknown } }).job;
      if (j.status === 'done') break;
      if (j.status === 'failed') throw new Error(`렌더 실패: ${JSON.stringify(j.error)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    videos.push(renders.videoPathFor(p.id, job.job.id));
  }

  // 2) 영상 프레임 분석
  const rows: Array<{ label: string; video: ReturnType<typeof analyze>; layoutLines: string[] }> = [];
  const analyze = (f: Buffer) => {
    const box = boxBounds(f);
    return { box, ...inkAnalysis(f, box) };
  };
  projects.forEach((p, pi) =>
    p.cases.forEach((c, i) => {
      const f = frameFromVideo(videos[pi]!, i * 3 + 1.5);
      rows.push({ label: c.label, video: analyze(f), layoutLines: layoutSubtitle(c.text, measurer).lines });
    }),
  );

  // 3) 미리보기 캡처·분석(글꼴 조건별)
  const browser = await chromium.launch();
  const report: string[] = [];
  const summary: string[] = [];
  const shotDir = path.join(dataDir, 'shots');
  fs.mkdirSync(shotDir);
  const flat = projects.flatMap((p) => p.cases.map((c, i) => ({ pid: p.id, i, c })));

  for (const v of variants) {
    const page = await browser.newPage({ viewport: { width: 2000, height: 1100 } });
    if (v.font) {
      await page.route('**/__font/subtitle.ttf', (r) => r.fulfill({ path: v.font!.file, contentType: 'font/ttf' }));
    }
    const deltas: Array<Record<string, number>> = [];
    report.push(`\n### 미리보기 조건: ${v.title}\n`);
    report.push('| 사례 | 상자 Δx | Δy | Δw | Δh | 글자 Δx | Δy | Δw | Δh | 줄 수 (영상/미리보기) | 줄바꿈 위치 |');
    report.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|');
    let loaded = '';
    for (const [n, { pid, i, c }] of flat.entries()) {
      await page.goto(`${base}/projects/${pid}`);
      await page.getByLabel('영상 제목').waitFor();
      await page.addStyleTag({
        content:
          `.preview-wrap{max-width:${VIDEO.width}px!important}` +
          (v.font ? `@font-face{font-family:'Pretendard Variable';src:url('/__font/subtitle.ttf');font-weight:${v.font.weight}}` : ''),
      });
      await page.locator(`[data-testid=scene-card-${i}]`).click();
      await page.getByRole('button', { name: /안내선 숨기기/ }).click(); // 편집용 안내선은 영상에 없으므로 끈다
      await page.evaluate(() => document.fonts.ready);
      if (v.font && !loaded) loaded = String(await page.evaluate(() => document.fonts.check("600 40px 'Pretendard Variable'")));
      await page.getByTestId('preview-subtitle').waitFor();
      const frame = page.getByTestId('preview-frame');
      const bb = (await frame.boundingBox())!;
      if (Math.abs(bb.width - VIDEO.width) > 0.5) throw new Error(`미리보기 프레임 너비가 ${bb.width}px 입니다(1280 기대)`);
      const shot = path.join(shotDir, `${v.id}-${n}.png`);
      // 요소 캡처는 소수점 위치 때문에 1픽셀 크게 잡히므로, 정확히 1280x720 영역을 반올림한 좌표로 캡처한다(측정 오차 약 ±1px)
      await page.screenshot({ path: shot, clip: { x: Math.round(bb.x), y: Math.round(bb.y), width: VIDEO.width, height: VIDEO.height } });
      const pv = analyze(frameFromImage(shot));
      const previewLines = await lineTexts(page);
      const vd = rows[n]!.video;
      const d = (a: number, b: number) => b - a; // 미리보기 - 영상
      const row = {
        bx: d(vd.box.x, pv.box.x), by: d(vd.box.y, pv.box.y), bw: d(vd.box.w, pv.box.w), bh: d(vd.box.h, pv.box.h),
        ix: d(vd.ink.x, pv.ink.x), iy: d(vd.ink.y, pv.ink.y), iw: d(vd.ink.w, pv.ink.w), ih: d(vd.ink.h, pv.ink.h),
      };
      deltas.push(row);
      const sameBreaks = JSON.stringify(previewLines) === JSON.stringify(rows[n]!.layoutLines);
      report.push(
        `| ${c.label} | ${row.bx} | ${row.by} | ${row.bw} | ${row.bh} | ${row.ix} | ${row.iy} | ${row.iw} | ${row.ih} | ${vd.lines}/${pv.lines} | ${sameBreaks ? '같음' : '**다름**'} |`,
      );
      if (!sameBreaks) report.push(`|  | 영상: ${rows[n]!.layoutLines.map((l) => `「${l.replace(/\n/g, '⏎')}」`).join(' ')}<br>미리보기: ${previewLines.map((l) => `「${l}」`).join(' ')} |||||||||| |`);
    }
    const max = (k: string) => Math.max(...deltas.map((r) => Math.abs(r[k]!)));
    summary.push(`- **${v.id}** — 상자 위치 최대 ${max('bx')}/${max('by')}px(x/y), 크기 최대 ${max('bw')}/${max('bh')}px(w/h) · 글자 경계 위치 최대 ${max('ix')}/${max('iy')}px, 크기 최대 ${max('iw')}/${max('ih')}px${v.font ? ` · 글꼴 로드 확인: ${loaded}` : ''}`);
    await page.close();
  }
  await browser.close();
  await app.close();

  const out = [
    '# 미리보기 ↔ 실제 영상 자막 비교',
    '',
    `측정일: ${new Date().toISOString().slice(0, 10)} · 기준: 1280×720 프레임에서 **미리보기 − 영상** (px, 양수 = 미리보기가 더 오른쪽/아래/큼)`,
    '',
    '## 요약',
    ...summary,
    '',
    '- 상자 = 배경과 달라진 픽셀의 경계(반투명 어두운 박스). 글자 = 상자 안의 흰 글자 픽셀 경계.',
    '- 미리보기 캡처는 화면상 위치를 반올림해 자르므로 **측정 오차가 약 ±1px** 있다. 1~2px 이하의 차이는 의미 있는 차이로 보지 않는다.',
    '- 영상은 영상 파일의 중간 프레임(libx264 압축 후)을, 미리보기는 같은 크기로 키운 화면을 캡처해 같은 함수로 분석했다.',
    ...report,
  ].join('\n');
  const outFile = arg('out');
  if (outFile) fs.writeFileSync(outFile, out + '\n');
  console.log(out);
  console.log(`\n(캡처 파일: ${shotDir})`);
}

/** 미리보기 자막을 글자 단위 Range 로 훑어 줄별 문자열로 만든다(브라우저가 실제로 나눈 줄) */
async function lineTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid=preview-subtitle]')!;
    const lines: Array<{ top: number; text: string }> = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? '';
      for (let k = 0; k < t.length; k++) {
        const r = document.createRange();
        r.setStart(n, k);
        r.setEnd(n, k + 1);
        const rects = r.getClientRects();
        if (!rects.length) continue; // 줄 끝에서 접힌 공백 등
        const top = Math.round(rects[0]!.top);
        const last = lines[lines.length - 1];
        if (last && Math.abs(last.top - top) < 6) last.text += t[k];
        else lines.push({ top, text: t[k]! });
      }
    }
    return lines.map((l) => l.text.trim()).filter((l) => l.length > 0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
