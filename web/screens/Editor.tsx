import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  DEFAULT_TOTAL_SEC,
  DURATION_MAX_SEC,
  DURATION_MIN_SEC,
  DURATION_QUICK_PICKS,
  IMAGE_ACCEPT,
  IMAGE_LABEL,
  SCENE_COUNT,
  SUBTITLE,
  TEXT_RECOMMENDED_LENGTH,
  VIDEO,
} from '../../shared/limits';
import { cleanText } from '../../shared/text';
import type { Project } from '../../shared/types';
import { ApiFailure, api } from '../api';
import { CenterMessage, SampleTag } from '../components';
import { isBusy, mmss } from '../format';
import { Link, navigate } from '../router';
import { clampDuration, findMissing } from '../rules';
import { useProjectEditor } from '../useProjectEditor';
import { useToast } from '../useToast';
import { ConfirmModal } from './ConfirmModal';

export function Editor({ projectId }: { projectId: string }) {
  const toast = useToast();
  const ed = useProjectEditor(projectId, toast.show);
  // 결과 화면의 "장면 N 편집에서 확인하기" 같은 링크(?scene=N)로 들어오면 그 장면을 먼저 보여준다.
  const [sel, setSel] = useState(() => {
    const n = Number(new URLSearchParams(window.location.search).get('scene'));
    return Number.isInteger(n) && n >= 1 && n <= SCENE_COUNT ? n - 1 : 0;
  });
  const [guides, setGuides] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false); // state 는 같은 틱의 두 번째 클릭에는 아직 갱신되지 않아서 ref 로 동기 차단한다
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // 자막 글꼴(약 0.5MB)을 화면에 들어올 때 미리 받아 둔다(자막이 처음 그려질 때의 글꼴 깜빡임을 줄인다).
  useEffect(() => {
    void document.fonts?.load("600 16px 'Subtitle KR'", '가').catch(() => undefined);
  }, []);

  // 미리보기 재생: 선택한 장면을 그 장면 길이만큼 재생한다.
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const dur = ed.draft?.scenes[sel]?.durationSec ?? 0;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setT((prev) => {
        const next = Math.min(dur, prev + 0.1);
        if (next >= dur) setPlaying(false);
        return next;
      });
    }, 100);
    return () => clearInterval(timer);
  }, [playing, dur]);
  const resetPlayback = () => {
    setPlaying(false);
    setT(0);
  };
  const select = (i: number) => {
    setSel(i);
    resetPlayback();
  };

  if (ed.loadState === 'loading') return <CenterMessage title="불러오는 중…" />;
  if (ed.loadState === 'notfound')
    return (
      <CenterMessage title="프로젝트를 찾을 수 없어요" body="삭제되었거나 주소가 잘못되었을 수 있어요.">
        <Link to="/" className="btn btn-primary">
          프로젝트 목록으로
        </Link>
      </CenterMessage>
    );
  if (ed.loadState === 'error' || !ed.project || !ed.draft)
    return (
      <CenterMessage title="프로젝트를 불러오지 못했어요" body="연결을 확인하고 다시 시도해 주세요.">
        <button className="btn btn-primary" onClick={ed.reload}>
          다시 불러오기
        </button>
      </CenterMessage>
    );

  const project: Project = ed.project;
  const draft = ed.draft;
  const scenes = draft.scenes.map((s, i) => ({ ...s, image: project.scenes[i]?.image ?? null }));
  const cur = scenes[sel]!;
  const total = scenes.reduce((a, s) => a + s.durationSec, 0);
  const busy = isBusy(project.status);
  const missing = findMissing(draft.title, scenes.map((s) => ({ text: s.text, hasImage: !!s.image })));
  const textLen = cur.text.trim().length;

  const goBack = () => {
    if (ed.save === 'failed' && !window.confirm('저장하지 못한 내용이 있어요. 그래도 나갈까요?')) return;
    navigate('/');
  };

  // 영상 생성 요청. 서버는 '저장된' 내용으로 만들기 때문에 먼저 대기 중인 변경을 모두 저장한다.
  const startRender = async () => {
    if (startingRef.current) return; // 연속 클릭 방지(서버도 진행 중이면 새 작업을 만들지 않는다)
    startingRef.current = true;
    setStarting(true);
    try {
      if (!(await ed.saveNow())) {
        toast.show('저장하지 못해서 영상을 만들 수 없어요. 다시 저장한 뒤 시도해 주세요');
        return;
      }
      try {
        await api.createRender(projectId);
      } catch (e) {
        // 이미 진행 중이면 새로 만들지 않고 진행 화면으로 보낸다
        if (!(e instanceof ApiFailure && e.code === 'RENDER_IN_PROGRESS')) throw e;
      }
      navigate(`/projects/${projectId}/result`);
    } catch (e) {
      toast.show(e instanceof Error ? e.message : '영상 만들기를 요청하지 못했어요');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const pickFile = () => fileRef.current?.click();
  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) void ed.uploadImage(sel, f);
  };

  const totalNote =
    total === DEFAULT_TOTAL_SEC
      ? `기본 길이 ${DEFAULT_TOTAL_SEC}초에 맞춰져 있어요.`
      : `기본 길이(${DEFAULT_TOTAL_SEC}초)보다 ${total > DEFAULT_TOTAL_SEC ? `${total - DEFAULT_TOTAL_SEC}초 길어요` : `${DEFAULT_TOTAL_SEC - total}초 짧아요`}. 그대로 만들어도 괜찮아요.`;

  return (
    <div className="editor-shell" data-screen="editor">
      <header className="topbar">
        <button className="btn btn-ghost" style={{ height: 36, padding: '0 10px' }} onClick={goBack}>
          ← 프로젝트
        </button>
        <div className="topbar-sep" />
        <input
          ref={titleRef}
          className="title-input"
          aria-label="영상 제목"
          value={draft.title}
          maxLength={100}
          placeholder="영상 제목을 입력하세요"
          onChange={(e) => ed.setTitle(e.target.value)}
        />
        {project.isSample && <SampleTag />}
        <SaveIndicator state={ed.save} savedAt={ed.savedAt} error={ed.saveError} onRetry={ed.retrySave} />
        <div style={{ flex: 1 }} />
        <div className="total-chip">
          전체 길이 <strong>{total}초</strong>
        </div>
        {project.lastVideo && (
          <Link to={`/projects/${projectId}/result/${project.lastVideo.jobId}`} className="btn btn-ghost" style={{ color: 'var(--primary-text)' }}>
            마지막 생성 영상 보기
          </Link>
        )}
        {busy ? (
          <button className="btn btn-soft" onClick={() => navigate(`/projects/${projectId}/result`)}>
            생성 진행 상황 보기
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => setConfirmOpen(true)}>
            영상 만들기
          </button>
        )}
      </header>
      {busy && (
        <div className="busy-banner">
          이 프로젝트는 지금 영상을 만드는 중이에요. 생성이 끝나기 전까지는 새로 요청할 수 없고, 지금 수정한 내용은 다음 생성 때 반영돼요.
        </div>
      )}

      <div className="editor-body">
        {/* 1. 장면 목록 */}
        <section className="col-scenes" aria-label="장면 목록">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 style={{ fontSize: 14, fontWeight: 700 }}>장면</h2>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>3개 장면이 순서대로 재생돼요</span>
          </div>
          <div className="scene-list">
            {scenes.map((s, i) => {
              const issues = [!s.image && '이미지 없음', !s.text.trim() && '문구 없음'].filter(Boolean).join(' · ');
              return (
                <button
                  key={i}
                  className={`scene-card${i === sel ? ' on' : ''}`}
                  aria-pressed={i === sel}
                  onClick={() => select(i)}
                  data-testid={`scene-card-${i}`}
                >
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: i === sel ? 'var(--primary-text)' : 'var(--text)' }}>장면 {i + 1}</span>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      {s.durationSec}초
                    </span>
                  </span>
                  <span className="scene-thumb">
                    {s.image ? (
                      <>
                        <img src={s.image.url} alt="" />
                        {s.image.isSample && <SampleTag />}
                      </>
                    ) : (
                      <span className="none">이미지 없음</span>
                    )}
                  </span>
                  {s.text.trim() ? (
                    <span className="clamp2" style={{ fontSize: 13, color: '#2f3239' }}>
                      {s.text}
                    </span>
                  ) : (
                    <span style={{ fontSize: 13, color: 'var(--faint)' }}>문구가 비어 있어요</span>
                  )}
                  {issues && <span className="chip-warn" style={{ alignSelf: 'flex-start' }}>{issues}</span>}
                </button>
              );
            })}
          </div>
          <div className="total-box">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: 'var(--text-2)' }}>전체 길이</span>
              <strong>{total}초</strong>
            </div>
            <div className="segbar" aria-hidden>
              {scenes.map((s, i) => (
                <div key={i} style={{ flex: `${s.durationSec} 1 0`, background: i === sel ? 'var(--primary)' : '#c9cbeb' }} />
              ))}
            </div>
            <span className="help">{totalNote}</span>
          </div>
        </section>

        {/* 2. 미리보기 */}
        <section className="col-preview" aria-label="미리보기">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <h2 style={{ fontSize: 15, fontWeight: 700 }}>장면 {sel + 1} 미리보기</h2>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>완성 영상에 보이는 화면 그대로예요</span>
            </div>
            <button className="btn btn-secondary" style={{ height: 34, padding: '0 12px', fontSize: 13, fontWeight: 500, gap: 8 }} onClick={() => setGuides((g) => !g)}>
              <span style={{ width: 14, height: 10, border: '1.5px dashed var(--guide)', borderRadius: 2 }} />
              {guides ? '안내선 숨기기' : '안내선 보기'}
            </button>
          </div>
          <div className="preview-stage">
            <div className="preview-wrap">
              <div className="preview-meta">
                <span className="mono">
                  출력 화면 {VIDEO.width} × {VIDEO.height}
                </span>
                {cur.image?.isSample && <span style={{ color: 'var(--warn-fg)' }}>샘플 이미지 · 실제 이미지가 아니에요</span>}
                {guides && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--primary-text)' }}>
                    <span style={{ width: 16, borderTop: '1.5px dashed var(--guide)' }} />
                    자막 안전 영역 · 편집할 때만 보이고 영상에는 나오지 않아요
                  </span>
                )}
              </div>
              <div className="frame" data-testid="preview-frame">
                {cur.image ? (
                  <img className="bg" src={cur.image.url} alt="" />
                ) : (
                  <div className="empty-img">
                    <button onClick={pickFile}>
                      <span style={{ color: '#fff', fontSize: 15, fontWeight: 600 }}>아직 이미지가 없어요</span>
                      <span style={{ color: '#c9cbf7', fontSize: 13 }}>오른쪽 ‘이미지’에서 사진이나 화면 캡처를 올려 주세요</span>
                    </button>
                  </div>
                )}
                <div className="subtitle-slot" style={{ left: `${SUBTITLE.sideMarginPct}%`, right: `${SUBTITLE.sideMarginPct}%`, bottom: `${SUBTITLE.bottomMarginPct}%` }}>
                  {textLen > 0 ? (
                    <span
                      className="subtitle"
                      data-testid="preview-subtitle"
                      style={{
                        background: SUBTITLE.background,
                        color: SUBTITLE.color,
                        fontSize: `${SUBTITLE.fontSizeWidthPct}cqw`,
                        lineHeight: SUBTITLE.lineHeight,
                        padding: '.9cqw 1.8cqw',
                        borderRadius: '.6cqw',
                        whiteSpace: 'pre-line',
                      }}
                    >
                      {cur.text}
                    </span>
                  ) : (
                    <span className="subtitle-hint">문구를 입력하면 이 자리에 자막이 나와요</span>
                  )}
                </div>
                {guides && <div className="guide-box" />}
              </div>
              <div className="controls">
                <button
                  className="play-btn"
                  aria-label={playing ? '일시정지' : '재생'}
                  onClick={() => {
                    if (!playing && t >= dur) setT(0);
                    setPlaying((p) => !p);
                  }}
                >
                  {playing ? '❚❚' : '▶'}
                </button>
                <div className="progress">
                  <div style={{ width: `${dur ? (t / dur) * 100 : 0}%` }} />
                </div>
                <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>
                  {mmss(t)} / {mmss(dur)}
                </span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn btn-secondary btn-sm" style={{ height: 34 }} onClick={() => select((sel + SCENE_COUNT - 1) % SCENE_COUNT)}>
                    이전 장면
                  </button>
                  <button className="btn btn-secondary btn-sm" style={{ height: 34 }} onClick={() => select((sel + 1) % SCENE_COUNT)}>
                    다음 장면
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 3. 편집 패널 */}
        <section className="col-inspector" aria-label="장면 편집">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>장면 {sel + 1} 편집</h2>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>입력하면 자동으로 저장되고 미리보기에 바로 반영돼요.</span>
          </div>

          <div className="field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label htmlFor="scene-text">문구</label>
              <span className="mono" style={{ fontSize: 12, color: textLen > TEXT_RECOMMENDED_LENGTH ? 'var(--warn-fg)' : 'var(--muted)' }}>
                {textLen} / {TEXT_RECOMMENDED_LENGTH}자 권장
              </span>
            </div>
            <textarea
              id="scene-text"
              ref={textRef}
              className="textarea"
              rows={3}
              maxLength={200}
              value={cur.text}
              placeholder="이 장면에서 보여줄 안내 문장을 입력하세요"
              onChange={(e) => ed.setText(sel, e.target.value)}
              onPaste={(e) => {
                // 복사해 온 글에는 분해된 한글 자모(NFD, macOS)나 보이지 않는 문자(제로폭 공백 등)가 섞여 있을 수 있다. 그대로 붙이면
                // 글자 수 한도(maxLength)를 일찍 채워 뒤가 잘리므로 붙여 넣는 순간 저장 때와 같은 규칙으로 정리한다(입력 중 IME 조합에는 손대지 않는다).
                const raw = e.clipboardData.getData('text');
                const nfc = cleanText(raw);
                if (nfc === raw) return;
                e.preventDefault();
                const el = e.currentTarget;
                const start = el.selectionStart;
                const next = (el.value.slice(0, start) + nfc + el.value.slice(el.selectionEnd)).slice(0, 200);
                ed.setText(sel, next);
                const caret = Math.min(start + nfc.length, next.length);
                requestAnimationFrame(() => el.setSelectionRange(caret, caret));
              }}
            />
            {textLen === 0 && <span className="note-warn">문구가 비어 있어요. 영상 아래쪽 자막으로 보여줄 문장을 입력해 주세요.</span>}
            {textLen > TEXT_RECOMMENDED_LENGTH && <span className="note-warn">문구가 길어서 자막이 3줄 이상이 될 수 있어요. 짧게 나누면 더 읽기 쉬워요.</span>}
            {textLen > 0 && textLen <= TEXT_RECOMMENDED_LENGTH && <span className="help">한 장면에 한 문장, {TEXT_RECOMMENDED_LENGTH}자 이내가 읽기 편해요.</span>}
          </div>

          <div className="field">
            <span className="label">이미지</span>
            <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} data-testid="file-input" />
            {cur.image ? (
              <div className="image-row">
                <div className="thumb-96">
                  <img src={cur.image.url} alt="" />
                </div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cur.image.fileName}</span>
                    {cur.image.isSample && <SampleTag />}
                  </span>
                  <span className="help mono">
                    {cur.image.width} × {cur.image.height}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-secondary btn-sm" onClick={pickFile} disabled={ed.uploading === sel}>
                      {ed.uploading === sel ? '올리는 중…' : '바꾸기'}
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--err-fg)' }} onClick={() => void ed.removeImage(sel)} disabled={ed.uploading === sel}>
                      삭제
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <DropZone onFile={(f) => void ed.uploadImage(sel, f)} onPick={pickFile} uploading={ed.uploading === sel} />
                <span className="note-warn">이미지가 있어야 영상을 만들 수 있어요.</span>
              </>
            )}
          </div>

          <div className="field">
            <span className="label">장면 길이</span>
            <DurationControl key={`${sel}`} value={cur.durationSec} onChange={(v) => { ed.setDuration(sel, v); resetPlayback(); }} />
            <span className="help">
              {DURATION_MIN_SEC}초에서 {DURATION_MAX_SEC}초까지 정할 수 있어요. 문구를 천천히 읽으려면 10초 정도가 좋아요.
            </span>
          </div>

          <div style={{ marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--divider)' }}>
            {sel < SCENE_COUNT - 1 ? (
              <button className="btn btn-soft" style={{ width: '100%', height: 42 }} onClick={() => select(sel + 1)}>
                다음: 장면 {sel + 2} 편집 →
              </button>
            ) : (
              !busy && (
                <button className="btn btn-soft" style={{ width: '100%', height: 42 }} onClick={() => setConfirmOpen(true)}>
                  장면을 모두 확인했어요 · 영상 만들기 →
                </button>
              )
            )}
          </div>
        </section>
      </div>

      {confirmOpen && (
        <ConfirmModal
          title={draft.title}
          totalSec={total}
          durations={scenes.map((s) => s.durationSec)}
          missing={missing}
          onClose={() => setConfirmOpen(false)}
          onFix={(i) => {
            setConfirmOpen(false);
            select(i);
          }}
          onFixTitle={() => {
            setConfirmOpen(false);
            setTimeout(() => titleRef.current?.focus(), 0);
          }}
          onStart={() => void startRender()}
          starting={starting}
        />
      )}
      {toast.node}
    </div>
  );
}

