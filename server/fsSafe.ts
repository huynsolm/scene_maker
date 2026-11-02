import fs from 'node:fs';

/**
 * DB 에 이미 반영한 뒤의 파일 삭제는 실패해도 요청 전체를 실패시키지 않는다(기록은 이미 사라졌다).
 * 실패한 경로와 오류 코드를 로그로 남기고 계속 진행하며, 남은 파일은 다음 서버 시작 때 정리가 다시 시도한다.
 * 잡는 것은 파일 시스템 오류뿐이다. 호출하는 쪽의 DB 오류는 이 함수와 무관하게 그대로 전파된다.
 * `force` 는 "없는 파일"만 무시하므로, 잠금(EBUSY)·권한(EPERM, EACCES) 오류는 여기서 잡는다.
 */
export function safeRm(target: string, opts: { recursive?: boolean } = {}): boolean {
  try {
    fs.rmSync(target, { force: true, recursive: opts.recursive ?? false });
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    console.warn(`[정리 실패] ${target} (${code}) — 다음 서버 시작 때 다시 정리한다`);
    return false;
  }
}

/** 비어 있으면 빈 폴더를 지운다. 비어 있지 않거나 실패하면 조용히 둔다. */
export function rmdirIfEmpty(dir: string): void {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    /* 다른 곳에서 막 쓰기 시작했거나 잠겨 있으면 그대로 둔다 */
  }
}
