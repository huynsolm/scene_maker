/**
 * 디스크 사용량을 재는 스크립트. 실제 앱의 저장·렌더·정리 경로를 그대로 쓴다.
 *
 *   npm run measure:disk -- [--out report.md] [--only P1,P2]
 *
 * 프로젝트 한 개의 생애를 단계별로 따라가며 데이터 폴더의 각 부분(업로드한 원본 이미지, 완성 영상, 임시 작업 폴더, DB)의 크기를 잰다.
 *  - 업로드 직후: 원본 이미지가 얼마나 차지하는가
 *  - 영상 한 편을 만드는 동안: 임시 작업 폴더의 최대 크기(샘플링)와 끝난 뒤 남는 것
 *  - 이미지 몇 장을 바꿔 다시 만들기를 반복할 때: 한 번마다 얼마씩 늘어나는가(이전 영상과, 이전 작업이 참조하는 이전 이미지는 남는다)
 *  - 지난 영상을 삭제한 뒤: 최신 영상만 남기고 모두 지우고, 마지막 영상까지 지웠을 때 디스크에 남은 파일이 "필요한 파일"과 정확히 같은지 검증한다
 *    (필요한 이미지 = 현재 장면이 쓰는 이미지 ∪ 남은 작업이 참조하는 이미지, 필요한 영상 = 남은 작업의 영상). 다르면 스크립트가 실패한다.
 *  - 프로젝트를 지운 뒤: 전부 회수되는가
 * 숫자는 이 컴퓨터의 파일 시스템 기준(`du`, 블록 단위)이다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type Kind = 'phone12mp' | 'jpeg4096';
interface Plan {
  id: string;
  label: string;
  kind: Kind;
  scenes: number;
  seconds: number;
  /** 이미지를 바꿔 다시 만드는 횟수(0 이면 한 번만 만든다) */
  cycles: number;
  /** 한 번에 바꾸는 이미지 수 */
  replaced: number;
}

const PLANS: Plan[] = [
  { id: 'P1', label: '휴대폰 사진(4032x3024) 10장면 x 10초, 이미지 3장씩 바꿔 3번 더 만들기', kind: 'phone12mp', scenes: 10, seconds: 10, cycles: 3, replaced: 3 },
  { id: 'P2', label: '최대 조건: 4096x4096 사진 10장면 x 30초(300초), 한 번만 만들기', kind: 'jpeg4096', scenes: 10, seconds: 30, cycles: 0, replaced: 0 },
];

const TEXT = '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 확인하세요.';

