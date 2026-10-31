export type ProjectStatus = 'editing' | 'waiting' | 'generating' | 'done' | 'failed';

export interface SceneImage {
  id: string;
  fileName: string;
  url: string;
  width: number;
  height: number;
  isSample: boolean;
}

export interface Scene {
  position: number; // 0..2
  text: string;
  durationSec: number;
  image: SceneImage | null;
}

export interface Project {
  id: string;
  title: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  scenes: Scene[];
  isSample: boolean;
  /** 가장 최근에 완성된 영상(없으면 null). 편집 중으로 돌아간 프로젝트도 이전 영상을 볼 수 있게 한다. */
  lastVideo: { jobId: string; finishedAt: string } | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
  status: ProjectStatus;
  updatedAt: string;
  totalSec: number;
  thumbnailUrl: string | null;
  isSample: boolean;
}

export interface ApiError {
  error: { code: string; message: string };
}

export type JobStatus = 'waiting' | 'generating' | 'done' | 'failed';

export interface RenderJobView {
  id: string;
  projectId: string;
  status: JobStatus;
  /** 단계 목록에서 지금 진행 중인 항목 번호: 0 요청 접수 · 1 대기열 · 2 장면 화면 만들기 · 3 MP4 저장 */
  step: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; title: string; body: string; /** 문제가 된 장면 번호(1부터), 없으면 null */ scene: number | null; at: string } | null;
  videoUrl: string | null;
  downloadUrl: string | null;
  /** 요청한 뒤에 프로젝트 내용이 고쳐졌으면 true — 이 작업(영상)은 현재 편집 내용보다 이전 버전이다. */
  outdated: boolean;
  /** 요청 시점의 내용. 이후에 편집해도 바뀌지 않는다. */
  snapshot: {
    title: string;
    totalSec: number;
    scenes: Array<{ position: number; text: string; durationSec: number; imageUrl: string; imageFileName: string }>;
  };
  output: { width: number; height: number; fps: number } | null;
}
