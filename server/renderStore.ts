import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VIDEO } from '../shared/limits';
import type { JobStatus, RenderJobView } from '../shared/types';
import type { Db } from './db';
import { AppError, notFound } from './errors';
import { RenderError, serverRestarted } from './render/errors';
import { imageUrl, type Store } from './store';

interface SnapshotScene {
  position: number;
  text: string;
  durationSec: number;
  imageId: string;
  imageFileName: string;
}
interface Snapshot {
  title: string;
  scenes: SnapshotScene[];
}

export interface JobRow {
  id: string;
  project_id: string;
  status: JobStatus;
  snapshot_json: string;
  error_code: string | null;
  error_title: string | null;
  error_body: string | null;
  error_detail: string | null;
  step: number;
  video_file: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const ACTIVE = `('waiting','generating')`;

export class RenderStore {
  constructor(
    private readonly db: Db,
    private readonly store: Store,
  ) {}

  // ───────── 요청 ─────────

  /**
   * 영상 생성을 요청한다. 요청 시점의 제목·장면 내용을 스냅샷으로 저장하므로 이후 편집은 이 작업에 섞이지 않는다.
   * 진행 중인 작업이 있으면 새로 만들지 않고 409(RENDER_IN_PROGRESS)로 기존 작업을 알려준다.
   * "프로젝트당 진행 중 작업 1개"는 부분 유니크 인덱스가 최종적으로 보장한다.
   */
  createJob(projectId: string): JobRow {
    const project = this.store.getProject(projectId);

    const missing: string[] = [];
    if (!project.title.trim()) missing.push('제목');
    project.scenes.forEach((s, i) => {
      if (!s.text.trim()) missing.push(`장면 ${i + 1} 문구`);
      if (!s.image) missing.push(`장면 ${i + 1} 이미지`);
    });
    if (missing.length) {
      throw new AppError('RENDER_INCOMPLETE', 422, `비어 있는 항목이 있어요: ${missing.join(', ')}`, { missing });
    }

    const snapshot: Snapshot = {
      title: project.title,
      scenes: project.scenes.map((s) => ({
        position: s.position,
        text: s.text,
        durationSec: s.durationSec,
        imageId: s.image!.id,
        imageFileName: s.image!.fileName,
      })),
    };
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO render_jobs (id, project_id, status, step, snapshot_json, created_at) VALUES (?, ?, 'waiting', 1, ?, ?)`,
          )
          .run(id, projectId, JSON.stringify(snapshot), now);
        const link = this.db.prepare(`INSERT OR IGNORE INTO render_job_images (job_id, image_id) VALUES (?, ?)`);
        for (const s of snapshot.scenes) link.run(id, s.imageId);
        // 상태만 바꾼다. updated_at 은 '내용을 고친 시각'이라서 건드리지 않는다.
        this.db.prepare(`UPDATE projects SET status = 'waiting' WHERE id = ?`).run(projectId);
      })();
    } catch (e) {
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const active = this.activeJob(projectId);
        if (active) throw this.inProgress(active);
      }
      throw e;
    }
    return this.getJob(id)!;
  }

  private inProgress(active: JobRow) {
    return new AppError('RENDER_IN_PROGRESS', 409, '이미 영상을 만드는 중이에요. 끝난 뒤에 다시 요청할 수 있어요.', {
      job: this.toView(active),
    });
  }

  // ───────── 조회 ─────────

  getJob(id: string): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM render_jobs WHERE id = ?`).get(id) as JobRow | undefined;
  }
  requireJob(id: string): JobRow {
    const j = this.getJob(id);
    if (!j) throw notFound('작업');
    return j;
  }
  activeJob(projectId: string): JobRow | undefined {
    return this.db
      .prepare(`SELECT * FROM render_jobs WHERE project_id = ? AND status IN ${ACTIVE}`)
      .get(projectId) as JobRow | undefined;
  }
  latestForProject(projectId: string): JobRow | undefined {
    this.store.getProject(projectId); // 없으면 404
    return this.db
      .prepare(`SELECT * FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(projectId) as JobRow | undefined;
  }

  toView(j: JobRow): RenderJobView {
    const snap = JSON.parse(j.snapshot_json) as Snapshot;
    const done = j.status === 'done' && !!j.video_file;
    return {
      id: j.id,
      projectId: j.project_id,
      status: j.status,
      step: j.step,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
      error:
        j.status === 'failed'
          ? { code: j.error_code ?? 'INTERNAL', title: j.error_title ?? '', body: j.error_body ?? '', at: j.finished_at ?? j.created_at }
          : null,
      videoUrl: done ? `/api/renders/${j.id}/video` : null,
      downloadUrl: done ? `/api/renders/${j.id}/video?download=1` : null,
      snapshot: {
        title: snap.title,
        totalSec: snap.scenes.reduce((a, s) => a + s.durationSec, 0),
        scenes: snap.scenes.map((s) => ({
          position: s.position,
          text: s.text,
          durationSec: s.durationSec,
          imageUrl: imageUrl(s.imageId),
          imageFileName: s.imageFileName,
        })),
      },
      output: done ? { width: VIDEO.width, height: VIDEO.height, fps: VIDEO.fps } : null,
    };
  }

  // ───────── 작업 처리(큐가 사용) ─────────

  hasWaiting(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM render_jobs WHERE status = 'waiting'`).get();
  }

