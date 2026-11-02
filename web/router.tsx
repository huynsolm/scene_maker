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

export function Link({
  to,
  children,
  className,
  style,
  beforeNavigate,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** 이동 전에 할 일(예: 저장). false 를 돌려주면 이동하지 않는다. 새 탭으로 여는 클릭에는 쓰이지 않는다. */
  beforeNavigate?: () => Promise<boolean> | boolean;
}) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!beforeNavigate) return navigate(to);
    void Promise.resolve(beforeNavigate()).then((ok) => ok && navigate(to));
  };
  return (
    <a href={to} onClick={onClick} className={className} style={style}>
      {children}
    </a>
  );
}
