import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

// render_jobs 와 render_job_images 는 2단계(렌더링)에서 쓴다. 1단계에서 미리 만들어 두는 이유:
//  - "프로젝트당 진행 중 작업 1개"를 DB 제약(부분 유니크 인덱스)으로 보장하기 위해
//  - 이미지가 어떤 렌더 작업에 쓰였는지 알아야 이전 이미지를 안전하게 정리할 수 있기 때문에
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'editing'
              CHECK (status IN ('editing','waiting','generating','done','failed')),
  is_sample   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,           -- 화면 표시용 원본 이름(정리한 값). 경로 계산에는 쓰지 않는다.
  stored_name  TEXT NOT NULL,           -- 서버가 만든 안전한 파일명: <id>.<ext>
  mime         TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  is_sample    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- 장면은 고유 ID 로 식별한다(이미지·삭제·저장이 순서 번호에 기대면 중간 장면을 지울 때 엉뚱한 장면에 반영될 수 있다).
-- position 은 표시 순서이며 코드가 트랜잭션 안에서 0..n-1 로 유지한다(유니크 제약을 두면 한 칸씩 당길 때 일시적으로 충돌한다).
CREATE TABLE IF NOT EXISTS scenes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL CHECK (position >= 0),
  text          TEXT NOT NULL DEFAULT '',
  duration_sec  INTEGER NOT NULL CHECK (duration_sec BETWEEN 3 AND 30),
  image_id      TEXT REFERENCES images(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS scenes_by_project ON scenes(project_id, position);

CREATE TABLE IF NOT EXISTS render_jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('waiting','generating','done','failed')),
  snapshot_json  TEXT NOT NULL,         -- 요청 시점의 제목/장면 내용. 이후 편집과 분리된다.
  error_code     TEXT,
  error_title    TEXT,
  error_body     TEXT,
  error_scene    INTEGER,               -- 문제가 된 장면 번호(1부터). 없으면 NULL
  error_detail   TEXT,                  -- 개발자용 상세(ffmpeg 오류 끝부분 등). 화면에는 보여주지 않는다.
  step           INTEGER NOT NULL DEFAULT 1,  -- 0 요청 접수 · 1 대기열 · 2 장면 화면 만들기 · 3 MP4 저장 (활성 단계 번호)
  video_file     TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS render_jobs_one_active_per_project
  ON render_jobs(project_id) WHERE status IN ('waiting','generating');

CREATE TABLE IF NOT EXISTS render_job_images (
  job_id    TEXT NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
  image_id  TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, image_id)
);
`;

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'scene_maker.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 이전 단계에서 만든 DB(렌더 작업 컬럼이 모자란 상태)를 현재 스키마로 올린다. */
function migrate(db: Db) {
  migrateScenes(db);
  const cols = (db.prepare(`PRAGMA table_info(render_jobs)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('step')) db.exec(`ALTER TABLE render_jobs ADD COLUMN step INTEGER NOT NULL DEFAULT 1`);
  if (!cols.includes('error_detail')) db.exec(`ALTER TABLE render_jobs ADD COLUMN error_detail TEXT`);
  if (!cols.includes('error_scene')) db.exec(`ALTER TABLE render_jobs ADD COLUMN error_scene INTEGER`);
}

/**
 * 장면 3개 고정 시절의 scenes 표(PRIMARY KEY (project_id, position), position 0..2 CHECK)를 장면 ID 가 있는 표로 옮긴다.
 * 행 수와 내용(문구, 길이, 이미지 연결, 순서)은 그대로이고 ID 만 새로 붙는다. 한 트랜잭션이라 실패하면 이전 표가 그대로 남는다.
 * scenes 를 참조하는 표는 없으므로 foreign_keys 를 끌 필요가 없다.
 */
function migrateScenes(db: Db) {
  const cols = (db.prepare(`PRAGMA table_info(scenes)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.includes('id')) return;
  const rows = db
    .prepare(`SELECT project_id, position, text, duration_sec, image_id FROM scenes ORDER BY project_id, position`)
    .all() as Array<{ project_id: string; position: number; text: string; duration_sec: number; image_id: string | null }>;
  db.transaction(() => {
    db.exec(`ALTER TABLE scenes RENAME TO scenes_old`);
    db.exec(`DROP INDEX IF EXISTS scenes_by_project`);
    db.exec(`CREATE TABLE scenes (
      id            TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position      INTEGER NOT NULL CHECK (position >= 0),
      text          TEXT NOT NULL DEFAULT '',
      duration_sec  INTEGER NOT NULL CHECK (duration_sec BETWEEN 3 AND 30),
      image_id      TEXT REFERENCES images(id) ON DELETE SET NULL
    )`);
    db.exec(`CREATE INDEX scenes_by_project ON scenes(project_id, position)`);
    const ins = db.prepare(
      `INSERT INTO scenes (id, project_id, position, text, duration_sec, image_id) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) ins.run(crypto.randomUUID(), r.project_id, r.position, r.text, r.duration_sec, r.image_id);
    db.exec(`DROP TABLE scenes_old`);
  })();
}