  /** 가장 오래된 대기 작업을 '생성 중'으로 바꿔 가져온다. */
  claimNext(): JobRow | undefined {
    return this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM render_jobs WHERE status = 'waiting' ORDER BY created_at, rowid LIMIT 1`)
        .get() as JobRow | undefined;
      if (!job) return undefined;
      this.db
        .prepare(`UPDATE render_jobs SET status = 'generating', step = 2, started_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), job.id);
      this.db.prepare(`UPDATE projects SET status = 'generating' WHERE id = ?`).run(job.project_id);
      return this.getJob(job.id);
    })();
  }

  setStep(jobId: string, step: number) {
    this.db.prepare(`UPDATE render_jobs SET step = ? WHERE id = ? AND status = 'generating'`).run(step, jobId);
  }

  /** 렌더에 쓸 장면 목록(이미지 경로 포함). 스냅샷 기준이며 현재 편집 내용은 보지 않는다. */
  sceneInputs(job: JobRow): Array<{ text: string; durationSec: number; imagePath: string }> {
    const snap = JSON.parse(job.snapshot_json) as Snapshot;
    return snap.scenes.map((s) => ({
      text: s.text,
      durationSec: s.durationSec,
      imagePath: this.store.imageFileForRender(s.imageId),
    }));
  }

  videoPathFor(projectId: string, jobId: string) {
    return path.join(this.store.videosDir, projectId, `${jobId}.mp4`);
  }

  complete(jobId: string, videoFile: string) {
    this.finish(jobId, 'done', { video_file: videoFile });
  }

  fail(jobId: string, e: RenderError) {
    this.finish(jobId, 'failed', { error_code: e.code, error_title: e.title, error_body: e.body, error_detail: (e.detail ?? '').slice(0, 4000) || null });
  }

  /**
   * 작업을 끝낸다. 요청 이후에 프로젝트 내용이 바뀌었다면(생성 중 편집) 프로젝트는 '편집 중'으로 두고,
   * 그렇지 않으면 작업 결과(완료/실패)를 프로젝트 상태로 올린다. 작업 기록 자체는 어느 경우에도 남는다.
   */
  private finish(jobId: string, status: 'done' | 'failed', cols: Record<string, string | null>) {
    this.db.transaction(() => {
      const job = this.requireJob(jobId);
      const set = Object.keys(cols).map((c) => `${c} = @${c}`);
      this.db
        .prepare(`UPDATE render_jobs SET status = @status, finished_at = @at, ${set.length ? set.join(', ') + ',' : ''} step = step WHERE id = @id`)
        .run({ ...cols, status, at: new Date().toISOString(), id: jobId });
      this.db
        .prepare(
          `UPDATE projects
              SET status = CASE WHEN updated_at > @created THEN 'editing' ELSE @status END
            WHERE id = @pid AND status IN ('waiting','generating')`,
        )
        .run({ created: job.created_at, status, pid: job.project_id });
    })();
  }

  // ───────── 서버 시작 시 복구 ─────────

  /** 대기·생성 중이던 작업을 실패로 바꾼다. 사용자가 직접 다시 시도한다. 입력과 이미지는 건드리지 않는다. */
  failInterrupted(): number {
    const rows = this.db.prepare(`SELECT id FROM render_jobs WHERE status IN ${ACTIVE}`).all() as Array<{ id: string }>;
    for (const { id } of rows) this.fail(id, serverRestarted());
    return rows.length;
  }

  /** 임시 작업 폴더와, 완료된 작업이 가리키지 않는 영상 파일(쓰다 만 파일 포함)을 지운다. */
  sweepFiles(): { removedTmp: boolean; removedVideos: number } {
    const tmp = path.join(this.store.dataDir, 'tmp');
    const removedTmp = fs.existsSync(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });

    const known = new Set(
      (this.db.prepare(`SELECT project_id, video_file FROM render_jobs WHERE video_file IS NOT NULL`).all() as Array<{
        project_id: string;
        video_file: string;
      }>).map((r) => `${r.project_id}/${r.video_file}`),
    );
    let removedVideos = 0;
    const root = this.store.videosDir;
    if (fs.existsSync(root)) {
      for (const dir of fs.readdirSync(root)) {
        const full = path.join(root, dir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const f of fs.readdirSync(full)) {
          if (!known.has(`${dir}/${f}`)) {
            fs.rmSync(path.join(full, f), { force: true });
            removedVideos++;
          }
        }
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      }
    }
    return { removedTmp, removedVideos };
  }
}
