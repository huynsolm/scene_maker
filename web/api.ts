import type { Project, ProjectSummary, RenderJobView, RenderList } from '../shared/types';

export class ApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** 서버가 error 객체에 실어 보낸 추가 정보(예: 이미 진행 중인 작업, 비어 있는 항목) */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 요청 한 번의 제한 시간(밀리초). 일반 요청은 모두 빠른 요청이다(영상 만들기는 접수만 하고 바로 돌려준다). */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 이미지 업로드는 파일이 클수록 오래 걸리므로 크기에 비례해 늘린다(10MB 면 160초 — 초당 약 0.5Mbps 까지 견딘다). */
const UPLOAD_BASE_MS = 60_000;
const UPLOAD_PER_MB_MS = 10_000;
export const uploadTimeoutMs = (bytes: number) => UPLOAD_BASE_MS + Math.ceil(bytes / (1024 * 1024)) * UPLOAD_PER_MB_MS;

/** 진단·테스트용: `window.__SM_TIMEOUT_MS` 가 숫자면 모든 요청의 제한 시간을 그 값으로 바꾼다. */
function effectiveTimeout(ms: number): number {
  const o = (globalThis as { __SM_TIMEOUT_MS?: unknown }).__SM_TIMEOUT_MS;
  return typeof o === 'number' && o > 0 ? o : ms;
}

async function request<T>(method: string, url: string, body?: BodyInit | object, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const isForm = body instanceof FormData;
  const ctrl = new AbortController();
  let timedOut = false;
  // 응답 본문을 다 읽을 때까지 포함한 제한 시간이다. 서버가 응답하지 않으면 요청이 영영 끝나지 않아, 줄 서 있는 작업과
  // "불러오는 중…"이 멈춘다.
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, effectiveTimeout(timeoutMs));
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
        signal: ctrl.signal,
      });
    } catch {
      if (timedOut) throw timeoutFailure();
      throw new ApiFailure('NETWORK', '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.', 0);
    }
    if (res.status === 204) return undefined as T;
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      if (timedOut) throw timeoutFailure();
      /* 본문이 JSON 이 아닌 경우 아래에서 일반 오류로 처리 */
    }
    return unwrap<T>(res, data);
  } finally {
    clearTimeout(timer);
  }
}

/** 서버가 처리했는지는 알 수 없다(요청은 닿았을 수 있다). 호출하는 쪽이 결과를 모르는 채로 이어 가지 않게 코드로 구분한다. */
const timeoutFailure = () =>
  new ApiFailure('TIMEOUT', '서버 응답이 너무 늦어요. 처리됐는지 알 수 없으니 연결을 확인하고 새로 불러와 확인해 주세요.', 0);

function unwrap<T>(res: Response, data: any): T {
  if (!res.ok) {
    throw new ApiFailure(
      data?.error?.code ?? 'UNKNOWN',
      data?.error?.message ?? '문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
      res.status,
      data?.error ?? {},
    );
  }
  return data as T;
}

export interface SaveBody {
  title: string;
  /** id 는 서버의 장면 ID. 보내면 서버의 현재 장면 구성과 같을 때만 저장된다. */
  scenes: Array<{ id?: string; text: string; durationSec: number }>;
}

export const api = {
  listProjects: () => request<{ projects: ProjectSummary[] }>('GET', '/api/projects').then((r) => r.projects),
  createProject: () => request<{ project: Project }>('POST', '/api/projects').then((r) => r.project),
  getProject: (id: string) => request<{ project: Project }>('GET', `/api/projects/${id}`).then((r) => r.project),
  saveProject: (id: string, body: SaveBody) =>
    request<{ project: Project }>('PUT', `/api/projects/${id}`, body).then((r) => r.project),
  addScene: (id: string) => request<{ project: Project }>('POST', `/api/projects/${id}/scenes`).then((r) => r.project),
  deleteScene: (id: string, sceneId: string) =>
    request<{ project: Project }>('DELETE', `/api/projects/${id}/scenes/${sceneId}`).then((r) => r.project),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
  createRender: (id: string) => request<{ job: RenderJobView }>('POST', `/api/projects/${id}/renders`).then((r) => r.job),
  /** 프로젝트 소속이 맞는 작업만 돌려준다(다른 프로젝트의 작업 ID 면 404). */
  getRender: (projectId: string, jobId: string) =>
    request<{ job: RenderJobView }>('GET', `/api/projects/${projectId}/renders/${jobId}`).then((r) => r.job),
  latestRender: (id: string) =>
    request<{ job: RenderJobView | null }>('GET', `/api/projects/${id}/renders/latest`).then((r) => r.job),
  /** 완성된 지난 영상 목록(최신순). `before` 는 직전 페이지 마지막 항목의 id. 기준 항목이 이미 지워졌으면 404. */
  listRenders: (id: string, before?: string) =>
    request<{ list: RenderList }>('GET', `/api/projects/${id}/renders?limit=10${before ? `&before=${before}` : ''}`).then((r) => r.list),
  /** 완성된 영상 하나를 지운다. 응답은 갱신된 목록의 앞 `keep`개(서버가 삭제와 같은 동기 처리 안에서 읽어 일관된다). */
  deleteRender: (projectId: string, jobId: string, keep = 10) =>
    request<{ list: RenderList; lastVideo: Project['lastVideo'] }>('DELETE', `/api/projects/${projectId}/renders/${jobId}?keep=${keep}`),
  uploadImage: (id: string, sceneId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ project: Project }>('POST', `/api/projects/${id}/scenes/${sceneId}/image`, form, uploadTimeoutMs(file.size)).then(
      (r) => r.project,
    );
  },
  removeImage: (id: string, sceneId: string) =>
    request<{ project: Project }>('DELETE', `/api/projects/${id}/scenes/${sceneId}/image`).then((r) => r.project),
};
