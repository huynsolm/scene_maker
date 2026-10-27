import { Link } from '../router';

/** 임시 화면. 생성 결과 화면(상태 표시, 재생, 다운로드, 실패 복구)은 2~3단계에서 구현한다. */
export function ResultPlaceholder({ projectId }: { projectId: string }) {
  return (
    <div className="center-msg" data-screen="result-placeholder">
      <span className="temp-note">임시 화면</span>
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>생성 결과 화면은 다음 단계에서 만들어요</h2>
      <p style={{ color: 'var(--text-2)' }}>영상 생성 기능이 연결되면 이곳에서 진행 상황과 완성된 영상을 볼 수 있어요.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Link to={`/projects/${projectId}`} className="btn btn-primary">
          편집 화면으로 돌아가기
        </Link>
        <Link to="/" className="btn btn-secondary">
          프로젝트 목록
        </Link>
      </div>
    </div>
  );
}
