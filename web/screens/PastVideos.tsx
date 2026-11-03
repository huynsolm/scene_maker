import { useCallback, useEffect, useRef, useState } from 'react';
import type { RenderList, RenderListItem } from '../../shared/types';
import { ApiFailure, api } from '../api';
import { Modal } from '../components';
import { formatUpdated } from '../format';
import { Link, navigate } from '../router';
import { useToast } from '../useToast';

interface Props {
  projectId: string;
  /** 지금 화면에서 보고 있는 작업(완성된 영상이면 목록에서 "지금 보는 영상"으로 표시) */
  viewedJobId: string;
  /** 바뀌면 목록을 처음부터 다시 읽는다(예: 보고 있던 작업이 완성됐을 때) */
  refreshKey: string;
  /** 영상을 지운 뒤 호출 — 상위가 "마지막 생성 영상" 같은 파생 정보를 다시 읽는다 */
  onChanged: () => void;
  /** 마지막 영상을 지워 목록이 사라질 때 초점을 받을 곳을 상위가 정한다(이 컴포넌트는 빈 목록을 그리지 않으므로 제목도 없다) */
  onEmptied?: () => void;
}

/**
 * 이 프로젝트의 지난 완성 영상 목록과 개별 삭제.
 * 목록 응답마다 세대 번호를 확인해, 삭제 전에 보낸 조회가 늦게 도착해도 지워진 항목이 되살아나지 않게 한다.
 */
