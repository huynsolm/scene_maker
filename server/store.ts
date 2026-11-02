import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DURATION_DEFAULT_SEC,
  SCENE_DEFAULT,
  SCENE_MAX,
  SCENE_MIN,
} from '../shared/limits';
import { cleanText, cleanTitle } from '../shared/text';
import type { Project, ProjectStatus, ProjectSummary, Scene } from '../shared/types';
import type { Db } from './db';
import { AppError, notFound } from './errors';
import { rmdirIfEmpty, safeRm } from './fsSafe';
import { inspectImage, sanitizeDisplayName } from './imageInspect';

interface ProjectRow {
  id: string;
  title: string;
  status: ProjectStatus;
  is_sample: number;
  created_at: string;
  updated_at: string;
}

interface SceneRow {
  id: string;
  position: number;
  text: string;
  duration_sec: number;
  image_id: string | null;
  file_name: string | null;
  width: number | null;
  height: number | null;
  img_is_sample: number | null;
}

/** 저장 입력. 내부 호출은 장면 ID 를 생략할 수 있다(위치 순서로 적용). */
export interface SaveInput {
  title: string;
  scenes: Array<{ id?: string; text: string; durationSec: number }>;
}

const scenesChanged = () =>
  new AppError('SCENES_CHANGED', 409, '장면 구성이 바뀌었어요. 화면을 새로 고친 뒤 다시 시도해 주세요.');

export const imageUrl = (id: string) => `/api/images/${id}/file`;

export class Store {
  constructor(
    private readonly db: Db,
    readonly dataDir: string,
  ) {}

  get uploadsDir() {
    return path.join(this.dataDir, 'uploads');
  }
  get videosDir() {
    return path.join(this.dataDir, 'videos');
  }
  /** id 는 서버가 만든 UUID 뿐이지만, 경로를 조립할 때 한 번 더 형식을 확인한다. */
  private safeSegment(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('INVALID_INPUT', 400, '잘못된 요청이에요.');
    return id;
  }
  imagePath(projectId: string, storedName: string) {
    return path.join(this.uploadsDir, this.safeSegment(projectId), path.basename(storedName));
  }

