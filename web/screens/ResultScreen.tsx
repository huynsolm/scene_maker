import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, RenderJobView } from '../../shared/types';
import { ApiFailure, api } from '../api';
import { CenterMessage, StatusBadge } from '../components';
import { formatUpdated, mmss } from '../format';
import { Link } from '../router';
import { useToast } from '../useToast';

const STEPS = ['요청 접수', '대기열에서 순서 기다리기', '장면 화면 만들기', 'MP4 파일로 저장'];
const POLL_MS = 1500;

interface Props {
  projectId: string;
  /** 지정하면 그 작업(예: 마지막 완성 영상)을, 없으면 가장 최근 작업을 보여준다 */
  jobId?: string;
}

export function ResultScreen({ projectId, jobId }: Props) {
  const [job, setJob] = useState<RenderJobView | null | undefined>(undefined); // undefined = 불러오는 중
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryingRef = useRef(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const j = jobId ? await api.getRender(jobId) : await api.latestRender(projectId);
      setJob(j);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '상태를 불러오지 못했어요.');
    }
  }, [projectId, jobId]);
  useEffect(() => void load(), [load]);

  const active = job?.status === 'waiting' || job?.status === 'generating';
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  // 직전 완성 영상 정보(실패·진행 화면에서 "마지막 생성 영상 보기"를 보여주기 위해). 작업 상태가 바뀔 때 다시 읽는다.
  useEffect(() => {
    let alive = true;
    api
      .getProject(projectId)
      .then((p) => alive && setProject(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [projectId, job?.status, job?.id]);

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

  const title = job.snapshot.title.trim() || '제목 없는 영상';
  // 지금 보는 작업이 아닌, 직전에 완성된 영상(있고, 지금 화면이 그 영상이 아닐 때만 안내)
  const lastVideoId = project?.lastVideo?.jobId;
  const showLastLink = !!lastVideoId && lastVideoId !== job.id;

  return (
    <div data-screen="result" data-status={job.status}>
      <header className="topbar" style={{ position: 'static' }}>
        <Link to="/" className="btn btn-ghost" style={{ height: 36, padding: '0 10px' }}>
          ← 프로젝트
        </Link>
        <div className="topbar-sep" />
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</span>
        <StatusBadge status={job.status} />
        <div style={{ flex: 1 }} />
        <Link to={`/projects/${projectId}`} className="btn btn-secondary" style={{ height: 38, padding: '0 14px' }}>
          편집 화면으로 돌아가기
        </Link>
      </header>

      <div className="result-body">
        <div className="result-inner">
          <div className="result-main">
            <div className="media-card">
              {job.status === 'done' && job.videoUrl ? (
                <Player job={job} />
              ) : (
                <div className="player-frame">
                  <StageMessage job={job} />
                </div>
              )}
            </div>
            <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h3 style={{ fontSize: 14, fontWeight: 700 }}>구성 장면</h3>
              <div className="scene-summary">
                {job.snapshot.scenes.map((s) => (
                  <div key={s.position}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                      <strong>장면 {s.position + 1}</strong>
                      <span className="mono" style={{ color: 'var(--text-3)' }}>
                        {s.durationSec}초
                      </span>
                    </div>
                    <span className="clamp2" style={{ fontSize: 13, color: '#2f3239' }}>
                      {s.text}
                    </span>
                  </div>
                ))}
              </div>
              <span className="help">요청했을 때의 내용이에요. 그 뒤에 편집 화면에서 고친 내용은 들어 있지 않아요.</span>
            </section>
          </div>

          <aside className="panel" aria-live="polite">
            {active && <BusyPanel job={job} lastLink={showLastLink ? `/projects/${projectId}/result/${lastVideoId}` : null} />}
            {job.status === 'done' && <DonePanel job={job} projectId={projectId} onDownload={() => toast.show(`‘${title}.mp4’ 다운로드를 시작했어요`)} />}
            {job.status === 'failed' && (
              <FailedPanel job={job} projectId={projectId} retrying={retrying} onRetry={() => void retry()} lastLink={showLastLink ? `/projects/${projectId}/result/${lastVideoId}` : null} />
            )}
          </aside>
        </div>
      </div>
      {toast.node}
    </div>
  );
}

/** 완료 전(대기·생성 중·실패)의 플레이어 자리 */
function StageMessage({ job }: { job: RenderJobView }) {
  const failed = job.status === 'failed';
  const msg = job.status === 'waiting' ? '순서를 기다리고 있어요' : job.status === 'generating' ? '영상을 만드는 중이에요' : '영상을 만들지 못했어요';
  return (
    <div className="stage-msg">
      {failed ? <span className="stage-bang">!</span> : <span className={`stage-spin${job.status === 'generating' ? ' on' : ''}`} />}
      <span className="msg">{msg}</span>
    </div>
  );
}

/**
 * 완성 영상 플레이어. 자막 안전 영역 같은 편집용 안내선은 영상 자체에 없으므로 여기에는 그리지 않는다.
 * 진행 막대는 장면 길이 비율로 나뉘어 있고, 누르면 그 장면의 처음으로 이동한다.
 */
function Player({ job }: { job: RenderJobView }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const total = job.snapshot.totalSec;

  // 재생 중에는 매 프레임 시간을 읽어 진행 막대가 끊기지 않게 한다
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (ref.current) setT(ref.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused || v.ended) {
      if (v.ended || v.currentTime >= total - 0.05) v.currentTime = 0;
      void v.play();
    } else v.pause();
  };
  const seek = (sec: number) => {
    if (!ref.current) return;
    ref.current.currentTime = sec;
    setT(sec);
  };

  let start = 0;
  const segs = job.snapshot.scenes.map((s) => {
    const from = start;
    start += s.durationSec;
    return { n: s.position + 1, dur: s.durationSec, from, fill: Math.max(0, Math.min(1, (t - from) / s.durationSec)) };
  });

  return (
    <>
      <div className="player-frame">
        <video
          ref={ref}
          data-testid="player"
          src={job.videoUrl ?? undefined}
          preload="metadata"
          playsInline
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => {
            setPlaying(false);
            if (ref.current) setT(ref.current.currentTime);
          }}
          onEnded={() => {
            setPlaying(false);
            setT(total);
          }}
          onSeeked={() => ref.current && setT(ref.current.currentTime)}
        />
      </div>
      <div className="player-controls">
        <button className="play-btn" aria-label={playing ? '일시정지' : '재생'} onClick={toggle}>
          {playing ? '❚❚' : '▶'}
        </button>
        <div className="seg-bar">
          {segs.map((s) => (
            <button key={s.n} className="seg" style={{ flex: `${s.dur} 1 0` }} aria-label={`장면 ${s.n}부터 보기`} onClick={() => seek(s.from)}>
              <span>
                <i style={{ width: `${s.fill * 100}%` }} />
              </span>
            </button>
          ))}
        </div>
        <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }} data-testid="player-time">
          {mmss(t)} / {mmss(total)}
        </span>
      </div>
    </>
  );
}