function makeImage(dir: string, kind: Kind): Buffer {
  const out = path.join(dir, `img-${kind}.jpg`);
  const size = kind === 'phone12mp' ? '4032x3024' : '4096x4096';
  for (const q of [3, 4, 6, 8]) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:d=1`, '-vf', 'noise=alls=18:allf=t', '-frames:v', '1', '-q:v', String(q), out]);
    if (fs.statSync(out).size <= 9.5 * 1024 * 1024) break; // 업로드 한도(10MB) 안
  }
  return fs.readFileSync(out);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  return (Number(r.stdout.split('\t')[0]) || 0) * 1024;
}
function dbBytes(dataDir: string): number {
  let n = 0;
  for (const f of fs.readdirSync(dataDir)) if (f.startsWith('scene_maker.db')) n += fs.statSync(path.join(dataDir, f)).size;
  return n;
}
function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}
const mb = (b: number) => (b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0);

interface Snap {
  step: string;
  uploads: number;
  videos: number;
  tmp: number;
  db: number;
  uploadFiles: number;
  videoFiles: number;
  tmpFiles: number;
  note?: string;
}

async function runPlan(p: Plan, imageDir: string): Promise<Snap[]> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `sm-disk-${p.id}-`));
  const { app, store } = await buildApp({ dataDir, webDist: null }, {});
  const snaps: Snap[] = [];
  const snap = (step: string, note?: string) =>
    snaps.push({
      step,
      uploads: dirBytes(store.uploadsDir),
      videos: dirBytes(store.videosDir),
      tmp: dirBytes(path.join(dataDir, 'tmp')),
      db: dbBytes(dataDir),
      uploadFiles: countFiles(store.uploadsDir),
      videoFiles: countFiles(store.videosDir),
      tmpFiles: countFiles(path.join(dataDir, 'tmp')),
      note,
    });
  try {
    const image = makeImage(imageDir, p.kind);
    snap('시작(빈 데이터 폴더)');
    const proj = store.createProject({ title: `디스크 ${p.id}` });
    for (let i = 3; i < p.scenes; i++) store.addScene(proj.id);
    const cur = store.getProject(proj.id);
    store.saveProject(proj.id, { title: `디스크 ${p.id}`, scenes: cur.scenes.map((s) => ({ id: s.id, text: TEXT, durationSec: p.seconds })) });
    cur.scenes.forEach((_, i) => store.attachImage(proj.id, i, image, `p${i}.jpg`));
    snap(`이미지 ${p.scenes}장 업로드`, `이미지 1장 ${mb(image.length)}MB`);

    const render = async (label: string) => {
      const res = await app.inject({ method: 'POST', url: `/api/projects/${proj.id}/renders` });
      if (res.statusCode !== 202) throw new Error(`요청 실패 ${res.statusCode} ${res.body}`);
      const jobId = res.json().job.id as string;
      let peakTmp = 0;
      let job: any;
      for (;;) {
        job = (await app.inject({ url: `/api/renders/${jobId}` })).json().job;
        peakTmp = Math.max(peakTmp, dirBytes(path.join(dataDir, 'tmp')));
        if (job.status === 'done' || job.status === 'failed') break;
        await sleep(250);
      }
      if (job.status !== 'done') throw new Error(`렌더 실패: ${job.error?.title}`);
      snap(label, `렌더 중 임시 폴더 최대 ${mb(peakTmp)}MB`);
    };
    await render('영상 1편 만든 뒤');

    for (let c = 1; c <= p.cycles; c++) {
      for (let k = 0; k < p.replaced; k++) store.attachImage(proj.id, (c * p.replaced + k) % p.scenes, image, `r${c}-${k}.jpg`);
      snap(`(${c}회차) 이미지 ${p.replaced}장 바꾼 직후`, '이전 이미지는 이전 영상 작업이 참조하므로 남는다');
      await render(`(${c}회차) 영상 한 편 더 만든 뒤`);
    }

    // 필요한 파일 = 현재 장면이 쓰는 이미지 ∪ 남은 작업이 참조하는 이미지 / 남은 작업의 영상. 디스크의 실제 파일과 정확히 같아야 한다.
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const verify = () => {
      const imgRows = db
        .prepare(
          `SELECT DISTINCT i.project_id, i.stored_name FROM images i
           WHERE i.id IN (SELECT image_id FROM scenes WHERE project_id = ? AND image_id IS NOT NULL)
              OR i.id IN (SELECT image_id FROM render_job_images WHERE job_id IN (SELECT id FROM render_jobs WHERE project_id = ?))`,
        )
        .all(proj.id, proj.id) as Array<{ project_id: string; stored_name: string }>;
      const wantImages = imgRows.map((r) => store.imagePath(r.project_id, r.stored_name)).sort();
      const wantVideos = (db.prepare(`SELECT id FROM render_jobs WHERE project_id = ? AND status = 'done'`).all(proj.id) as Array<{ id: string }>)
        .map((r) => path.join(store.videosDir, proj.id, `${r.id}.mp4`))
        .sort();
      const haveImages = listFiles(store.uploadsDir);
      const haveVideos = listFiles(store.videosDir);
      const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (!same(wantImages, haveImages) || !same(wantVideos, haveVideos)) {
        throw new Error(
          `디스크의 파일이 필요한 파일과 다르다 — 이미지 필요 ${wantImages.length}/실제 ${haveImages.length}, 영상 필요 ${wantVideos.length}/실제 ${haveVideos.length}`,
        );
      }
      return `필요한 파일과 일치(이미지 ${haveImages.length}장, 영상 ${haveVideos.length}편)`;
    };
    const doneIds = async () =>
      ((await app.inject({ url: `/api/projects/${proj.id}/renders?limit=50` })).json().list.items as Array<{ id: string }>).map((i) => i.id);
    const remove = async (id: string) => {
      const res = await app.inject({ method: 'DELETE', url: `/api/projects/${proj.id}/renders/${id}` });
      if (res.statusCode !== 200) throw new Error(`삭제 실패 ${res.statusCode} ${res.body}`);
    };
    snap('(삭제 전) 위 단계 그대로', verify());
    const ids = await doneIds(); // 최신순
    for (const id of ids.slice(1)) await remove(id);
    snap(`오래된 완료 영상 ${ids.length - 1}편을 모두 삭제한 뒤(최신 1편만 남김)`, verify());
    await remove(ids[0]!);
    snap('마지막 영상까지 삭제한 뒤(장면이 쓰는 이미지만 남음)', verify());

    store.deleteProject(proj.id);
    snap('프로젝트 삭제 뒤');
    return snaps;
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const only = arg('only')?.split(',');
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-disk-img-'));
  const parts: string[] = ['## 디스크 사용량 측정', '', `환경: ${os.cpus().length} 코어, ${(os.totalmem() / 1024 ** 3).toFixed(0)}GB, 파일 시스템 \`du\`(블록 단위)`, ''];
  for (const p of PLANS.filter((x) => !only || only.includes(x.id))) {
    process.stderr.write(`[${p.id}] ${p.label} …\n`);
    const snaps = await runPlan(p, imageDir);
    parts.push(`### ${p.id}. ${p.label}`, '', '| 단계 | 업로드한 이미지 | 완성 영상 | 임시 폴더 | DB | 파일 수(이미지/영상/임시) | 비고 |', '|---|---|---|---|---|---|---|');
    for (const s of snaps) {
      parts.push(`| ${s.step} | ${mb(s.uploads)}MB | ${mb(s.videos)}MB | ${mb(s.tmp)}MB | ${(s.db / 1024).toFixed(0)}KB | ${s.uploadFiles}/${s.videoFiles}/${s.tmpFiles} | ${s.note ?? ''} |`);
    }
    parts.push('');
    process.stderr.write(`[${p.id}] 완료\n`);
  }
  const md = parts.join('\n');
  console.log(md);
  const out = arg('out');
  if (out) fs.writeFileSync(out, md);
  fs.rmSync(imageDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
