/**
 * 영상 생성의 시간·메모리·디스크 사용량을 재는 스크립트. 실제 앱의 렌더 경로(작업 큐 → ffmpeg)를 그대로 쓴다.
 *
 *   npm run measure:render -- [--out report.md] [--only A,B]
 *
 * 케이스마다 새 프로젝트를 만들어 영상을 한 번 만들고, 작업이 끝날 때까지 주기적으로 다음을 잰다.
 *  - 걸린 시간: 작업의 started_at → finished_at, 단계별(장면 화면 만들기 / MP4 저장) 소요
 *  - ffmpeg 프로세스의 최대 상주 메모리(RSS), 서버 프로세스의 최대 RSS
 *  - 임시 작업 폴더(data/tmp/<작업>)의 최대 크기
 *  - 완성 파일 크기와 ffprobe 로 본 길이·규격
 * 결과는 이 컴퓨터의 CPU·디스크에 따라 달라진다. 숫자는 환경과 함께 읽어야 한다.
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

interface Case {
  id: string;
  label: string;
  scenes: number;
  seconds: number;
  image: 'png720' | 'jpeg4096';
}

const CASES: Case[] = [
  { id: 'A', label: '기준: 3장면 x 10초', scenes: 3, seconds: 10, image: 'png720' },
  { id: 'B', label: '장면 10개 x 3초(짧은 장면 많음)', scenes: 10, seconds: 3, image: 'png720' },
  { id: 'C', label: '최대 길이: 10장면 x 30초 = 300초', scenes: 10, seconds: 30, image: 'png720' },
  { id: 'D', label: '최대 길이 + 큰 사진(4096x4096 JPEG)', scenes: 10, seconds: 30, image: 'jpeg4096' },
];

const TEXT = '매장에 우유가 부족한지 확인하기 어려우셨나요? 재고 화면에서 현재 수량과 부족한 품목을 확인하세요.';

function makeImage(dir: string, kind: Case['image']): Buffer {
  const out = path.join(dir, kind === 'png720' ? 'img.png' : 'img.jpg');
  if (kind === 'png720') {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:d=1', '-frames:v', '1', out]);
  } else {
    // 사진처럼 잡음이 있는 4096x4096 JPEG. 10MB 한도 안에서 가장 큰 쪽으로 맞춘다.
    for (const q of [2, 3, 4, 6, 8]) {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=4096x4096:d=1', '-vf', 'noise=alls=18:allf=t', '-frames:v', '1', '-q:v', String(q), out]);
      if (fs.statSync(out).size <= 9.5 * 1024 * 1024) break;
    }
  }
  return fs.readFileSync(out);
}

/** 실행 중인 ffmpeg 프로세스들의 상주 메모리 합(KB). */
function ffmpegRssKb(): number {
  let total = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() !== 'ffmpeg') continue;
      const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) total += Number(m[1]);
    } catch {
      /* 그 사이 끝난 프로세스 */
    }
  }
  return total;
}

