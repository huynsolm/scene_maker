import Database from 'better-sqlite3';
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

CREATE TABLE IF NOT EXISTS scenes (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
  text          TEXT NOT NULL DEFAULT '',
  duration_sec  INTEGER NOT NULL CHECK (duration_sec BETWEEN 3 AND 30),
  image_id      TEXT REFERENCES images(id) ON DELETE SET NULL,
  PRIMARY KEY (project_id, position)
);

CREATE TABLE IF NOT EXISTS render_jobs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('waiting','generating','done','failed')),
  snapshot_json  TEXT NOT NULL,         -- 요청 시점의 제목/장면 내용. 이후 편집과 분리된다.
  error_code     TEXT,
  error_title    TEXT,
  error_body     TEXT,
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
  return db;
}
