import type { Scene } from '../shared/types';

/**
 * 서버 응답의 이미지를 화면의 장면 목록에 **장면 ID 로** 합친다. 배열 위치로 합치면, 다른 요청이 앞 장면을 지운 뒤의
 * 응답이 화면의 다른 장면에 붙는다(화면 [A,B,C], 서버 [B,C] → 화면의 B 에 C 의 이미지가 표시됨).
 * 서버 응답에 없는 장면(다른 곳에서 지워진 장면)은 그대로 둔다 — 장면 구성이 바뀐 화면의 복구는 저장 409 처리의 몫이다.
 */
export function mergeImages<T extends Pick<Scene, 'id' | 'image'>>(current: T[], server: Array<Pick<Scene, 'id' | 'image'>>): T[] {
  const byId = new Map(server.map((s) => [s.id, s.image]));
  return current.map((s) => (byId.has(s.id) ? { ...s, image: byId.get(s.id) ?? null } : s));
}