function BusyPanel({ job, lastLink }: { job: RenderJobView; lastLink: string | null }) {
  const waiting = job.status === 'waiting';
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <h2>{waiting ? '생성 대기 중이에요' : '영상을 만들고 있어요'}</h2>
        <p className="lead">
          {waiting ? '요청이 접수됐어요. 앞선 작업이 끝나면 자동으로 시작돼요.' : '지금 진행 중인 단계를 아래에서 확인할 수 있어요. 완성되면 이 화면에서 바로 재생할 수 있어요.'}
        </p>
      </div>
      {/* 진행률을 알 수 없으므로 막대는 움직이기만 한다. 남은 시간이나 퍼센트는 만들어 내지 않는다. */}
      <div className="indet" role="progressbar" aria-label="진행 중" />
      <ol className="steps" data-testid="steps">
        {STEPS.map((label, i) => {
          const state = i < job.step ? 'done' : i === job.step ? 'active' : 'pending';
          return (
            <li key={label} className="step" data-state={state} style={{ color: state === 'pending' ? 'var(--faint)' : state === 'active' ? 'var(--primary-text)' : '#2f3239', fontWeight: state === 'active' ? 600 : 400 }}>
              <span className={`step-icon ${state}`}>{state === 'done' ? '✓' : ''}</span>
              {label}
              <span className="tag">{state === 'done' ? '완료' : state === 'active' ? '진행 중' : ''}</span>
            </li>
          );
        })}
      </ol>
      <p className="info-box">남은 시간은 영상마다 달라서 따로 표시하지 않아요. 이 화면을 닫아도 생성은 계속되고, 프로젝트 목록에서 상태를 확인할 수 있어요.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn btn-block" style={{ height: 44 }} disabled>
          영상 만들기 요청됨
        </button>
        <span className="small" style={{ textAlign: 'center' }}>
          이미 생성을 요청했어요. 끝난 뒤에 다시 요청할 수 있어요.
        </span>
      </div>
      {lastLink && (
        <Link to={lastLink} className="btn btn-secondary btn-block">
          마지막 생성 영상 보기
        </Link>
      )}
    </>
  );
}

