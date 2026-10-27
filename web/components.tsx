import { useEffect, useRef, type ReactNode } from 'react';
import type { ProjectStatus } from '../shared/types';
import { STATUS } from './format';

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const s = STATUS[status];
  return (
    <span className="badge" style={{ background: s.bg, color: s.fg }}>
      <i style={{ background: s.dot }} />
      {s.label}
    </span>
  );
}

export function SampleTag() {
  return (
    <span className="sample-tag" title="실제 이미지가 아니라 단색 샘플이에요">
      샘플
    </span>
  );
}

export function Modal({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    // 열릴 때 안전한 쪽(취소/닫기)으로 포커스를 둔다.
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function CenterMessage({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="center-msg">
      <h2 style={{ fontSize: 20, fontWeight: 700 }}>{title}</h2>
      {body && <p style={{ color: 'var(--text-2)' }}>{body}</p>}
      {children}
    </div>
  );
}
