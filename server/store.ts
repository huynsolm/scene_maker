import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DURATION_DEFAULT_SEC,
  SCENE_COUNT,
} from '../shared/limits';
import type { SaveProjectInput } from '../shared/schemas';
import type { Project, ProjectStatus, ProjectSummary, Scene } from '../shared/types';
import type { Db } from './db';
import { AppError, notFound } from './errors';
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
  position: number;
  text: string;
  duration_sec: number;
  image_id: string | null;
  file_name: string | null;
  width: number | null;
  height: number | null;
  img_is_sample: number | null;
}

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
      thumb_id: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updated_at,
      totalSec: r.total_sec,
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
        .run(id, opts.title ?? '', opts.isSample ? 1 : 0, now, now);
      const ins = this.db.prepare(
        `INSERT INTO scenes (project_id, position, text, duration_sec) VALUES (?, ?, '', ?)`,
      );
      for (let i = 0; i < SCENE_COUNT; i++) ins.run(id, i, DURATION_DEFAULT_SEC);
    });
    tx();
    return this.getProject(id);
  }

  getProject(id: string): Project {
    const p = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
    if (!p) throw notFound();
    const rows = this.db
      .prepare(
        `SELECT s.position, s.text, s.duration_sec, s.image_id,
                i.file_name, i.width, i.height, i.is_sample AS img_is_sample
           FROM scenes s LEFT JOIN images i ON i.id = s.image_id
          WHERE s.project_id = ? ORDER BY s.position`,
      )
      .all(id) as SceneRow[];
    const scenes: Scene[] = rows.map((r) => ({
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
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      scenes,
      isSample: p.is_sample === 1,
    };
  }

  /**
   * 제목과 장면 내용을 저장한다. 완료/실패 상태의 프로젝트를 고치면 '편집 중'으로 돌아간다.
   * 대기/생성 중에는 상태를 건드리지 않는다. 진행 중인 작업은 요청 시점 스냅샷을 쓰므로
   * 지금 저장하는 내용은 다음 생성부터 반영된다.
   */
  saveProject(id: string, input: SaveProjectInput): Project {
    const tx = this.db.transaction(() => {
      this.requireProject(id);
      const upd = this.db.prepare(
        `UPDATE scenes SET text = ?, duration_sec = ? WHERE project_id = ? AND position = ?`,
      );
      input.scenes.forEach((s, i) => upd.run(s.text, s.durationSec, id, i));
      this.db.prepare(`UPDATE projects SET title = ? WHERE id = ?`).run(input.title, id);
      this.touch(id);
    });
    tx();
    return this.getProject(id);
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
    position: number,
    buf: Buffer,
    originalName: string | undefined,
    opts: { isSample?: boolean } = {},
  ): Project {
    this.requireProject(projectId);
    if (!Number.isInteger(position) || position < 0 || position >= SCENE_COUNT) {
      throw new AppError('INVALID_INPUT', 400, '장면 번호가 올바르지 않아요.');
    }
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
          .prepare(`SELECT image_id FROM scenes WHERE project_id = ? AND position = ?`)
          .get(projectId, position) as { image_id: string | null } | undefined;
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
          .prepare(`UPDATE scenes SET image_id = ? WHERE project_id = ? AND position = ?`)
          .run(imageId, projectId, position);
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

  removeImage(projectId: string, position: number): Project {
    this.requireProject(projectId);
    if (!Number.isInteger(position) || position < 0 || position >= SCENE_COUNT) {
      throw new AppError('INVALID_INPUT', 400, '장면 번호가 올바르지 않아요.');
    }
    const prev = this.db
      .prepare(`SELECT image_id FROM scenes WHERE project_id = ? AND position = ?`)
      .get(projectId, position) as { image_id: string | null } | undefined;
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE scenes SET image_id = NULL WHERE project_id = ? AND position = ?`)
        .run(projectId, position);
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
    fs.rmSync(this.imagePath(row.project_id, row.stored_name), { force: true });
    return true;
  }

  /**
   * 서버 시작 시 한 번 실행하는 정리.
   *  1) 쓰다 만 임시 파일(.part) 삭제
   *  2) 어떤 장면·렌더 작업도 참조하지 않는 이미지 행과 파일 삭제
   *  3) DB 에 없는 파일 삭제
   * 사용자가 입력한 내용(제목, 문구, 길이)과 장면이 쓰는 이미지는 건드리지 않는다.
   */
  sweepOrphans(): { removedImages: number; removedFiles: number } {
    let removedImages = 0;
    let removedFiles = 0;

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
            fs.rmSync(path.join(full, file), { force: true });
            removedFiles++;
          }
        }
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      }
    }
    return { removedImages, removedFiles };
  }
}
