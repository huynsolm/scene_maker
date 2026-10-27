import type { Project, ProjectSummary, RenderJobView } from '../shared/types';

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

async function request<T>(method: string, url: string, body?: BodyInit | object): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
    });
  } catch {
    throw new ApiFailure('NETWORK', '서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.', 0);
  }
  if (res.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* 본문이 JSON 이 아닌 경우 아래에서 일반 오류로 처리 */
  }
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
  scenes: Array<{ text: string; durationSec: number }>;
}

export const api = {
  listProjects: () => request<{ projects: ProjectSummary[] }>('GET', '/api/projects').then((r) => r.projects),
  createProject: () => request<{ project: Project }>('POST', '/api/projects').then((r) => r.project),
  getProject: (id: string) => request<{ project: Project }>('GET', `/api/projects/${id}`).then((r) => r.project),
  saveProject: (id: string, body: SaveBody) =>
    request<{ project: Project }>('PUT', `/api/projects/${id}`, body).then((r) => r.project),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${id}`),
  createRender: (id: string) => request<{ job: RenderJobView }>('POST', `/api/projects/${id}/renders`).then((r) => r.job),
  latestRender: (id: string) =>
    request<{ job: RenderJobView | null }>('GET', `/api/projects/${id}/renders/latest`).then((r) => r.job),
  uploadImage: (id: string, position: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ project: Project }>('POST', `/api/projects/${id}/scenes/${position}/image`, form).then(
      (r) => r.project,
    );
  },
  removeImage: (id: string, position: number) =>
    request<{ project: Project }>('DELETE', `/api/projects/${id}/scenes/${position}/image`).then((r) => r.project),
};