function SaveIndicator({ state, savedAt, error, onRetry }: { state: 'saved' | 'saving' | 'failed'; savedAt: string; error: string | null; onRetry: () => void }) {
  if (state === 'saving')
    return (
      <span className="save-state" style={{ color: 'var(--muted)' }} role="status" data-testid="save-state">
        <i style={{ background: '#b0b3bc' }} />
        저장 중…
      </span>
    );
  if (state === 'failed')
    return (
      <span className="save-state" style={{ color: 'var(--err-fg)', fontWeight: 500, gap: 8 }} role="alert" data-testid="save-state" title={error ?? undefined}>
        <i style={{ background: '#d3404c' }} />
        저장하지 못했어요
        <button className="btn btn-sm" style={{ background: '#fff', color: 'var(--err-fg)', border: '1px solid #f0c4c8' }} onClick={onRetry}>
          다시 저장
        </button>
      </span>
    );
  return (
    <span className="save-state" style={{ color: 'var(--ok-fg)' }} role="status" data-testid="save-state">
      <i style={{ background: 'var(--ok-dot)' }} />
      저장됨 · {savedAt}
    </span>
  );
}

function DropZone({ onFile, onPick, uploading }: { onFile: (f: File) => void; onPick: () => void; uploading: boolean }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };
  return (
    <div
      className={`dropzone${over ? ' over' : ''}`}
      data-testid="dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <span style={{ fontSize: 14, fontWeight: 600 }}>이미지를 끌어다 놓거나 파일을 선택하세요</span>
      <span className="help">{IMAGE_LABEL}, 10MB 이하 · 가로형(16:9) 사진이 가장 잘 맞아요</span>
      <button className="btn btn-primary btn-sm" style={{ height: 34, padding: '0 14px', fontSize: 13 }} onClick={onPick} disabled={uploading}>
        {uploading ? '올리는 중…' : '파일 선택'}
      </button>
    </div>
  );
}

