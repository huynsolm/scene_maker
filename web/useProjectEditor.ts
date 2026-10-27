import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/types';
import { ApiFailure, api, type SaveBody } from './api';
import { hm } from './format';
import { precheckImage } from './rules';

export type SaveState = 'saved' | 'saving' | 'failed';
export type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

const DEBOUNCE_MS = 900;

/**
 * 편집 화면의 상태 관리.
 *  - `draft`(제목·문구·길이)는 화면이 소유한다. 저장 응답으로 덮어쓰지 않으므로 입력 중인 글자가 사라지지 않는다.
 *  - 저장은 한 번에 하나만 보내고, 보내는 동안 더 고쳐졌으면 끝난 뒤 최신 내용을 다시 보낸다.
 *  - 저장에 실패해도 draft 는 그대로이고, [다시 저장]이나 다음 입력이 최신 draft 를 다시 보낸다.
 *  - 이미지는 자동 저장과 별개로 즉시 업로드한다(서버 응답의 이미지 정보만 반영).
 */
export function useProjectEditor(id: string, onToast: (msg: string) => void) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [project, setProject] = useState<Project | null>(null);
  const [draft, setDraft] = useState<SaveBody | null>(null);
  const [save, setSave] = useState<SaveState>('saved');
  const [savedAt, setSavedAt] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<number | null>(null);

  const draftRef = useRef<SaveBody | null>(null);
  const version = useRef(0); // 편집할 때마다 증가
  const savedVersion = useRef(0); // 서버에 반영이 확인된 마지막 버전
  const inFlight = useRef(false);
  const inFlightDone = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const saveFailedRef = useRef(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const p = await api.getProject(id);
      if (!alive.current) return;
      const d: SaveBody = {
        title: p.title,
        scenes: p.scenes.map((s) => ({ text: s.text, durationSec: s.durationSec })),
      };
      draftRef.current = d;
      version.current = 0;
      savedVersion.current = 0;
      setProject(p);
      setDraft(d);
      setSave('saved');
      setSavedAt(hm(new Date(p.updatedAt)));
      setLoadState('ready');
    } catch (e) {
      if (!alive.current) return;
      setLoadState(e instanceof ApiFailure && e.status === 404 ? 'notfound' : 'error');
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
      // 화면을 떠날 때 아직 못 보낸 변경이 있으면 한 번 더 시도한다(결과는 기다리지 않는다).
      if (draftRef.current && version.current !== savedVersion.current && !inFlight.current) {
        void api.saveProject(id, draftRef.current).catch(() => undefined);
      }
    };
  }, [id, load]);

  /** draft 를 서버로 한 번 보낸다. 성공하면 true. */
  const send = useCallback(async (): Promise<boolean> => {
    const body = draftRef.current!;
    const sentVersion = version.current;
    setSave('saving');
    try {
      const p = await api.saveProject(id, body);
      if (!alive.current) return false;
      savedVersion.current = Math.max(savedVersion.current, sentVersion);
      saveFailedRef.current = false;
      setProject((prev) => (prev ? { ...prev, status: p.status, updatedAt: p.updatedAt } : prev));
      setSaveError(null);
      if (version.current === sentVersion) {
        setSave('saved');
        setSavedAt(hm(new Date()));
      }
      return true;
    } catch (e) {
      saveFailedRef.current = true;
      if (alive.current) {
        setSaveError(e instanceof Error ? e.message : '저장하지 못했어요.');
        setSave('failed');
      }
      return false;
    }
  }, [id]);

  /**
   * 서버 내용이 draft 와 같아질 때까지 저장한다. 한 번에 하나만 전송하고, 보내는 동안 더 고쳐졌다면
   * 최신 내용을 이어서 보낸다. 이미 진행 중이면 그 작업이 끝나기를 기다린다. 실패하면 false(draft 는 그대로).
   */
  const flush = useCallback((): Promise<boolean> => {
    if (inFlight.current) return inFlightDone.current;
    if (!draftRef.current || version.current === savedVersion.current) return Promise.resolve(true);
    inFlight.current = true;
    inFlightDone.current = (async () => {
      try {
        while (alive.current && version.current !== savedVersion.current) {
          if (!(await send())) return false;
        }
        return true;
      } finally {
        inFlight.current = false;
      }
    })();
    return inFlightDone.current;
  }, [send]);

  /**
   * 대기 중인 변경(디바운스 중이거나 전송 중)을 지금 모두 저장하고 끝날 때까지 기다린다.
   * 영상 생성은 서버에 저장된 내용을 기준으로 만들기 때문에, 요청 직전에 반드시 호출한다.
   */
  const saveNow = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    const ok = await flush();
    return ok && version.current === savedVersion.current;
  }, [flush]);

  const edit = useCallback(
    (fn: (d: SaveBody) => SaveBody) => {
      if (!draftRef.current) return;
      const next = fn(draftRef.current);
      draftRef.current = next;
      version.current += 1;
      setDraft(next);
      setSave('saving');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush],
  );

  const setTitle = (title: string) => edit((d) => ({ ...d, title }));
  const setText = (i: number, text: string) =>
    edit((d) => ({ ...d, scenes: d.scenes.map((s, j) => (j === i ? { ...s, text } : s)) }));
  const setDuration = (i: number, durationSec: number) =>
    edit((d) => ({ ...d, scenes: d.scenes.map((s, j) => (j === i ? { ...s, durationSec } : s)) }));

  const retrySave = () => {
    clearTimeout(timer.current);
    // 실패 후에는 savedVersion 이 뒤처져 있으므로 그대로 최신 draft 를 다시 보낸다.
    void flush();
  };

  const applyImages = (p: Project) =>
    setProject((prev) =>
      prev
        ? { ...prev, status: p.status, updatedAt: p.updatedAt, scenes: prev.scenes.map((s, j) => ({ ...s, image: p.scenes[j]?.image ?? null })) }
        : prev,
    );

  const uploadImage = async (position: number, file: File) => {
    const problem = precheckImage(file);
    if (problem) {
      onToast(problem);
      return;
    }
    setUploading(position);
    try {
      applyImages(await api.uploadImage(id, position, file));
    } catch (e) {
      onToast(e instanceof Error ? e.message : '이미지를 올리지 못했어요');
    } finally {
      if (alive.current) setUploading(null);
    }
  };

  const removeImage = async (position: number) => {
    try {
      applyImages(await api.removeImage(id, position));
    } catch (e) {
      onToast(e instanceof Error ? e.message : '이미지를 지우지 못했어요');
    }
  };

  // 저장되지 않은 변경이 있는 채로 탭을 닫거나 새로고침하면 브라우저가 한 번 확인한다.
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (version.current !== savedVersion.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, []);

  return {
    loadState, reload: load, project, draft, save, savedAt, saveError, uploading,
    setTitle, setText, setDuration, retrySave, saveNow, uploadImage, removeImage,
    hasUnsaved: () => version.current !== savedVersion.current,
  };
}
