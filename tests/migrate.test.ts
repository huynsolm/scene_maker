import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db';

describe('DB 마이그레이션', () => {
  it('1단계에서 만든 DB(렌더 작업 컬럼 없음)를 열면 step·error_detail 컬럼이 추가되고 기존 데이터는 그대로다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-migrate-'));
    const old = new Database(path.join(dir, 'scene_maker.db'));
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'editing',
        is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE render_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        error_code TEXT, error_title TEXT, error_body TEXT, video_file TEXT, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p1', '기존 프로젝트', 'now', 'now');
      INSERT INTO render_jobs (id, project_id, status, snapshot_json, created_at) VALUES ('j1', 'p1', 'done', '{}', 'now');
    `);
    old.close();

    const db = openDb(dir);
    const cols = (db.prepare(`PRAGMA table_info(render_jobs)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('step');
    expect(cols).toContain('error_detail');
    expect(cols).toContain('error_scene');
    expect((db.prepare(`SELECT title FROM projects WHERE id = 'p1'`).get() as { title: string }).title).toBe('기존 프로젝트');
    expect((db.prepare(`SELECT step FROM render_jobs WHERE id = 'j1'`).get() as { step: number }).step).toBe(1);
    db.close();
    // 두 번 열어도 안전하다
    openDb(dir).close();
  });

  it('장면 3개 고정 시절의 scenes 표를 ID 가 있는 표로 옮기고 내용·순서·이미지 연결을 보존한다', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-migrate-scenes-'));
    const old = new Database(path.join(dir, 'scene_maker.db'));
    old.pragma('foreign_keys = ON');
    old.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'editing',
        is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE images (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, is_sample INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE scenes (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2), text TEXT NOT NULL DEFAULT '',
        duration_sec INTEGER NOT NULL CHECK (duration_sec BETWEEN 3 AND 30),
        image_id TEXT REFERENCES images(id) ON DELETE SET NULL, PRIMARY KEY (project_id, position));
      INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p1', 'A', 'n', 'n'), ('p2', 'B', 'n', 'n');
      INSERT INTO images VALUES ('i1', 'p1', 'a.png', 'i1.png', 'image/png', 1, 2, 2, 0, 'n');
      INSERT INTO scenes VALUES ('p1', 0, '첫째', 5, 'i1'), ('p1', 1, '둘째', 6, NULL), ('p1', 2, '셋째', 7, NULL),
                                ('p2', 0, 'x', 3, NULL), ('p2', 1, 'y', 4, NULL), ('p2', 2, 'z', 5, NULL);
    `);
    old.close();

    const db = openDb(dir);
    type Row = { id: string; project_id: string; position: number; text: string; duration_sec: number; image_id: string | null };
    const rows = db.prepare(`SELECT * FROM scenes ORDER BY project_id, position`).all() as Row[];
    expect(rows.map((r) => [r.project_id, r.position, r.text, r.duration_sec, r.image_id])).toEqual([
      ['p1', 0, '첫째', 5, 'i1'], ['p1', 1, '둘째', 6, null], ['p1', 2, '셋째', 7, null],
      ['p2', 0, 'x', 3, null], ['p2', 1, 'y', 4, null], ['p2', 2, 'z', 5, null],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(6);
    expect(rows.every((r) => /^[0-9a-f-]{36}$/.test(r.id))).toBe(true);
    // 이전 표와 임시 이름이 남지 않고, 위치 4 이상의 장면도 넣을 수 있다(CHECK 제약이 풀렸다)
    expect((db.prepare(`SELECT name FROM sqlite_master WHERE name = 'scenes_old'`).all() as unknown[]).length).toBe(0);
    db.prepare(`INSERT INTO scenes (id, project_id, position, duration_sec) VALUES ('s-new', 'p1', 9, 3)`).run();
    // 프로젝트를 지우면 장면도 함께 지워진다(CASCADE 유지)
    db.prepare(`DELETE FROM projects WHERE id = 'p2'`).run();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM scenes WHERE project_id = 'p2'`).get() as { n: number }).n).toBe(0);
    db.close();
    // 두 번 열어도 ID 가 바뀌지 않는다
    const again = openDb(dir);
    expect((again.prepare(`SELECT COUNT(*) AS n FROM scenes WHERE id IN (${rows.filter((r) => r.project_id === 'p1').map((r) => `'${r.id}'`).join(',')})`).get() as { n: number }).n).toBe(3);
    again.close();
  });
});