/** [−][숫자][+] 와 5/10/15초 빠른 선택. 직접 입력은 입력을 마친 뒤(blur/Enter)에 3~30 정수로 맞춘다. */
function DurationControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setText(String(value)), [value]);

  const commit = () => {
    const r = clampDuration(text);
    if (!r) {
      setText(String(value));
      setNote(`${DURATION_MIN_SEC}초에서 ${DURATION_MAX_SEC}초 사이의 숫자로 입력해 주세요.`);
      return;
    }
    setNote(r.adjusted ? `${DURATION_MIN_SEC}초에서 ${DURATION_MAX_SEC}초 사이 정수로 맞췄어요.` : null);
    setText(String(r.value));
    if (r.value !== value) onChange(r.value);
  };
  const step = (d: number) => {
    setNote(null);
    const next = Math.min(DURATION_MAX_SEC, Math.max(DURATION_MIN_SEC, value + d));
    if (next !== value) onChange(next);
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="stepper">
          <button aria-label="1초 줄이기" onClick={() => step(-1)} disabled={value <= DURATION_MIN_SEC}>
            −
          </button>
          <input
            type="number"
            inputMode="numeric"
            aria-label="장면 길이(초)"
            min={DURATION_MIN_SEC}
            max={DURATION_MAX_SEC}
            step={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur())}
          />
          <button aria-label="1초 늘리기" onClick={() => step(1)} disabled={value >= DURATION_MAX_SEC}>
            +
          </button>
        </div>
        <span style={{ color: 'var(--text-2)' }}>초</span>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {DURATION_QUICK_PICKS.map((v) => (
            <button key={v} className={`quick${v === value ? ' on' : ''}`} onClick={() => { setNote(null); if (v !== value) onChange(v); }}>
              {v}초
            </button>
          ))}
        </div>
      </div>
      {note && (
        <span className="note-warn" role="status" data-testid="duration-note">
          {note}
        </span>
      )}
    </>
  );
}