  // ───────── 프로젝트 ─────────

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.status, p.is_sample, p.updated_at,
                (SELECT COALESCE(SUM(duration_sec),0) FROM scenes s WHERE s.project_id = p.id) AS total_sec,
                (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) AS scene_count,
                (SELECT image_id FROM scenes s WHERE s.project_id = p.id AND image_id IS NOT NULL
                  ORDER BY position LIMIT 1) AS thumb_id
           FROM projects p
          ORDER BY p.updated_at DESC, p.created_at DESC`,
      )
      .all() as Array<{
      id: string;
      title: string;
      status: ProjectStatus;
      is_sample: number;
      updated_at: string;
      total_sec: number;
      scene_count: number;
      thumb_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updated_at,
      totalSec: r.total_sec,
      sceneCount: r.scene_count,
      thumbnailUrl: r.thumb_id ? imageUrl(r.thumb_id) : null,
      isSample: r.is_sample === 1,
    }));
  }

  createProject(opts: { title?: string; isSample?: boolean } = {}): Project {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects (id, title, status, is_sample, created_at, updated_at)
           VALUES (?, ?, 'editing', ?, ?, ?)`,
        )
        // 저장 불변식(shared/text.ts)은 API 스키마뿐 아니라 쓰는 곳에서도 보장한다(스크립트·내부 호출이 우회하지 못하게). 정리는 멱등이다.
        .run(id, cleanTitle(opts.title ?? ''), opts.isSample ? 1 : 0, now, now);
      const ins = this.db.prepare(
        `INSERT INTO scenes (id, project_id, position, text, duration_sec) VALUES (?, ?, ?, '', ?)`,
      );
      for (let i = 0; i < SCENE_DEFAULT; i++) ins.run(crypto.randomUUID(), id, i, DURATION_DEFAULT_SEC);
    });
    tx();
    return this.getProject(id);
  }

  getProject(id: string): Project {
    const p = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
    if (!p) throw notFound();
    const rows = this.db
      .prepare(
        `SELECT s.id, s.position, s.text, s.duration_sec, s.image_id,
                i.file_name, i.width, i.height, i.is_sample AS img_is_sample
           FROM scenes s LEFT JOIN images i ON i.id = s.image_id
          WHERE s.project_id = ? ORDER BY s.position`,
      )
      .all(id) as SceneRow[];
    const scenes: Scene[] = rows.map((r) => ({
      id: r.id,
      position: r.position,
      text: r.text,
      durationSec: r.duration_sec,
      image: r.image_id
        ? {
            id: r.image_id,
            fileName: r.file_name ?? '이미지',
            url: imageUrl(r.image_id),
            width: r.width ?? 0,
            height: r.height ?? 0,
            isSample: r.img_is_sample === 1,
          }
        : null,
    }));
    const last = this.db
      .prepare(
        `SELECT id, finished_at FROM render_jobs
          WHERE project_id = ? AND status = 'done' AND video_file IS NOT NULL
          ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(id) as { id: string; finished_at: string } | undefined;
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      scenes,
      isSample: p.is_sample === 1,
      lastVideo: last ? { jobId: last.id, finishedAt: last.finished_at } : null,
    };
  }

  /**
   * 제목과 장면 내용을 저장한다. 완료/실패 상태의 프로젝트를 고치면 '편집 중'으로 돌아간다.
   * 대기/생성 중에는 상태를 건드리지 않는다. 진행 중인 작업은 요청 시점 스냅샷을 쓰므로
   * 지금 저장하는 내용은 다음 생성부터 반영된다.
   *
   * 장면 ID 를 보내면 서버의 현재 장면 목록(순서 포함)과 같아야 한다. 다르면 SCENES_CHANGED(409)로 거절한다 —
   * 장면을 추가·삭제하기 전에 보낸 오래된 저장이 삭제된 장면을 되살리거나 엉뚱한 장면을 덮어쓰지 못하게 한다.
   * ID 없이 보내면(내부 호출·하위 호환) 현재 장면 수와 같을 때 위치 순서대로 적용한다.
   */
  saveProject(id: string, input: SaveInput): Project {
    const tx = this.db.transaction(() => {
      this.requireProject(id);
      const current = this.sceneIds(id);
      const sent = input.scenes.map((s) => s.id);
      if (sent.every((x) => x)) {
        if (sent.length !== current.length || sent.some((x, i) => x !== current[i])) throw scenesChanged();
      } else if (sent.some((x) => x) || input.scenes.length !== current.length) {
        throw scenesChanged();
      }
      const upd = this.db.prepare(`UPDATE scenes SET text = ?, duration_sec = ? WHERE id = ?`);
      input.scenes.forEach((s, i) => upd.run(cleanText(s.text), s.durationSec, current[i]));
      this.db.prepare(`UPDATE projects SET title = ? WHERE id = ?`).run(cleanTitle(input.title), id);
      this.touch(id);
    });
    tx();
    return this.getProject(id);
  }

  private sceneIds(projectId: string): string[] {
    return (
      this.db.prepare(`SELECT id FROM scenes WHERE project_id = ? ORDER BY position`).all(projectId) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  /** 맨 뒤에 빈 장면을 하나 더한다. 장면 수 상한을 넘으면 거절한다. */
  addScene(projectId: string): Project {
    this.db.transaction(() => {
      this.requireProject(projectId);
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM scenes WHERE project_id = ?`)
        .get(projectId) as { n: number };
      if (row.n >= SCENE_MAX) {
        throw new AppError('SCENE_LIMIT', 422, `장면은 최대 ${SCENE_MAX}개까지 만들 수 있어요.`);
      }
      this.db
        .prepare(`INSERT INTO scenes (id, project_id, position, text, duration_sec) VALUES (?, ?, ?, '', ?)`)
        .run(crypto.randomUUID(), projectId, row.n, DURATION_DEFAULT_SEC);
      this.touch(projectId);
    })();
    return this.getProject(projectId);
  }

  /** 장면을 지우고 뒤 장면의 순서를 당긴다. 마지막 한 장면은 지울 수 없다. 이미지는 어디에서도 쓰지 않을 때만 정리한다. */
  deleteScene(projectId: string, sceneId: string): Project {
    let imageId: string | null = null;
    this.db.transaction(() => {
      this.requireProject(projectId);
      const ids = this.sceneIds(projectId);
      const idx = ids.indexOf(sceneId);
      if (idx < 0) throw notFound('장면');
      if (ids.length <= SCENE_MIN) {
        throw new AppError('SCENE_MIN', 422, `장면은 최소 ${SCENE_MIN}개가 있어야 해요.`);
      }
      imageId = (
        this.db.prepare(`SELECT image_id FROM scenes WHERE id = ?`).get(sceneId) as { image_id: string | null }
      ).image_id;
      this.db.prepare(`DELETE FROM scenes WHERE id = ?`).run(sceneId);
      const upd = this.db.prepare(`UPDATE scenes SET position = ? WHERE id = ?`);
      ids.filter((x) => x !== sceneId).forEach((x, i) => upd.run(i, x));
      this.touch(projectId);
    })();
    if (imageId) this.collectImageIfUnused(imageId);
    return this.getProject(projectId);
  }

  private sceneIdAt(projectId: string, position: number): string {
    const id = this.sceneIds(projectId)[position];
    if (!Number.isInteger(position) || !id) throw notFound('장면');
    return id;
  }

  private requireScene(projectId: string, sceneId: string) {
    if (!this.db.prepare(`SELECT 1 FROM scenes WHERE id = ? AND project_id = ?`).get(sceneId, projectId)) {
      throw notFound('장면');
    }
  }

  /** 변경 시각을 갱신하고 완료/실패였다면 편집 중으로 되돌린다. */
  private touch(id: string) {
    this.db
      .prepare(
        `UPDATE projects
            SET updated_at = ?,
                status = CASE WHEN status IN ('done','failed') THEN 'editing' ELSE status END
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  private requireProject(id: string) {
    const row = this.db.prepare(`SELECT id FROM projects WHERE id = ?`).get(id);
    if (!row) throw notFound();
  }

  hasActiveJob(projectId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM render_jobs WHERE project_id = ? AND status IN ('waiting','generating')`)
      .get(projectId);
  }

  /** 프로젝트와 그 이미지·영상 파일을 지운다. 생성이 진행 중이면 거부한다. */
  deleteProject(id: string) {
    this.requireProject(id);
    if (this.hasActiveJob(id)) {
      throw new AppError(
        'PROJECT_BUSY',
        409,
        '영상을 만드는 중이라 지금은 삭제할 수 없어요. 생성이 끝난 뒤에 다시 시도해 주세요.',
      );
    }
    // DB 를 먼저 지우고 파일을 지운다. 파일 삭제가 실패해도 남는 건 고아 파일뿐이고,
    // 서버가 시작될 때 sweepOrphans 가 정리한다.
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    fs.rmSync(path.join(this.uploadsDir, this.safeSegment(id)), { recursive: true, force: true });
    fs.rmSync(path.join(this.videosDir, this.safeSegment(id)), { recursive: true, force: true });
  }

  // ───────── 이미지 ─────────

  /**
   * 장면에 이미지를 붙인다. 파일을 먼저 임시 이름으로 쓰고 DB 반영이 끝나면 제자리로 옮긴다.
   * 실패하면 이전 이미지는 그대로 남는다. 교체된 이전 이미지는 어떤 장면·렌더 작업도
   * 참조하지 않을 때만 즉시 정리한다.
   */
  attachImage(
    projectId: string,
    scene: string | number,
    buf: Buffer,
    originalName: string | undefined,
    opts: { isSample?: boolean } = {},
  ): Project {
    this.requireProject(projectId);
    // 숫자는 위치(0부터)로 장면을 찾는 내부 호출용(시드·테스트). HTTP 경로는 항상 장면 ID 를 쓴다.
    const sceneId = typeof scene === 'number' ? this.sceneIdAt(projectId, scene) : scene;
    this.requireScene(projectId, sceneId);
    const info = inspectImage(buf);
    const imageId = crypto.randomUUID();
    const storedName = `${imageId}.${info.ext}`;
    const dir = path.join(this.uploadsDir, this.safeSegment(projectId));
    const finalPath = path.join(dir, storedName);
    const tmpPath = `${finalPath}.part`;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, buf, { flag: 'wx' });

    let previousId: string | null = null;
    try {
      fs.renameSync(tmpPath, finalPath);
      const tx = this.db.transaction(() => {
        const prev = this.db
          .prepare(`SELECT image_id FROM scenes WHERE id = ? AND project_id = ?`)
          .get(sceneId, projectId) as { image_id: string | null } | undefined;
        if (!prev) throw notFound('장면'); // 파일을 쓰는 사이 장면이 지워진 경우
        previousId = prev?.image_id ?? null;
        this.db
          .prepare(
            `INSERT INTO images (id, project_id, file_name, stored_name, mime, size_bytes, width, height, is_sample, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            imageId,
            projectId,
            sanitizeDisplayName(originalName),
            storedName,
            info.mime,
            info.sizeBytes,
            info.width,
            info.height,
            opts.isSample ? 1 : 0,
            new Date().toISOString(),
          );
        this.db
          .prepare(`UPDATE scenes SET image_id = ? WHERE id = ? AND project_id = ?`)
          .run(imageId, sceneId, projectId);
        this.touch(projectId);
      });
      tx();
    } catch (e) {
      fs.rmSync(tmpPath, { force: true });
      fs.rmSync(finalPath, { force: true });
      throw e;
    }

    if (previousId) this.collectImageIfUnused(previousId);
    return this.getProject(projectId);
  }

  removeImage(projectId: string, sceneId: string): Project {
    this.requireProject(projectId);
    this.requireScene(projectId, sceneId);
    const prev = this.db
      .prepare(`SELECT image_id FROM scenes WHERE id = ? AND project_id = ?`)
      .get(sceneId, projectId) as { image_id: string | null } | undefined;
    this.db.transaction(() => {
      this.db.prepare(`UPDATE scenes SET image_id = NULL WHERE id = ? AND project_id = ?`).run(sceneId, projectId);
      this.touch(projectId);
    })();
    if (prev?.image_id) this.collectImageIfUnused(prev.image_id);
    return this.getProject(projectId);
  }

  /** 렌더에 쓸 이미지 파일의 실제 경로. 파일이 없으면 렌더가 '이미지를 읽을 수 없어요'로 실패하도록 경로만 돌려준다. */
  imageFileForRender(imageId: string): string {
    const row = this.db
      .prepare(`SELECT project_id, stored_name FROM images WHERE id = ?`)
      .get(imageId) as { project_id: string; stored_name: string } | undefined;
    if (!row) throw notFound('이미지');
    return this.imagePath(row.project_id, row.stored_name);
  }

  getImageFile(imageId: string): { path: string; mime: string } {
    const row = this.db
      .prepare(`SELECT project_id, stored_name, mime FROM images WHERE id = ?`)
      .get(imageId) as { project_id: string; stored_name: string; mime: string } | undefined;
    if (!row) throw notFound('이미지');
    const p = this.imagePath(row.project_id, row.stored_name);
    if (!fs.existsSync(p)) throw notFound('이미지');
    return { path: p, mime: row.mime };
  }

  /** 장면과 렌더 작업 어디에서도 참조하지 않는 이미지만 지운다. */
  collectImageIfUnused(imageId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT i.project_id, i.stored_name,
                EXISTS (SELECT 1 FROM scenes s WHERE s.image_id = i.id) AS in_scene,
                EXISTS (SELECT 1 FROM render_job_images r WHERE r.image_id = i.id) AS in_job
           FROM images i WHERE i.id = ?`,
      )
      .get(imageId) as
      | { project_id: string; stored_name: string; in_scene: number; in_job: number }
      | undefined;
    if (!row || row.in_scene || row.in_job) return false;
    this.db.prepare(`DELETE FROM images WHERE id = ?`).run(imageId);
    // 행은 이미 지웠다. 파일 삭제가 실패(잠금·권한)해도 호출한 요청을 실패시키지 않고, 남은 파일은 시작 시 sweepOrphans 가 지운다.
    safeRm(this.imagePath(row.project_id, row.stored_name));
    return true;
  }

  /**
   * 서버 시작 시 한 번 실행하는 정리.
   *  1) 쓰다 만 임시 파일(.part) 삭제
   *  2) 어떤 장면·렌더 작업도 참조하지 않는 이미지 행과 파일 삭제
   *  3) DB 에 없는 파일 삭제
   * 사용자가 입력한 내용(제목, 문구, 길이)과 장면이 쓰는 이미지는 건드리지 않는다.
   */
  sweepOrphans(): { removedImages: number; removedFiles: number; failedFiles: number } {
    let removedImages = 0;
    let removedFiles = 0;
    let failedFiles = 0;

    const unused = this.db
      .prepare(
        `SELECT id FROM images i
          WHERE NOT EXISTS (SELECT 1 FROM scenes s WHERE s.image_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM render_job_images r WHERE r.image_id = i.id)`,
      )
      .all() as Array<{ id: string }>;
    for (const { id } of unused) if (this.collectImageIfUnused(id)) removedImages++;

    const known = new Set(
      (this.db.prepare(`SELECT project_id, stored_name FROM images`).all() as Array<{
        project_id: string;
        stored_name: string;
      }>).map((r) => `${r.project_id}/${r.stored_name}`),
    );
    if (fs.existsSync(this.uploadsDir)) {
      for (const projectDir of fs.readdirSync(this.uploadsDir)) {
        const full = path.join(this.uploadsDir, projectDir);
        if (!fs.statSync(full).isDirectory()) continue;
        for (const file of fs.readdirSync(full)) {
          if (!known.has(`${projectDir}/${file}`)) {
            // 잠긴 파일 하나 때문에 서버 시작 전체가 실패하지 않게 파일마다 따로 시도하고, 못 지운 것은 다음 시작 때 다시 시도한다.
            if (safeRm(path.join(full, file))) removedFiles++;
            else failedFiles++;
          }
        }
        rmdirIfEmpty(full);
      }
    }
    return { removedImages, removedFiles, failedFiles };
  }
}
