import type { ProjectStatus } from '../shared/types';

export const STATUS: Record<ProjectStatus, { label: string; fg: string; bg: string; dot: string }> = {
  editing: { label: '편집 중', fg: '#4F535C', bg: '#EFF0F3', dot: '#8A8E98' },
  waiting: { label: '생성 대기', fg: '#8A5300', bg: '#FCF1DD', dot: '#D08A16' },
  generating: { label: '생성 중', fg: '#3B3FB0', bg: '#ECECFB', dot: '#4B4FC4' },
  done: { label: '생성 완료', fg: '#1C6E43', bg: '#E2F3E9', dot: '#2E9A5F' },
  failed: { label: '생성 실패', fg: '#AE2330', bg: '#FCE8E9', dot: '#D3404C' },
};

export const ACTION: Record<ProjectStatus, string> = {
  editing: '이어서 편집',
  waiting: '진행 상황',
  generating: '진행 상황',
  done: '결과 보기',
  failed: '오류 확인',
};

const pad = (n: number) => String(n).padStart(2, '0');
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** "오늘 14:20" / "10월 26일 17:05" */
export function formatUpdated(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `오늘 ${hm(d)}` : `${d.getMonth() + 1}월 ${d.getDate()}일 ${hm(d)}`;
}

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
export const needsResultScreen = (s: ProjectStatus) => s !== 'editing';
export const isBusy = (s: ProjectStatus) => s === 'waiting' || s === 'generating';
