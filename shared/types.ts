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
  error: { code: string; title: string; body: string; at: string } | null;
  videoUrl: string | null;
  downloadUrl: string | null;
  /** 요청 시점의 내용. 이후에 편집해도 바뀌지 않는다. */
  snapshot: {
    title: string;
    totalSec: number;
    scenes: Array<{ position: number; text: string; durationSec: number; imageUrl: string; imageFileName: string }>;
  };
  output: { width: number; height: number; fps: number } | null;
}
