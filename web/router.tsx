import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';

// 화면이 3개뿐이라 라우터 라이브러리 없이 History API 만 쓴다.
export function navigate(path: string) {
  if (path === window.location.pathname) return;
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const on = () => setPath(window.location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path;
}

export function Link({ to, children, className, style }: { to: string; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} style={style}>
      {children}
    </a>
  );
}
