import { spawn } from 'node:child_process';
import { RenderError } from './errors';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** 자식 프로세스를 실행한다. 출력은 마지막 일부만 보관한다(오류 상세용). */
export function run(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(notFoundOr(bin, e));
    }
    let stdout = '';
    let stderr = '';
    const keep = (s: string, add: string) => (s + add).slice(-8000);
    child.stdout.on('data', (d) => (stdout = keep(stdout, String(d))));
    child.stderr.on('data', (d) => (stderr = keep(stderr, String(d))));

    let timedOut = false;
    let aborted = false;
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(notFoundOr(bin, e));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (timedOut) {
        return reject(
          new RenderError('RENDER_TIMEOUT', '영상을 만드는 데 너무 오래 걸렸어요', '잠시 후 다시 시도해 주세요. 이미지가 매우 크다면 더 작은 파일로 바꿔 보세요.', stderr),
        );
      }
      if (aborted) return reject(new Error('aborted'));
      if (code !== 0) {
        return reject(
          new RenderError('RENDER_FAILED', '영상을 만드는 중에 문제가 생겼어요', '잠시 후 다시 시도해 주세요. 같은 오류가 나면 해당 장면의 이미지를 다른 파일로 바꿔 보세요.', `exit ${code}\n${stderr}`),
        );
      }
      resolve({ stdout, stderr });
    });
  });
}

function notFoundOr(bin: string, e: unknown) {
  if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
    return new RenderError(
      'FFMPEG_NOT_FOUND',
      '영상 만드는 도구를 찾을 수 없어요',
      '서버에 ffmpeg 가 설치되어 있어야 해요. 설치한 뒤 다시 시도해 주세요.',
      `${bin} 을(를) 실행할 수 없음`,
    );
  }
  return e;
}

/** ffmpeg 필터 옵션 값에서 의미가 있는 문자를 이스케이프한다. */
export const escapeFilterValue = (v: string) => v.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
