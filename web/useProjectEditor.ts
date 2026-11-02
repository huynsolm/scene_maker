import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '../shared/types';
import { ApiFailure, api, type SaveBody } from './api';
import { hm } from './format';
import { mergeImages } from './mergeImages';
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
  const [uploading, setUploading] = useState<string | null>(null); // 업로드 중인 장면 ID(장면이 지워져도 다른 장면에 표시되지 않게 ID 로 둔다)
  // 장면 구성을 이 화면이 믿을 수 없다. 'changed' = 서버의 장면 구성이 달라졌다(저장 409, 삭제 404),
  // 'unknown' = 장면 추가·삭제 요청이 시간 안에 응답하지 않아 처리됐는지 알 수 없다(다시 시도하면 장면이 중복될 수 있다).
  const [conflict, setConflictState] = useState<'changed' | 'unknown' | null>(null);
  // 장면 변경 요청은 비동기 흐름 안에서 최신 충돌 상태를 읽어야 하므로 ref 에도 둔다(state 는 클로저에 낡은 값이 남는다).
  const conflictRef = useRef<'changed' | 'unknown' | null>(null);
  const setConflict = (v: 'changed' | 'unknown' | null) => {
    conflictRef.current = v;
    setConflictState(v);
  };
  const [structuring, setStructuring] = useState(false); // 장면 추가·삭제 진행 중

  const draftRef = useRef<SaveBody | null>(null);
  const version = useRef(0); // 편집할 때마다 증가
  const savedVersion = useRef(0); // 서버에 반영이 확인된 마지막 버전
  // 진행 중인 저장 작업(세대별). 새로 불러오면 이전 세대의 작업은 응답이 무시되므로, 새 세대의 저장은 그 작업을 기다리지 않고 따로 시작한다.
  const inFlight = useRef<{ gen: number; done: Promise<boolean> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const saveFailedRef = useRef(false);
  // IME 조합 중에는 입력칸의 값을 바꾸면 조합이 깨지므로 서버가 정리한 값의 반영을 미룬다(다음 저장 때 반영).
  const composing = useRef(false);
  // 조합 중에 도착해 반영하지 못한 서버 응답(정리된 값)과 그 응답이 대응하는 편집 버전. 조합이 끝나면 아직 최신일 때만 반영한다.
  const pendingSync = useRef<{ version: number; body: SaveBody } | null>(null);
  // 장면 추가·삭제 중에는 자동 저장이 장면 목록이 바뀌기 전의 ID 로 나가지 않게 기다린다.
  const structural = useRef<Promise<unknown> | null>(null);
  const structuralBusy = useRef(false); // 동시에 하나만(연속 클릭 방지)
  // 서버를 바꾸는 요청(이미지 업로드·삭제, 장면 추가·삭제)은 한 줄로 세운다. 동시에 보내면 서버가 처리한 순서와 응답이 도착하는 순서가
  // 달라져, 늦게 도착한 오래된 응답이 최신 화면(이미지·장면 목록)을 덮는다.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(fn);
    queue.current = run.catch(() => undefined);
    return run;
  };
  /** 줄 서 있다가 차례가 왔을 때 화면이 이미 새로 불러와졌다면(세대가 다르면) 요청을 보내지 않고 null 을 돌려준다. */
  const enqueueFor = <T,>(gen: number, fn: () => Promise<T>): Promise<T | null> =>
    enqueue(async () => (gen !== loadGen.current ? null : fn()));
  // 화면을 새로 불러올 때마다 올린다. 이전 세대에서 시작한 요청의 응답(성공이든 실패든)은 새 화면에 반영하지 않는다.
  const loadGen = useRef(0);
  // 서버가 받아 준 가장 큰 편집 버전(현재 세대). 화면을 떠난 뒤 도착한 응답도 기록해, 떠난 뒤의 마지막 저장이 중복·누락되지 않게 한다.
  const sentOk = useRef(0);

  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    setLoadState('loading');
    try {
      // 이미 서버로 나간 이미지·장면 요청은 끝나기를 기다린 뒤 읽는다(그래야 읽은 내용에 그 결과가 들어 있다).
      // 아직 나가지 않고 줄 서 있던 요청은 세대가 달라져서 실행되지 않는다(enqueueFor).
      await queue.current;
      const p = await api.getProject(id);
      if (!alive.current || gen !== loadGen.current) return;
      const d: SaveBody = {
        title: p.title,
        scenes: p.scenes.map((s) => ({ id: s.id, text: s.text, durationSec: s.durationSec })),
      };
      draftRef.current = d;
      version.current = 0;
      savedVersion.current = 0;
      sentOk.current = 0;
      setProject(p);
      setDraft(d);
      setConflict(null);
      saveFailedRef.current = false;
      setSaveError(null);
      setSave('saved');
      setSavedAt(hm(new Date(p.updatedAt)));
      setLoadState('ready');
    } catch (e) {
      if (!alive.current || gen !== loadGen.current) return;
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
      // 화면 안의 이동(목록, 결과 화면)은 이동 전에 saveNow 로 저장하므로 여기는 브라우저 뒤로 가기 같은 이동의 마지막 보루다.
      const running = inFlight.current;
      const sendLatest = () => void api.saveProject(id, toSendBody(draftRef.current!)).catch(() => undefined);
      if (!draftRef.current) return;
      if (running && running.gen === loadGen.current) {
        // 현재 세대의 저장이 이미 나가 있다. 동시에 보내면 오래된 본문이 나중에 도착해 최신 본문을 덮을 수 있으므로,
        // 그 저장이 끝난 뒤에 그 사이 더 입력한 내용이 있을 때만 이어서 보낸다.
        void running.done.finally(() => {
          if (draftRef.current && version.current > sentOk.current) sendLatest();
        });
      } else if (version.current !== savedVersion.current) {
        sendLatest();
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
    const gen = loadGen.current;
    setSave('saving');
    try {
      const p = await api.saveProject(id, body);
      if (gen === loadGen.current) sentOk.current = Math.max(sentOk.current, sentVersion);
      if (!alive.current || gen !== loadGen.current) return false; // 그 사이 화면을 새로 불러왔다면 이 응답은 지난 화면의 것이다
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
        const saved: SaveBody = { title: p.title, scenes: p.scenes.map((s) => ({ id: s.id, text: s.text, durationSec: s.durationSec })) };
        if (composing.current) pendingSync.current = { version: sentVersion, body: saved };
        else {
          pendingSync.current = null;
          applyServerBody(saved);
        }
      }
      return true;
    } catch (e) {
      if (gen !== loadGen.current) return false; // 새로 불러오기 전에 보낸 요청의 실패는 새 화면의 상태가 아니다
      saveFailedRef.current = true;
      if (alive.current && e instanceof ApiFailure && e.code === 'SCENES_CHANGED') setConflict('changed');
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
    const running = inFlight.current;
    if (running && running.gen === loadGen.current) return running.done;
    if (!draftRef.current || version.current === savedVersion.current) return Promise.resolve(true);
    const gen = loadGen.current;
    const entry: { gen: number; done: Promise<boolean> } = { gen, done: Promise.resolve(true) };
    inFlight.current = entry; // 비동기 본문이 await 없이 끝나도 finally 가 이 항목을 지울 수 있게 먼저 등록한다
    entry.done = (async () => {
      try {
        if (structural.current) await structural.current.catch(() => undefined); // 장면 목록이 바뀌는 중이면 끝난 뒤 새 ID 로 보낸다
        while (alive.current && gen === loadGen.current && version.current !== savedVersion.current) {
          if (!(await send())) return false;
        }
        return true;
      } finally {
        if (inFlight.current === entry) inFlight.current = null;
      }
    })();
    return entry.done;
  }, [send]);

  /**
   * 대기 중인 변경(디바운스 중이거나 전송 중)을 지금 모두 저장하고 끝날 때까지 기다린다.
   * 영상 생성은 서버에 저장된 내용을 기준으로 만들기 때문에, 요청 직전에 반드시 호출한다.
   */
  const saveNow = useCallback(async (): Promise<boolean> => {
    // 줄 서 있는 이미지 업로드·장면 추가·삭제가 끝난 뒤의 상태를 저장한다(끝나기 전에 영상을 요청하면 이전 내용으로 만들어진다).
    await queue.current;
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
        ? { ...prev, status: p.status, updatedAt: p.updatedAt, scenes: mergeImages(prev.scenes, p.scenes) }
        : prev,
    );

  const uploadImage = async (position: number, file: File) => {
    const problem = precheckImage(file);
    if (problem) {
      onToast(problem);
      return;
    }
    const sceneId = draftRef.current!.scenes[position]!.id!;
    const gen = loadGen.current;
    setUploading(sceneId);
    try {
      const p = await enqueueFor(gen, () => api.uploadImage(id, sceneId, file));
      if (p && gen === loadGen.current) applyImages(p);
    } catch (e) {
      if (gen === loadGen.current) onToast(e instanceof Error ? e.message : '이미지를 올리지 못했어요');
    } finally {
      if (alive.current) setUploading((cur) => (cur === sceneId ? null : cur));
    }
  };

  const removeImage = async (position: number) => {
    const sceneId = draftRef.current!.scenes[position]!.id!;
    const gen = loadGen.current;
    try {
      const p = await enqueueFor(gen, () => api.removeImage(id, sceneId));
      if (p && gen === loadGen.current) applyImages(p);
    } catch (e) {
      if (gen === loadGen.current) onToast(e instanceof Error ? e.message : '이미지를 지우지 못했어요');
    }
  };

  /**
   * 장면을 추가·삭제한다. 먼저 대기 중인 변경을 저장하고, 서버가 돌려준 장면 목록을 화면의 draft 에 합친다.
   * 합칠 때 같은 ID 의 장면은 화면(draft)의 문구·길이를 유지한다 — 요청하는 사이에 더 입력한 내용이 사라지지 않게 한다.
   * 성공하면 서버가 돌려준 프로젝트, 실패하면(토스트 표시) null.
   */
  const changeScenes = async (call: () => Promise<Project>): Promise<Project | null> => {
    if (structuralBusy.current || !draftRef.current) return null;
    // 장면 구성을 믿을 수 없는 동안(다른 곳에서 바뀜, 응답이 없어 결과 불명)에는 장면을 바꾸지 않는다. 같은 요청을 다시 보내면 장면이
    // 중복되거나 엉뚱한 장면이 지워진다. 새로 불러와 서버의 실제 구성을 읽으면(load) 풀린다.
    if (conflictRef.current) {
      onToast('장면 구성을 먼저 새로 불러와 주세요');
      return null;
    }
    structuralBusy.current = true;
    setStructuring(true);
    const gen = loadGen.current;
    try {
      return await enqueue(async () => {
        if (gen !== loadGen.current) return null;
        clearTimeout(timer.current);
        if (!(await flush())) {
          onToast('저장하지 못해서 장면을 바꿀 수 없어요. 다시 저장한 뒤 시도해 주세요');
          return null;
        }
        const op = (async () => {
          const p = await call();
          if (gen !== loadGen.current) return null; // 그 사이 화면을 새로 불러왔다
          const cur = draftRef.current!;
          const byId = new Map(cur.scenes.map((s) => [s.id, s]));
          const next: SaveBody = {
            title: cur.title,
            scenes: p.scenes.map((s) => byId.get(s.id) ?? { id: s.id, text: s.text, durationSec: s.durationSec }),
          };
          draftRef.current = next;
          setDraft(next);
          setProject(p);
          return p;
        })();
        structural.current = op;
        try {
          return await op;
        } finally {
          structural.current = null;
        }
      });
    } catch (e) {
      if (gen === loadGen.current) {
        if (e instanceof ApiFailure && e.code === 'NOT_FOUND') setConflict('changed');
        // 응답이 없으면 서버가 장면을 바꿨을 수 있다. 같은 요청을 다시 보내면 장면이 중복되거나 엉뚱한 장면이 지워지므로, 새로 불러오게 한다.
        if (e instanceof ApiFailure && e.code === 'TIMEOUT') setConflict('unknown');
        onToast(e instanceof Error ? e.message : '장면을 바꾸지 못했어요');
      }
      return null;
    } finally {
      structuralBusy.current = false;
      if (alive.current) setStructuring(false);
    }
  };

  /** 맨 뒤에 장면을 추가한다. 성공하면 새 장면의 위치(0부터), 실패하면 null. */
  const addScene = async (): Promise<number | null> => {
    const p = await changeScenes(() => api.addScene(id));
    return p ? p.scenes.length - 1 : null;
  };

  const deleteScene = async (sceneId: string): Promise<boolean> => (await changeScenes(() => api.deleteScene(id, sceneId))) !== null;

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
    addScene, deleteScene, structuring, conflict,
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
