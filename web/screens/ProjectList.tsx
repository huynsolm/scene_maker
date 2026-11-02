import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectSummary } from '../../shared/types';
import { api } from '../api';
import { SampleTag, StatusBadge, Modal } from '../components';
import { ACTION, formatUpdated, needsResultScreen } from '../format';
import { navigate } from '../router';
import { useToast } from '../useToast';

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '목록을 불러오지 못했어요.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const create = async () => {
    if (creatingRef.current) return; // 연속 클릭으로 프로젝트가 여러 개 생기지 않게 한다(ref: 같은 틱의 두 번째 클릭도 막음)
    creatingRef.current = true;
    setCreating(true);
    try {
      const p = await api.createProject();
      navigate(`/projects/${p.id}`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '새 프로젝트를 만들지 못했어요');
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await api.deleteProject(deleting.id);
      setDeleting(null);
      toast.show('프로젝트를 삭제했어요');
      await load();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '삭제하지 못했어요');
      setDeleting(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="list-shell" data-screen="list">
      <aside className="list-aside">
        <div className="brand">
          <span className="brand-mark" />
          씬 메이커
        </div>
        <nav className="list-nav">
          <button className="nav-item active">프로젝트</button>
          <button className="nav-item" onClick={create} disabled={creating}>
            새 영상 만들기
          </button>
        </nav>
      </aside>
      <main className="list-main">
        <div className="list-inner">
          <div className="list-head">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h1 style={{ fontSize: 24, fontWeight: 700 }}>프로젝트</h1>
              <p style={{ color: 'var(--text-3)' }}>만든 영상을 확인하거나 이어서 편집하세요.</p>
            </div>
            <button className="btn btn-primary" onClick={create} disabled={creating}>
              + 새 영상 만들기
            </button>
          </div>

          {loadError && (
            <div className="note-err" role="alert" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' }}>
              <span>{loadError}</span>
              <button className="btn btn-secondary btn-sm" onClick={load}>
                다시 불러오기
              </button>
            </div>
          )}

          {projects === null && !loadError && <p style={{ color: 'var(--muted)' }}>불러오는 중…</p>}

          {projects && projects.length > 0 && (
            <div className="table" role="table" aria-label="프로젝트 목록">
              <div className="row row-head" role="row">
                <span>제목</span>
                <span className="wide-only">구성</span>
                <span className="wide-only">수정일</span>
                <span>상태</span>
                <span className="wide-only" />
              </div>
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="row"
                  role="row"
                  onClick={() => navigate(needsResultScreen(p.status) ? `/projects/${p.id}/result` : `/projects/${p.id}`)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                    <div className="thumb">{p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" />}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                        <span className="row-title">{p.title.trim() || '제목 없는 영상'}</span>
                        {p.isSample && <SampleTag />}
                      </span>
                      <span className="narrow-only" style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {formatUpdated(p.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <span className="wide-only" style={{ color: 'var(--text-2)' }}>
                    장면 3개 · {p.totalSec}초
                  </span>
                  <span className="wide-only" style={{ color: 'var(--text-2)' }}>
                    {formatUpdated(p.updatedAt)}
                  </span>
                  <StatusBadge status={p.status} />
                  <span className="row-action" onClick={(e) => e.stopPropagation()}>
                    <span className="link-action wide-only" onClick={() => navigate(needsResultScreen(p.status) ? `/projects/${p.id}/result` : `/projects/${p.id}`)}>
                      {ACTION[p.status]} →
                    </span>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--err-fg)' }} onClick={() => setDeleting(p)} aria-label={`${p.title || '제목 없는 영상'} 삭제`}>
                      삭제
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {projects && projects.length === 0 && (
            <div className="empty-card">
              <div className="empty-icon" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h2 style={{ fontSize: 20, fontWeight: 700 }}>아직 만든 영상이 없어요</h2>
                <p style={{ color: 'var(--text-3)', maxWidth: 400, textWrap: 'pretty' }}>
                  제목과 장면 3개만 채우면 30초짜리 안내 영상을 만들 수 있어요.
                </p>
              </div>
              <div className="step-chips">
                <span>1 장면 입력</span>
                <span>2 미리보기</span>
                <span>3 영상 만들기</span>
                <span>4 MP4 다운로드</span>
              </div>
              <button className="btn btn-primary btn-lg" onClick={create} disabled={creating}>
                첫 영상 만들기
              </button>
            </div>
          )}
        </div>
      </main>

      {deleting && (
        <Modal labelledBy="delete-title" onClose={() => !deleteBusy && setDeleting(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h2 id="delete-title" style={{ fontSize: 20, fontWeight: 700 }}>
              ‘{deleting.title.trim() || '제목 없는 영상'}’을 삭제할까요?
            </h2>
            <p style={{ color: 'var(--text-2)', textWrap: 'pretty' }}>
              삭제하면 올려 둔 이미지와 만든 영상 파일도 함께 지워지고, 되돌릴 수 없어요.
            </p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" data-autofocus onClick={() => setDeleting(null)} disabled={deleteBusy}>
              취소
            </button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleteBusy}>
              {deleteBusy ? '삭제하는 중…' : '삭제'}
            </button>
          </div>
        </Modal>
      )}
      {toast.node}
    </div>
  );
}