function dirKb(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8' });
  return Number(r.stdout.split('\t')[0]) || 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtS = (ms: number) => `${(ms / 1000).toFixed(1)}초`;
const fmtMb = (kb: number) => `${(kb / 1024).toFixed(kb < 10 * 1024 ? 1 : 0)}MB`;

interface Result {
  c: Case;
  total: number;
  step2: number;
  step3: number;
  ffmpegRssKb: number;
  serverRssKb: number;
  tmpKb: number;
  outBytes: number;
  outSec: number;
  inputKb: number;
  status: string;
}

async function runCase(c: Case, dataDir: string, imageDir: string): Promise<Result> {
  const { app, store } = await buildApp({ dataDir: path.join(dataDir, c.id), webDist: null }, {});
  try {
    const image = makeImage(imageDir, c.image);
    const p = store.createProject({ title: `측정 ${c.id}` });
    for (let i = 3; i < c.scenes; i++) store.addScene(p.id);
    for (let i = 3; i > c.scenes; i--) store.deleteScene(p.id, store.getProject(p.id).scenes.at(-1)!.id);
    const cur = store.getProject(p.id);
    store.saveProject(p.id, {
      title: `측정 ${c.id}`,
      scenes: cur.scenes.map((s) => ({ id: s.id, text: TEXT, durationSec: c.seconds })),
    });
    cur.scenes.forEach((_, i) => store.attachImage(p.id, i, image, `c${i}.${c.image === 'png720' ? 'png' : 'jpg'}`));

    const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` });
    if (res.statusCode !== 202) throw new Error(`요청 실패: ${res.statusCode} ${res.body}`);
    const jobId = res.json().job.id as string;
    const tmpDir = path.join(dataDir, c.id, 'tmp');

    let maxFfmpeg = 0;
    let maxServer = 0;
    let maxTmp = 0;
    const stepAt: Record<number, number> = {};
    const t0 = Date.now();
    let job: any;
    for (;;) {
      job = (await app.inject({ url: `/api/renders/${jobId}` })).json().job;
      const now = Date.now() - t0;
      if (stepAt[job.step] === undefined) stepAt[job.step] = now;
      maxFfmpeg = Math.max(maxFfmpeg, ffmpegRssKb());
      maxServer = Math.max(maxServer, Math.round(process.memoryUsage().rss / 1024));
      maxTmp = Math.max(maxTmp, dirKb(tmpDir));
      if (job.status === 'done' || job.status === 'failed') break;
      await sleep(200);
    }
    const tEnd = Date.now() - t0;
    const wall = job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : Date.now() - t0;
    let outBytes = 0;
    let outSec = 0;
    if (job.status === 'done') {
      const file = (await app.inject({ url: `/api/renders/${jobId}/video` })).rawPayload;
      outBytes = file.length;
      const tmpFile = path.join(imageDir, `out-${c.id}.mp4`);
      fs.writeFileSync(tmpFile, file);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', tmpFile], { encoding: 'utf8' }));
      outSec = Number(probe.format.duration);
      fs.rmSync(tmpFile, { force: true });
    }
    const s2 = stepAt[2];
    const s3 = stepAt[3];
    return {
      c,
      total: wall,
      // 단계 전환 시각은 200ms 간격 조회로 잡으므로 ±0.2초의 오차가 있다
      step2: s2 !== undefined && s3 !== undefined ? s3 - s2 : 0,
      step3: s3 !== undefined ? tEnd - s3 : 0,
      ffmpegRssKb: maxFfmpeg,
      serverRssKb: maxServer,
      tmpKb: maxTmp,
      outBytes,
      outSec,
      inputKb: Math.round((image.length * c.scenes) / 1024),
      status: job.status === 'done' ? '성공' : `${job.status}: ${job.error?.title ?? ''}`,
    };
  } finally {
    await app.close();
  }
}

async function main() {
  const only = arg('only')?.split(',');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-measure-'));
  const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-measure-img-'));
  const results: Result[] = [];
  for (const c of CASES.filter((x) => !only || only.includes(x.id))) {
    process.stderr.write(`[${c.id}] ${c.label} …\n`);
    const r = await runCase(c, dataDir, imageDir);
    process.stderr.write(`[${c.id}] ${r.status} ${fmtS(r.total)}\n`);
    results.push(r);
  }
  const cpus = os.cpus();
  const md = [
    '## 영상 생성 측정',
    '',
    `환경: ${cpus.length} 코어(${cpus[0]?.model ?? '?'}), 메모리 ${(os.totalmem() / 1024 ** 3).toFixed(0)}GB, ${execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0]}`,
    '',
    '| 케이스 | 영상 길이 | 걸린 시간 | 실시간 대비 | 장면 화면 단계 | MP4 저장 단계 | ffmpeg 최대 메모리 | 서버 최대 메모리 | 임시 폴더 최대 | 입력 이미지 합 | 완성 파일 | 결과 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const len = r.c.scenes * r.c.seconds;
      return `| ${r.c.id}. ${r.c.label} | ${len}초 | ${fmtS(r.total)} | ${(r.total / 1000 / len).toFixed(2)}배 | ${fmtS(r.step2)} | ${fmtS(r.step3)} | ${fmtMb(r.ffmpegRssKb)} | ${fmtMb(r.serverRssKb)} | ${fmtMb(r.tmpKb)} | ${fmtMb(r.inputKb)} | ${(r.outBytes / 1024 / 1024).toFixed(1)}MB(${r.outSec.toFixed(1)}초) | ${r.status} |`;
    }),
    '',
  ].join('\n');
  console.log(md);
  const out = arg('out');
  if (out) fs.writeFileSync(out, md);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(imageDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
