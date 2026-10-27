import { useCallback, useEffect, useRef, useState } from 'react';

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((msg: string) => {
    clearTimeout(timer.current);
    setMessage(msg);
    timer.current = setTimeout(() => setMessage(null), 2400);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = message ? (
    <div className="toast" role="status">
      {message}
    </div>
  ) : null;
  return { show, node };
}
