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
});
