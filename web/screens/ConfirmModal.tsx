import { VIDEO } from '../../shared/limits';
import { Modal } from '../components';
import type { MissingReport } from '../rules';

interface Props {
  title: string;
  totalSec: number;
  durations: number[];
  missing: MissingReport;
  onClose: () => void;
  onFix: (sceneIndex: number) => void;
  onFixTitle: () => void;
  onStart: () => void;
  starting: boolean;
}

/** 영상 만들기 전 확인. 빠진 항목이 있으면 시작할 수 없다(서버도 같은 검사를 한다). */
export function ConfirmModal({ title, totalSec, durations, missing, onClose, onFix, onFixTitle, onStart, starting }: Props) {
  const hasMissing = missing.count > 0;
  return (
    <Modal labelledBy="confirm-title" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 id="confirm-title" style={{ fontSize: 20, fontWeight: 700 }}>
          {hasMissing ? '아직 채우지 않은 항목이 있어요' : '이 내용으로 영상을 만들까요?'}
        </h2>
        <p style={{ color: 'var(--text-2)' }}>
          {hasMissing ? '빠진 항목을 채우면 바로 영상을 만들 수 있어요.' : '장면 3개가 순서대로 이어지는 MP4 영상을 만들어요.'}
        </p>
      </div>

      <dl className="summary" style={{ margin: 0 }}>
        <dt>제목</dt>
        <dd style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {missing.titleMissing ? (
            <>
              <span style={{ color: 'var(--err-fg)', fontWeight: 600 }}>제목이 비어 있어요</span>
              <button className="btn btn-secondary btn-sm" onClick={onFixTitle}>
                채우기
              </button>
            </>
          ) : (
            <span style={{ fontWeight: 600 }}>{title}</span>
          )}
        </dd>
        <dt>전체 길이</dt>
        <dd style={{ fontWeight: 600 }}>{totalSec}초</dd>
        <dt>출력 형식</dt>
        <dd>
          MP4 · {VIDEO.width} × {VIDEO.height} · 소리 없음
        </dd>
      </dl>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {missing.scenes.map((s, i) => {
          const parts = [s.textMissing && '문구', s.imageMissing && '이미지'].filter(Boolean) as string[];
          const bad = parts.length > 0;
          return (
            <div className="check-row" key={i}>
              <span className="check-icon" style={{ background: bad ? 'var(--err-bg)' : 'var(--ok-bg)', color: bad ? 'var(--err-fg)' : 'var(--ok-fg)' }}>
                {bad ? '!' : '✓'}
              </span>
              <span style={{ fontWeight: 600 }}>장면 {i + 1}</span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>{durations[i]}초</span>
              <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 500, color: bad ? 'var(--err-fg)' : 'var(--ok-fg)' }}>
                {bad ? `${parts.join('·')} 없음` : '준비됐어요'}
              </span>
              {bad && (
                <button className="btn btn-secondary btn-sm" onClick={() => onFix(i)}>
                  채우기
                </button>
              )}
            </div>
          );
        })}
      </div>

      {hasMissing ? (
        <div className="note-err">빠진 항목이 {missing.count}개 있어요. 모두 채워야 영상을 만들 수 있어요.</div>
      ) : (
        <div className="info-box">시작하면 생성 진행 화면으로 이동해요. 화면을 닫아도 생성은 계속돼요.</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn-secondary" data-autofocus onClick={onClose} disabled={starting}>
          {hasMissing ? '닫기' : '취소'}
        </button>
        <button className="btn btn-primary" disabled={hasMissing || starting} onClick={onStart}>
          {starting ? '요청하는 중…' : '영상 만들기 시작'}
        </button>
      </div>
    </Modal>
  );
}