export function PastVideos({ projectId, viewedJobId, refreshKey, onChanged, onEmptied }: Props) {
  const toast = useToast();
  const [items, setItems] = useState<RenderListItem[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 삭제 요청의 결과를 알 수 없는 상태(시간 초과·연결 끊김). 확인되기 전까지 모든 삭제를 막는다. */
  const [unknown, setUnknown] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const gen = useRef(0); // 목록 세대: 올라가면 그 전에 보낸 목록 응답은 버린다
  const busyRef = useRef(false);
  const moreRef = useRef(false);
  const pendingId = useRef<string | null>(null); // 결과를 모르는 삭제의 대상
  const viewedRef = useRef(viewedJobId);
  viewedRef.current = viewedJobId;
  // 이 화면이 아직 떠 있는가. 대상이 바뀌어 화면이 새로 만들어지면 이전 화면에서 시작한 삭제·재확인이 늦게 끝나도,
  // 전역 이동(navigate)이나 초점 이동으로 지금 화면을 건드리지 않아야 한다(상태 갱신은 언마운트되면 무시되지만 이동은 아니다).
  const mounted = useRef(true);
  const rafId = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(rafId.current); // 예약해 둔 초점 이동도 취소한다
    };
  }, []);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onEmptiedRef = useRef(onEmptied);
  onEmptiedRef.current = onEmptied;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const apply = useCallback((list: RenderList) => {
    setItems(list.items);
    setHasMore(list.hasMore);
    setListError(null);
  }, []);

  /** 처음 페이지를 다시 읽는다. 성공하면 목록을 돌려주고, 낡은 응답이거나 실패하면 null. */
  const loadFirst = useCallback(async (): Promise<RenderList | null> => {
    const g = ++gen.current;
    try {
      const list = await api.listRenders(projectId);
      if (g !== gen.current) return null;
      apply(list);
      return list;
    } catch (e) {
      if (g !== gen.current) return null;
      setListError(e instanceof Error ? e.message : '지난 영상을 불러오지 못했어요.');
      return null;
    }
  }, [projectId, apply]);

  // 다른 프로젝트로 바뀌면 화면 상태를 비운다.
  useEffect(() => {
    setItems(null);
    setHasMore(false);
    setListError(null);
    setConfirmId(null);
    setUnknown(false);
    pendingId.current = null;
  }, [projectId]);
  // 목록은 프로젝트가 바뀌거나 보던 작업의 상태가 바뀔 때 다시 읽는다. 이때 이미 보이는 목록과 열린 확인 창은 그대로 둔다.
  useEffect(() => {
    void loadFirst();
    return () => void gen.current++;
  }, [loadFirst, refreshKey]);

  const loadMore = async () => {
    if (moreRef.current || !items || items.length === 0) return;
    moreRef.current = true;
    setLoadingMore(true);
    const g = gen.current;
    try {
      const list = await api.listRenders(projectId, items[items.length - 1]!.id);
      if (g !== gen.current) return;
      setItems((cur) => {
        const seen = new Set((cur ?? []).map((i) => i.id));
        return [...(cur ?? []), ...list.items.filter((i) => !seen.has(i.id))];
      });
      setHasMore(list.hasMore);
    } catch (e) {
      if (g !== gen.current) return;
      if (e instanceof ApiFailure && e.status === 404) {
        toast.show('목록이 바뀌어 처음부터 다시 불러왔어요');
        void loadFirst(); // 기준으로 삼은 영상이 지워졌다
      } else toast.show(e instanceof Error ? e.message : '더 불러오지 못했어요');
    } finally {
      moreRef.current = false;
      setLoadingMore(false);
    }
  };

  /**
   * 삭제 응답의 첫 페이지(`first`)에서 시작해, 사용자가 펼쳐 두었던 개수(`target`)만큼 커서로 이어 읽는다(요청당 최대 50).
   * 읽는 중 하나라도 실패하면 서버의 첫 페이지만 쓴다(접히지만 틀리지는 않는다).
   */
  const readRange = async (first: RenderList, target: number, g: number): Promise<{ items: RenderListItem[]; hasMore: boolean }> => {
    let items = first.items;
    let hasMore = first.hasMore;
    try {
      while (items.length < target && hasMore) {
        const page = await api.listRenders(projectId, items[items.length - 1]!.id, Math.min(50, target - items.length));
        if (g !== gen.current) break; // 그 사이 더 새로운 읽기가 시작됐다 — 호출한 쪽이 이 결과를 버린다
        items = [...items, ...page.items];
        hasMore = page.hasMore;
        if (page.items.length === 0) break;
      }
    } catch {
      return { items: first.items, hasMore: first.hasMore };
    }
    return { items, hasMore };
  };

  /** 영상이 사라진 것이 확인된 뒤의 공통 처리. 보고 있던 영상이면 남은 최신 영상(없으면 편집 화면)으로 이동한다. */
  const afterRemoved = (id: string, list: RenderList) => {
    pendingId.current = null;
    onChangedRef.current();
    if (!mounted.current) return; // 사용자가 이미 다른 화면으로 옮겼다 — 그 화면을 덮어쓰지 않는다
    if (id === viewedRef.current) {
      const next = list.items[0];
      navigate(next ? `/projects/${projectId}/result/${next.id}` : `/projects/${projectId}`);
    } else {
      // 지운 항목의 버튼이 사라지므로 초점이 문서 맨 앞으로 빠지지 않게 목록 제목으로 옮긴다.
      // 목록이 아예 비면 제목도 사라지므로 상위가 정한 곳으로 옮긴다.
      rafId.current = requestAnimationFrame(() => {
        if (!mounted.current) return; // 예약한 뒤 화면이 바뀌었으면 새 화면의 초점을 빼앗지 않는다
        if (list.total === 0) onEmptiedRef.current?.();
        else headingRef.current?.focus();
      });
    }
  };

  const remove = async (id: string) => {
    if (busyRef.current || unknown) return;
    busyRef.current = true;
    setBusy(true);
    pendingId.current = id;
    try {
      const res = await api.deleteRender(projectId, id);
      gen.current++; // 이전에 보낸 목록 조회가 지금 이후에 도착해도 쓰지 않는다
      // 이미 "더 보기"로 펼친 범위는 접지 않되, 캐시를 믿지 않고 그 개수만큼 서버에서 다시 읽는다.
      // (지운 항목만 빼고 유지하면 다른 화면의 삭제·완성이 섞여 항목이 남거나 빠지고 "더 보기"가 꺼질 수 있다.)
      const g = gen.current;
      const range = await readRange(res.list, Math.max(0, (itemsRef.current?.length ?? 0) - 1), g);
      if (g === gen.current && mounted.current) {
        setItems(range.items);
        setHasMore(range.hasMore);
        setListError(null);
      }
      toast.show('영상을 삭제했어요');
      afterRemoved(id, res.list);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) {
        toast.show('이미 삭제된 영상이에요');
        const list = await loadFirst();
        if (list) afterRemoved(id, list);
        else setUnknown(true); // 목록을 읽지 못하면 화면 상태를 믿을 수 없다
      } else if (e instanceof ApiFailure && e.code === 'RENDER_NOT_DELETABLE') {
        pendingId.current = null;
        toast.show(e.message);
        void loadFirst();
      } else if (e instanceof ApiFailure && e.status === 0) {
        // 시간 초과·연결 끊김: 서버가 지웠는지 알 수 없다
        setUnknown(true);
      } else {
        pendingId.current = null;
        toast.show(e instanceof Error ? e.message : '삭제하지 못했어요');
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** 결과를 모르는 삭제를 확인한다. 목록 재조회가 성공해야 확정하고, 그 영상이 아직 있는지로 판단한다. */
  const recheck = async () => {
    if (rechecking) return;
    setRechecking(true);
    try {
      const list = await loadFirst();
      if (!list) return; // 확인하지 못함: 불명확 상태 유지
      const id = pendingId.current;
      if (!id) {
        setUnknown(false);
        return;
      }
      try {
        await api.getRender(projectId, id);
        pendingId.current = null;
        setUnknown(false);
        toast.show('영상이 삭제되지 않았어요');
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404) {
          setUnknown(false);
          toast.show('영상이 삭제됐어요');
          afterRemoved(id, list);
        } // 그 밖의 오류: 확인하지 못함
      }
    } finally {
      setRechecking(false);
    }
  };

  if (!items && !listError) return null;
  if (items && items.length === 0 && !unknown && !listError) return null;

  return (
    <section className="past" data-testid="past-videos" aria-label="이전에 만든 영상">
      <h3 ref={headingRef} tabIndex={-1} className="focus-target" style={{ fontSize: 14, fontWeight: 700 }}>
        이전에 만든 영상
      </h3>
      {unknown && (
        <div className="note-warn" role="alert" data-testid="delete-unknown" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 200px' }}>삭제 결과를 확인하지 못했어요. 확인되기 전에는 다른 영상도 삭제할 수 없어요.</span>
          <button className="btn btn-secondary" onClick={() => void recheck()} disabled={rechecking}>
            {rechecking ? '확인하는 중…' : '다시 확인'}
          </button>
        </div>
      )}
      {listError && (
        <div className="note-warn" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 200px' }}>{listError}</span>
          <button className="btn btn-secondary" onClick={() => void loadFirst()}>
            다시 불러오기
          </button>
        </div>
      )}
      {items && items.length > 0 && (
        <ul className="past-list">
          {items.map((v, idx) => {
            const current = v.id === viewedJobId;
            // 같은 이름의 버튼이 반복되므로 어떤 영상인지 이름에 넣는다. 같은 분에 만든 같은 길이의 영상도 구별되도록 최신순 번호를 붙인다.
            const what = `최신순 ${idx + 1}번째, ${formatUpdated(v.finishedAt)}에 만든 ${v.totalSec}초 영상`;
            return (
              <li key={v.id} className="past-item" data-testid="past-item" data-id={v.id} data-current={current}>
                <div className="meta">
                  <strong>{formatUpdated(v.finishedAt)}</strong>
                  <span style={{ color: 'var(--text-2)' }}>
                    {v.totalSec}초 · 장면 {v.sceneCount}개
                  </span>
                  {current && <span className="tag-cur">지금 보는 영상</span>}
                  {v.outdated && <span className="chip-warn" style={{ alignSelf: 'flex-start' }}>현재 내용보다 이전</span>}
                </div>
                <div className="actions">
                  {!current && (
                    <Link to={`/projects/${projectId}/result/${v.id}`} className="btn btn-secondary" ariaLabel={`${what} 보기`}>
                      보기
                    </Link>
                  )}
                  <a className="btn btn-secondary" href={v.downloadUrl} download aria-label={`${what} 다운로드`}>
                    다운로드
                  </a>
                  <button className="btn btn-secondary" data-testid="past-delete" aria-label={`${what} 삭제`} disabled={busy || unknown} onClick={() => setConfirmId(v.id)}>
                    삭제
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && (
        <button className="btn btn-secondary" onClick={() => void loadMore()} disabled={loadingMore} data-testid="past-more" style={{ alignSelf: 'flex-start' }}>
          {loadingMore ? '불러오는 중…' : '더 보기'}
        </button>
      )}
      {toast.node}
      {confirmId && (
        <Modal labelledBy="delete-video-title" onClose={() => setConfirmId(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h2 id="delete-video-title" style={{ fontSize: 20, fontWeight: 700 }}>
              이 영상을 삭제할까요?
            </h2>
            <p style={{ color: 'var(--text-2)', textWrap: 'pretty' }}>
              영상 파일이 지워지고 되돌릴 수 없어요. 이 영상에만 쓰인 이전 이미지도 함께 지워져요. 지금 편집 중인 내용에는 영향이 없어요.
            </p>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" data-autofocus onClick={() => setConfirmId(null)}>
              취소
            </button>
            <button
              className="btn btn-danger"
              data-testid="confirm-delete-video"
              onClick={() => {
                const id = confirmId;
                setConfirmId(null);
                void remove(id);
              }}
            >
              삭제
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
