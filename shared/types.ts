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
