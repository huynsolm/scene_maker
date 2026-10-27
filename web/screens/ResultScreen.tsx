import { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderJobView } from '../../shared/types';
import { ApiFailure, api } from '../api';
import { CenterMessage, StatusBadge } from '../components';
import { formatUpdated, mmss } from '../format';
import { Link } from '../router';
import { useToast } from '../useToast';

const STEPS = ['요청 접수', '대기열에서 순서 기다리기', '장면 화면 만들기', 'MP4 파일로 저장'];
const POLL_MS = 1500;

/**
 * 생성 결과 화면(2단계 임시판).
 * 상태 조회·재생·다운로드·실패 이유·재시도 동작은 연결되어 있지만, 디자인 적용(3단계)은 아직이다.
 */
export function ResultScreen({ projectId }: { projectId: string }) {
  const [job, setJob] = useState<RenderJobView | null | undefined>(undefined); // undefined = 불러오는 중
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      setJob(await api.latestRender(projectId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '상태를 불러오지 못했어요.');
    }
  }, [projectId]);
  useEffect(() => void load(), [load]);

  const active = job?.status === 'waiting' || job?.status === 'generating';
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const retry = async () => {
    if (retryingRef.current) return; // 같은 틱의 연속 클릭도 막는다(서버도 진행 중이면 409)
    retryingRef.current = true;
    setRetrying(true);
    try {
      setJob(await api.createRender(projectId));
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'RENDER_IN_PROGRESS') setJob(e.details.job as RenderJobView);
      else toast.show(e instanceof Error ? e.message : '다시 시도하지 못했어요');
    } finally {
      retryingRef.current = false;
      setRetrying(false);
    }
  };

  if (job === undefined && !loadError) return <CenterMessage title="불러오는 중…" />;
  if (job === undefined)
    return (
      <CenterMessage title="상태를 불러오지 못했어요" body={loadError ?? ''}>
        <button className="btn btn-primary" onClick={() => void load()}>
          다시 불러오기
        </button>
      </CenterMessage>
    );
  if (job === null)
    return (
      <CenterMessage title="아직 만든 영상이 없어요" body="편집 화면에서 영상 만들기를 눌러 주세요.">
        <Link to={`/projects/${projectId}`} className="btn btn-primary">
          편집 화면으로 돌아가기
        </Link>
      </CenterMessage>
    );

  return (
    <div data-screen="result" data-status={job.status}>
      <header className="topbar" style={{ position: 'static' }}>
        <Link to="/" className="btn btn-ghost" style={{ height: 36, padding: '0 10px' }}>
          ← 프로젝트
        </Link>
        <div className="topbar-sep" />
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>{job.snapshot.title || '제목 없는 영상'}</span>
        <StatusBadge status={job.status} />
        <div style={{ flex: 1 }} />
        <Link to={`/projects/${projectId}`} className="btn btn-secondary" style={{ height: 38, padding: '0 14px' }}>
          편집 화면으로 돌아가기
        </Link>
      </header>

      <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <span className="temp-note" style={{ alignSelf: 'flex-start' }}>
          임시 화면 · 결과 화면 디자인은 3단계에서 적용해요
        </span>

        {active && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }} aria-live="polite">
            <h2 style={{ fontSize: 20, fontWeight: 700 }}>{job.status === 'waiting' ? '생성 대기 중이에요' : '영상을 만들고 있어요'}</h2>
            <ol style={{ margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="steps">
              {STEPS.map((label, i) => (
                <li key={label} style={{ fontWeight: i === job.step ? 700 : 400, color: i < job.step ? 'var(--ok-fg)' : i === job.step ? 'var(--primary-text)' : 'var(--faint)' }}>
                  {label}
                  {i < job.step ? ' · 완료' : i === job.step ? ' · 진행 중' : ''}
                </li>
              ))}
            </ol>
            <p className="info-box">남은 시간은 영상마다 달라서 따로 표시하지 않아요. 이 화면을 닫아도 생성은 계속되고, 프로젝트 목록에서 상태를 확인할 수 있어요.</p>
            <button className="btn btn-primary" disabled>
              영상 만들기 요청됨
            </button>
          </section>
        )}

        {job.status === 'done' && job.videoUrl && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700 }}>영상이 완성됐어요</h2>
            {/* 자막 안전 영역 같은 편집용 안내선은 여기에 그리지 않는다(영상 자체에는 나오지 않는 UI) */}
            <video data-testid="player" src={job.videoUrl} controls preload="metadata" style={{ width: '100%', aspectRatio: '16 / 9', background: 'var(--frame)' }} />
            <dl className="summary" style={{ margin: 0 }}>
              <dt>파일 형식</dt>
              <dd>MP4</dd>
              <dt>화면 크기</dt>
              <dd>
                {job.output?.width} × {job.output?.height} (가로형)
              </dd>
              <dt>길이</dt>
              <dd>
                {job.snapshot.totalSec}초 ({mmss(job.snapshot.totalSec)})
              </dd>
              <dt>소리</dt>
              <dd>없음</dd>
              <dt>완성 시각</dt>
              <dd>{job.finishedAt ? formatUpdated(job.finishedAt) : '—'}</dd>
            </dl>
            <a className="btn btn-primary btn-lg" href={job.downloadUrl ?? undefined} download style={{ height: 48 }}>
              MP4 다운로드
            </a>
          </section>
        )}

        {job.status === 'failed' && job.error && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <h2 style={{ fontSize: 20, fontWeight: 700 }}>영상을 만들지 못했어요</h2>
            <p style={{ color: 'var(--text-2)' }}>입력한 내용은 그대로 저장되어 있어요.</p>
            <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 14, border: '1px solid var(--err-border)', background: 'var(--err-box)', borderRadius: 10 }}>
              <strong style={{ color: 'var(--err-fg)' }}>{job.error.title}</strong>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{job.error.body}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                오류 코드 {job.error.code} · {formatUpdated(job.error.at)}
              </span>
            </div>
            <button className="btn btn-primary btn-lg" style={{ height: 48 }} onClick={() => void retry()} disabled={retrying}>
              {retrying ? '요청하는 중…' : '다시 시도'}
            </button>
          </section>
        )}

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700 }}>구성 장면 (요청한 시점의 내용)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {job.snapshot.scenes.map((s) => (
              <div key={s.position} style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <strong>장면 {s.position + 1}</strong>
                  <span className="mono" style={{ color: 'var(--text-3)' }}>
                    {s.durationSec}초
                  </span>
                </div>
                <span className="clamp2" style={{ fontSize: 13 }}>
                  {s.text}
                </span>
              </div>
            ))}
          </div>
        </section>
      </main>
      {toast.node}
    </div>
  );
}
