// 재현: 렌더 작업 마무리 중 예외가 서버 프로세스를 종료시키는가 (docs/plan-render-queue-resilience.md §3)
//   npx tsx scripts/repro-queue-crash.mts <rm|complete|both> [nohandler]
//   rm: 작업 폴더 정리(fs.rmSync)가 EBUSY / complete: complete() 가 DB 오류 / both: complete()·fail() 모두 DB 오류
//   nohandler: 처리기 없이 실제 서버와 같은 조건(프로세스가 죽으면 종료 코드 1)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../server/app';
import { createSampleProject } from '../server/seed';

const mode = process.argv[2] ?? 'rm';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-repro-'));
const renderer = {
  async render(input: any, hooks: any) {
    hooks.onStep(2);
    fs.mkdirSync(input.workDir, { recursive: true });
    const out = path.join(input.workDir, 'output.mp4');
    fs.writeFileSync(out, 'x');
    return { outputPath: out, durationSec: 1, width: 1280, height: 720, hasAudio: false };
  },
};
const { app, store, renders } = (await buildApp({ dataDir, webDist: null }, { renderer: renderer as any })) as any;
const realRm = fs.rmSync;
if (mode === 'rm') {
  (fs as any).rmSync = (p: fs.PathLike, o?: fs.RmOptions) => {
    if (String(p).startsWith(path.join(dataDir, 'tmp') + path.sep)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return realRm(p, o);
  };
} else if (mode === 'complete') {
  renders.complete = () => { throw new Error('SQLITE_BUSY: database is locked'); };
} else {
  renders.complete = () => { throw new Error('SQLITE_BUSY: database is locked'); };
  renders.fail = () => { throw new Error('SQLITE_BUSY: database is locked (fail)'); };
}
const p = createSampleProject(store);
const res = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` });
const jobId = res.json().job.id;
console.log('요청', res.statusCode, jobId);
if (process.argv[3] !== 'nohandler') process.on('uncaughtException', (e) => { console.log('uncaughtException:', e.message); });
if (process.argv[3] !== 'nohandler') process.on('unhandledRejection', (e: any) => { console.log('unhandledRejection:', e?.message); process.exitCode = 7; });
process.on('exit', (c) => {
  const row = renders.getJob(jobId);
  console.log(`프로세스 종료 code=${c} 작업 상태=${row.status}`);
  realRm(dataDir, { recursive: true, force: true });
});
setTimeout(async () => {
  console.log('2초 뒤에도 살아 있음. 작업 상태 =', renders.getJob(jobId).status);
  const res2 = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/renders` });
  console.log('다음 요청', res2.statusCode);
  setTimeout(() => { console.log('다음 작업 상태 =', renders.getJob(res2.json().job?.id ?? jobId).status); process.exit(0); }, 1000);
}, 2000);
