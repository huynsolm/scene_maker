import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { VIDEO } from '../shared/limits';
import { cleanText, cleanTitle } from '../shared/text';
import type { JobStatus, RenderJobView, RenderList } from '../shared/types';
import type { Db } from './db';
import { AppError, notFound } from './errors';
import { rmdirIfEmpty, safeRm } from './fsSafe';
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
  error_scene: number | null;
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

    // 수정 전에 저장된 값(보이지 않는 문자나 NFD 가 섞인 값)도 영상에 쓰이는 값과 같은 규칙으로 정리한 뒤 검사하고 스냅샷에 담는다.
    // 그렇지 않으면 `\u200B` 만 있는 문구가 필수값 검사(trim)를 통과해 빈 자막 영상이 만들어지고,
    // 결과 화면의 문구와 영상의 문구가 달라진다. DB 를 일괄 변환하지 않고도 기존 데이터를 방어한다.
    const title = cleanTitle(project.title);
    const scenes = project.scenes.map((s) => ({ ...s, text: cleanText(s.text) }));

    const missing: string[] = [];
    if (!title.trim()) missing.push('제목');
    scenes.forEach((s, i) => {
      if (!s.text.trim()) missing.push(`장면 ${i + 1} 문구`);
      if (!s.image) missing.push(`장면 ${i + 1} 이미지`);
    });
    if (missing.length) {
      throw new AppError('RENDER_INCOMPLETE', 422, `비어 있는 항목이 있어요: ${missing.join(', ')}`, { missing });
    }

    const snapshot: Snapshot = {
      title,
      scenes: scenes.map((s) => ({
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

  // ───────── 지난 영상 목록과 삭제 ─────────

  /**
   * 완성된 영상 목록(최신순). 정렬은 `Store.getProject().lastVideo` 와 같다: `finished_at DESC, rowid DESC`(같은 시각이면 rowid 가 큰 쪽이 먼저).
   * `latestForProject` 는 실패·진행 중 작업도 돌려주므로 여기서는 쓰지 않는다.
   * `before` 는 직전 페이지 마지막 항목의 id 이며 그 다음 항목부터 돌려준다. 그 영상이 이미 지워졌으면 404 로, 처음부터 다시 읽게 한다.
   */
  listDone(projectId: string, opts: { limit: number; before?: string }): RenderList {
    if (!this.db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(projectId)) throw notFound();
    const DONE = `project_id = ? AND status = 'done' AND video_file IS NOT NULL`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM render_jobs WHERE ${DONE}`).get(projectId) as { n: number }).n;
    let rows: JobRow[];
    if (opts.before) {
      const cur = this.db
        .prepare(`SELECT rowid AS rid, finished_at FROM render_jobs WHERE id = ? AND ${DONE}`)
        .get(opts.before, projectId) as { rid: number; finished_at: string } | undefined;
      if (!cur) throw notFound('목록의 기준 영상');
      rows = this.db
        .prepare(`SELECT * FROM render_jobs WHERE ${DONE} AND (finished_at, rowid) < (?, ?) ORDER BY finished_at DESC, rowid DESC LIMIT ?`)
        .all(projectId, cur.finished_at, cur.rid, opts.limit + 1) as JobRow[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM render_jobs WHERE ${DONE} ORDER BY finished_at DESC, rowid DESC LIMIT ?`)
        .all(projectId, opts.limit + 1) as JobRow[];
    }
    const hasMore = rows.length > opts.limit;
    const items = rows.slice(0, opts.limit).map((r) => {
      const v = this.toView(r);
      return {
        id: v.id,
        createdAt: v.createdAt,
        finishedAt: v.finishedAt!,
        totalSec: v.snapshot.totalSec,
        sceneCount: v.snapshot.scenes.length,
        outdated: v.outdated,
        videoUrl: v.videoUrl!,
        downloadUrl: v.downloadUrl!,
      };
    });
    return { items, hasMore, total };
  }

  /**
   * 완성된 영상 하나를 지운다(작업 기록, 영상 파일, 이 영상에만 쓰이던 이미지). 되돌릴 수 없다.
   *
   * 순서: (1) 한 트랜잭션에서 연결 이미지 id 를 읽고, 작업 행을 지우고(연결은 CASCADE), 프로젝트 상태를 다시 계산한다.
   * (2) 커밋 뒤 영상 파일을 지우고, (3) 읽어 둔 이미지마다 `collectImageIfUnused`(현재 장면과 남은 모든 작업이 참조하지 않을 때만 삭제).
   * 파일 삭제는 각각 실패해도 계속 진행하고(`safeRm`) 남은 파일은 다음 서버 시작 때 정리한다.
   * `projects.updated_at` 은 바꾸지 않는다 — 삭제는 편집 내용의 변경이 아니며, 바꾸면 남은 영상이 모두 '내용이 바뀐 뒤'로 표시된다.
   * 서버는 단일 프로세스이고 이 구간이 동기 실행이라 요청 사이의 끼어들기가 없다(파일 작업을 비동기로 바꾸면 다시 검토해야 한다).
   */
  deleteVideo<T = undefined>(projectId: string, jobId: string, readAfter?: () => T): { removedImages: number; after: T } {
    const job = this.getJob(jobId);
    if (!job || job.project_id !== projectId) throw notFound('영상'); // 다른 프로젝트의 작업은 없는 것으로 취급
    if (job.status === 'waiting' || job.status === 'generating') {
      throw new AppError('RENDER_NOT_DELETABLE', 409, '영상을 만드는 중이라 지울 수 없어요. 끝난 뒤에 다시 시도해 주세요.');
    }
    if (job.status !== 'done') {
      throw new AppError('RENDER_NOT_DELETABLE', 409, '완성된 영상만 지울 수 있어요.');
    }
    let imageIds: string[] = [];
    let after = undefined as T;
    this.db.transaction(() => {
      imageIds = (this.db.prepare(`SELECT image_id FROM render_job_images WHERE job_id = ?`).all(jobId) as Array<{ image_id: string }>).map(
        (r) => r.image_id,
      );
      this.db.prepare(`DELETE FROM render_jobs WHERE id = ?`).run(jobId);
      this.recomputeProjectStatus(projectId);
      // 응답에 쓸 목록 등은 같은 트랜잭션 안에서 읽는다. 여기서 예외가 나면 삭제도 되돌려,
      // "영상은 지워졌는데 응답은 실패"처럼 응답이 실제 상태와 반대가 되지 않게 한다.
      if (readAfter) after = readAfter();
    })();

    // 커밋 뒤의 파일·이미지 회수는 최선만 다한다: 하나가 실패해도 로그만 남기고 계속하며 응답을 뒤집지 않는다.
    // 남은 파일은 safeRm 이, 남은 이미지 행·파일은 서버 시작 시 sweepOrphans 가 정리한다.
    safeRm(this.videoPathFor(projectId, jobId));
    rmdirIfEmpty(path.join(this.store.videosDir, projectId));
    let removedImages = 0;
    for (const id of imageIds) {
      try {
        if (this.store.collectImageIfUnused(id)) removedImages++;
      } catch (e) {
        console.warn(`[이미지 회수 실패] ${id} (${(e as Error)?.message ?? e}) — 다음 서버 시작 때 다시 정리한다`);
      }
    }
    return { removedImages, after };
  }

  /**
   * 작업이 지워진 뒤 프로젝트 상태를 다시 계산한다. 활성 작업이 있으면 건드리지 않는다. 아니면 **생성 순서상** 가장 최근 작업
   * (`created_at DESC, rowid DESC`, 상태 무관 — `latestForProject` 와 같다)의 결과를 쓰되, 그 작업을 요청한 뒤에 내용이 고쳐졌으면
   * '편집 중'(`finish` 와 같은 규칙). 남은 작업이 없으면 '편집 중'.
   */
  private recomputeProjectStatus(projectId: string) {
    if (this.activeJob(projectId)) return;
    const latest = this.db
      .prepare(`SELECT status, created_at FROM render_jobs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(projectId) as { status: JobStatus; created_at: string } | undefined;
    const proj = this.db.prepare(`SELECT updated_at FROM projects WHERE id = ?`).get(projectId) as { updated_at: string } | undefined;
    if (!proj) return;
    const status = !latest || proj.updated_at > latest.created_at ? 'editing' : latest.status;
    this.db.prepare(`UPDATE projects SET status = ? WHERE id = ?`).run(status, projectId);
  }

  toView(j: JobRow): RenderJobView {
    const snap = JSON.parse(j.snapshot_json) as Snapshot;
    const done = j.status === 'done' && !!j.video_file;
    const edited = this.db
      .prepare(`SELECT updated_at > ? AS edited FROM projects WHERE id = ?`)
      .get(j.created_at, j.project_id) as { edited: number } | undefined;
    return {
      id: j.id,
      projectId: j.project_id,
      status: j.status,
      step: j.step,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
      outdated: edited?.edited === 1,
      error:
        j.status === 'failed'
          ? {
              code: j.error_code ?? 'INTERNAL',
              title: j.error_title ?? '',
              body: j.error_body ?? '',
              scene: j.error_scene,
              at: j.finished_at ?? j.created_at,
            }
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
          // 실패 작업은 이미지를 회수하므로 주소를 주지 않는다. 회수 성공 여부와 무관하게 상태만으로 정한다.
          imageUrl: j.status === 'failed' ? null : imageUrl(s.imageId),
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

  /**
   * 작업을 실패로 기록한 뒤, 그 작업이 붙잡고 있던 이미지를 놓아 준다.
   * 실패한 작업은 다시 렌더되지 않으므로("다시 시도"는 현재 내용으로 새 작업을 만든다) 이미지가 필요 없다.
   * 상태 기록(finish)의 예외는 그대로 던지고, 그 뒤의 회수는 최선만 다한다(`releaseImagesOf`).
   */
  fail(jobId: string, e: RenderError) {
    this.finish(jobId, 'failed', { error_code: e.code, error_title: e.title, error_body: e.body, error_scene: e.sceneNo ?? null, error_detail: (e.detail ?? '').slice(0, 4000) || null });
    this.releaseImagesOf(jobId);
  }

  /** 작업에 연결된 이미지 id. */
  private linkedImageIds(jobId: string): string[] {
    return (this.db.prepare(`SELECT image_id FROM render_job_images WHERE job_id = ?`).all(jobId) as Array<{ image_id: string }>).map(
      (r) => r.image_id,
    );
  }

  /** 작업의 이미지 연결을 모두 끊는다. 작업 기록 자체는 남는다. */
  private unlinkImages(jobId: string): number {
    return this.db.prepare(`DELETE FROM render_job_images WHERE job_id = ?`).run(jobId).changes;
  }

  /**
   * 실패 기록이 커밋된 뒤 실행하는 후처리: 연결 이미지 id 읽기 → 연결 끊기 → 이미지마다 `collectImageIfUnused`.
   * 현재 장면·완성 작업·진행 중 작업이 쓰는 이미지는 `collectImageIfUnused`가 남긴다.
   * 어느 단계에서 예외가 나도 로그만 남기고 계속한다(이미지마다 따로). 실패 기록은 이미 커밋되어 뒤집히지 않고,
   * 남은 연결·이미지는 다음 서버 시작 때 `releaseFailedImages` → `sweepOrphans`가 정리한다.
   */
  private releaseImagesOf(jobId: string) {
    let ids: string[];
    try {
      ids = this.linkedImageIds(jobId);
      this.unlinkImages(jobId);
    } catch (e) {
      console.warn(`[실패 작업 이미지 연결 해제 실패] ${jobId} (${(e as Error)?.message ?? e}) — 다음 서버 시작 때 다시 정리한다`);
      return;
    }
    for (const id of ids) {
      try {
        this.store.collectImageIfUnused(id);
      } catch (e) {
        console.warn(`[이미지 회수 실패] ${id} (${(e as Error)?.message ?? e}) — 다음 서버 시작 때 다시 정리한다`);
      }
    }
  }

  /**
   * 작업을 끝낸다. 요청 이후에 프로젝트 내용이 바뀌었다면(생성 중 편집) 프로젝트는 '편집 중'으로 두고,
   * 그렇지 않으면 작업 결과(완료/실패)를 프로젝트 상태로 올린다. 작업 기록 자체는 어느 경우에도 남는다.
   */
  private finish(jobId: string, status: 'done' | 'failed', cols: Record<string, string | number | null>) {
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

  /** 대기·생성 중이던 작업을 실패로 바꾼다. 사용자가 직접 다시 시도한다. 입력은 건드리지 않고, 작업이 붙잡던 이미지는 `fail`처럼 놓아 준다. */
  failInterrupted(): number {
    const rows = this.db.prepare(`SELECT id FROM render_jobs WHERE status IN ${ACTIVE}`).all() as Array<{ id: string }>;
    for (const { id } of rows) this.fail(id, serverRestarted());
    return rows.length;
  }

  /**
   * 실패한 작업의 이미지 연결을 모두 끊는다(이 기능 이전에 쌓인 실패 기록, 회수 도중 멈춘 경우).
   * 연결이 사라진 이미지는 뒤이어 실행하는 `sweepOrphans`가 회수한다. 매번 실행해도 안전하다.
   */
  releaseFailedImages(): number {
    return this.db
      .prepare(`DELETE FROM render_job_images WHERE job_id IN (SELECT id FROM render_jobs WHERE status = 'failed')`)
      .run().changes;
  }

  /** 임시 작업 폴더와, 완료된 작업이 가리키지 않는 영상 파일(쓰다 만 파일 포함)을 지운다. */
  sweepFiles(): { removedTmp: boolean; removedVideos: number; failedFiles: number } {
    let failedFiles = 0;
    const tmp = path.join(this.store.dataDir, 'tmp');
    const hadTmp = fs.existsSync(tmp);
    // 잠긴 파일 하나 때문에 서버 시작 전체가 실패하지 않게 파일마다 따로 시도하고, 못 지운 것은 다음 시작 때 다시 시도한다.
    const removedTmp = hadTmp && safeRm(tmp, { recursive: true });
    if (hadTmp && !removedTmp) failedFiles++;

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
            if (safeRm(path.join(full, f))) removedVideos++;
            else failedFiles++;
          }
        }
        rmdirIfEmpty(full);
      }
    }
    return { removedTmp, removedVideos, failedFiles };
  }
}
