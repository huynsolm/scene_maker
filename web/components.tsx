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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 대화 상자. 열리면 안전한 쪽(취소/닫기, `data-autofocus`)에 초점을 두고, Tab 이 상자 안에서만 돌게 하며,
 * 닫히면 열기 전에 초점이 있던 요소로 돌려놓는다. Esc 로 닫는다.
 */
export function Modal({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // onClose 는 부모가 렌더할 때마다 새 함수일 수 있다. 열고 닫는 동작(초점 이동·복귀)이 렌더마다 다시 실행되지 않게 ref 로 읽는다.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current;
    (box?.querySelector<HTMLElement>('[data-autofocus]') ?? box?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!box.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', on);
    return () => {
      window.removeEventListener('keydown', on);
      // 열기 전의 요소가 아직 화면에 있고 쓸 수 있으면 거기로 돌아간다(없으면 브라우저 기본 동작에 맡긴다).
      if (opener && document.contains(opener) && !(opener as HTMLButtonElement).disabled) opener.focus();
    };
  }, []);
  return (
    <div className="overlay" onClick={() => closeRef.current()}>
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