function DonePanel({ job, projectId, onDownload }: { job: RenderJobView; projectId: string; onDownload: () => void }) {
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="pill" style={{ background: 'var(--ok-bg)', color: 'var(--ok-fg)' }}>
          ✓ 생성 완료
        </span>
        <h2>영상이 완성됐어요</h2>
        <p className="lead">왼쪽에서 재생해 보고, 괜찮으면 내려받으세요.</p>
      </div>
      {job.outdated && (
        <div className="note-warn" role="note" data-testid="outdated-note">
          이 영상을 만든 뒤에 내용을 고쳤어요. 지금 보는 영상에는 고친 내용이 들어 있지 않아요. 새로 반영하려면 편집 화면에서 다시 만들어 주세요.
        </div>
      )}
      <dl className="info-grid">
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
      <a className="btn btn-primary btn-xl" href={job.downloadUrl ?? undefined} download onClick={onDownload}>
        MP4 다운로드
      </a>
      <Link to={`/projects/${projectId}`} className="btn btn-secondary" style={{ height: 42 }}>
        수정하러 편집 화면으로
      </Link>
      <span className="small">고치고 싶은 부분이 있으면 편집 화면에서 수정한 뒤 다시 만들면 돼요.</span>
    </>
  );
}

function FailedPanel({ job, projectId, retrying, onRetry, lastLink }: { job: RenderJobView; projectId: string; retrying: boolean; onRetry: () => void; lastLink: string | null }) {
  const err = job.error!;
  const sceneNo = err.scene;
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="pill" style={{ background: 'var(--err-bg)', color: 'var(--err-fg)' }}>
          ! 생성 실패
        </span>
        <h2>영상을 만들지 못했어요</h2>
        <p className="lead">입력한 내용은 그대로 저장되어 있어요.</p>
      </div>
      <div className="err-box" role="alert">
        <strong style={{ color: 'var(--err-fg)', fontSize: 14 }}>{err.title}</strong>
        <span style={{ fontSize: 13, color: 'var(--text-2)', textWrap: 'pretty' }}>{err.body}</span>
        <span className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          오류 코드 {err.code} · {formatUpdated(err.at)}
        </span>
      </div>
      <button className="btn btn-primary btn-xl" onClick={onRetry} disabled={retrying}>
        {retrying ? '요청하는 중…' : '다시 시도'}
      </button>
      <Link to={sceneNo ? `/projects/${projectId}?scene=${sceneNo}` : `/projects/${projectId}`} className="btn btn-secondary" style={{ height: 42 }}>
        {sceneNo ? `장면 ${sceneNo} 편집에서 확인하기` : '편집 화면에서 확인하기'}
      </Link>
      <span className="small">다시 시도해도 같은 오류가 나면 해당 장면의 이미지를 다른 파일로 바꿔 보세요.</span>
      {lastLink && (
        <Link to={lastLink} className="btn btn-ghost btn-block" style={{ color: 'var(--primary-text)' }}>
          마지막 생성 영상 보기
        </Link>
      )}
    </>
  );
}
