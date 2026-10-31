import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/types';
import { ApiFailure, api, type SaveBody } from './api';
import { hm } from './format';
import { precheckImage } from './rules';
import { fitCleaned, cleanText, cleanTitle } from '../shared/text';
import { TEXT_MAX_LENGTH, TITLE_MAX_LENGTH } from '../shared/limits';

export type SaveState = 'saved' | 'saving' | 'failed';
export type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

const DEBOUNCE_MS = 900;

/** 보낼 본문. 서버 스키마와 같은 규칙으로 정리하고 정리 후 길이를 한도에 맞춘다(안 맞추면 저장이 거절된다). */
const toSendBody = (b: SaveBody): SaveBody => ({
  title: fitCleaned(b.title, cleanTitle, TITLE_MAX_LENGTH),
  scenes: b.scenes.map((s) => ({ ...s, text: fitCleaned(s.text, cleanText, TEXT_MAX_LENGTH) })),
});

const sameBody = (a: SaveBody, b: SaveBody) =>
  a.title === b.title && a.scenes.length === b.scenes.length && a.scenes.every((s, i) => s.text === b.scenes[i]!.text && s.durationSec === b.scenes[i]!.durationSec);

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
  // IME 조합 중에는 입력칸의 값을 바꾸면 조합이 깨지므로 서버가 정리한 값의 반영을 미룬다(다음 저장 때 반영).
  const composing = useRef(false);
  // 조합 중에 도착해 반영하지 못한 서버 응답(정리된 값)과 그 응답이 대응하는 편집 버전. 조합이 끝나면 아직 최신일 때만 반영한다.
  const pendingSync = useRef<{ version: number; body: SaveBody } | null>(null);

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
        void api.saveProject(id, toSendBody(draftRef.current)).catch(() => undefined);
      }
    };
  }, [id, load]);

  /** 서버가 정리해 돌려준 값으로 draft 를 맞춘다(같으면 아무것도 하지 않는다). version 은 올리지 않는다. */
  const applyServerBody = useCallback((saved: SaveBody) => {
    if (draftRef.current && !sameBody(saved, draftRef.current)) {
      draftRef.current = saved;
      setDraft(saved);
    }
  }, []);

  /** draft 를 서버로 한 번 보낸다. 성공하면 true. */
  const send = useCallback(async (): Promise<boolean> => {
    const body = toSendBody(draftRef.current!);
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
        // 서버는 저장할 때 문구·제목을 정리한다(NFC, 보이지 않는 문자 제거 — shared/text.ts). 붙여넣기가 아닌 입력(드래그 앤 드롭 등)으로
        // 들어온 보이지 않는 문자가 화면에는 남고 저장값에서는 사라져 "저장됨"인데 둘이 다른 상태가 되지 않도록,
        // 그 사이 더 고친 것이 없으면 정리된 값으로 draft 를 맞춘다(version 은 올리지 않으므로 다시 저장하지 않는다).
        // IME 조합 중에는 입력칸의 값을 바꾸면 조합이 깨지므로 응답을 보관했다가 조합이 끝난 뒤 반영한다(setComposing).
        const saved: SaveBody = { title: p.title, scenes: p.scenes.map((s) => ({ text: s.text, durationSec: s.durationSec })) };
        if (composing.current) pendingSync.current = { version: sentVersion, body: saved };
        else {
          pendingSync.current = null;
          applyServerBody(saved);
        }
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
  }, [id, applyServerBody]);

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
    setComposing: (v: boolean) => {
      composing.current = v;
      if (v) return;
      // 조합이 끝났다. 브라우저에 따라 마지막 input 이벤트가 compositionend 직후에 올 수 있으므로 한 틱 뒤에 확인한다.
      // 그 사이 더 고쳤다면(version 이 달라졌다면) 오래된 응답으로 덮어쓰지 않고 버린다 — 이어지는 저장이 최신 내용을 다시 보낸다.
      setTimeout(() => {
        const p = pendingSync.current;
        if (!p || composing.current || !alive.current) return;
        pendingSync.current = null;
        if (version.current === p.version) applyServerBody(p.body);
      }, 0);
    },
    hasUnsaved: () => version.current !== savedVersion.current,
  };
}
