import fs from 'node:fs';
import path from 'node:path';
import { RenderError, toRenderError } from './render/errors';
import type { Renderer } from './render/renderer';
import type { JobRow, RenderStore } from './renderStore';
import type { Store } from './store';

/**
 * 프로세스 안에서 한 번에 하나씩 렌더 작업을 처리하는 큐. 작업의 진실은 DB(render_jobs)에 있고,
 * 큐는 '대기' 작업을 꺼내 실행하는 일꾼일 뿐이다. 그래서 서버가 죽어도 DB 상태만 보면 복구할 수 있다.
 */
export class RenderQueue {
  private running = false;
  private closed = false;
  private current: Promise<void> | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly renders: RenderStore,
    private readonly store: Store,
    private readonly renderer: Renderer,
  ) {}

  kick() {
    if (this.running || this.closed) return;
    this.running = true;
    this.current = this.loop().finally(() => {
      this.running = false;
      this.current = null;
      // 마지막 확인과 running=false 사이에 들어온 요청을 놓치지 않는다.
      if (!this.closed && this.renders.hasWaiting()) this.kick();
    });
  }

  /** 진행 중 작업을 중단하고 기다린다. 중단된 작업은 DB 에 '생성 중'으로 남고 다음 시작 때 실패로 복구된다(비정상 종료와 동일). */
  async close() {
    this.closed = true;
    this.abort.abort();
    await this.current;
  }

  private async loop() {
    while (!this.closed) {
      const job = this.renders.claimNext();
      if (!job) return;
      await this.runJob(job);
    }
  }

  private async runJob(job: JobRow) {
    const workDir = path.join(this.store.dataDir, 'tmp', job.id);
    try {
      const result = await this.renderer.render(
        { scenes: this.renders.sceneInputs(job), workDir },
        { onStep: (s) => this.renders.setStep(job.id, s), signal: this.abort.signal },
      );
      if (this.closed) return;
      // 완성 파일을 제자리로 옮긴 뒤에 DB 를 완료로 바꾼다(반대 순서면 파일 없는 '완료'가 생길 수 있다).
      const finalPath = this.renders.videoPathFor(job.project_id, job.id);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.renameSync(result.outputPath, finalPath);
      this.renders.complete(job.id, path.basename(finalPath));
    } catch (e) {
      if (this.closed) return; // 종료 중 중단: 상태를 바꾸지 않는다
      const err = e instanceof RenderError ? e : toRenderError(e);
      this.renders.fail(job.id, err);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
