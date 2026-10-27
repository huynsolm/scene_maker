import { VIDEO } from '../shared/limits';
import { saveProjectSchema } from '../shared/schemas';
import { loadConfig } from './config';
import { openDb } from './db';
import { solidPng } from './solidPng';
import { Store } from './store';

/** 샘플 프로젝트 "매장 재고 관리 사용법". 이미지는 실제 사진이 아니라 단색 플레이스홀더다. */
export const SAMPLE = {
  title: '매장 재고 관리 사용법',
  scenes: [
    { text: '매장에 우유가 부족한지 확인하기 어려우셨나요?', durationSec: 10, color: [74, 93, 140] as [number, number, number] },
    { text: '재고 화면에서 현재 수량과 부족한 품목을 확인하세요.', durationSec: 10, color: [64, 120, 104] as [number, number, number] },
    { text: '발주 목록에 추가하고 입고 수량을 기록해 보세요.', durationSec: 10, color: [140, 98, 64] as [number, number, number] },
  ],
};

export function createSampleProject(store: Store) {
  const project = store.createProject({ title: SAMPLE.title, isSample: true });
  store.saveProject(
    project.id,
    saveProjectSchema.parse({
      title: SAMPLE.title,
      scenes: SAMPLE.scenes.map(({ text, durationSec }) => ({ text, durationSec })),
    }),
  );
  SAMPLE.scenes.forEach((s, i) => {
    const png = solidPng(VIDEO.width, VIDEO.height, s.color);
    store.attachImage(project.id, i, png, `샘플 이미지 ${i + 1}.png`, { isSample: true });
  });
  return store.getProject(project.id);
}

// `npm run seed:sample` 로 직접 실행했을 때만 동작한다.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const store = new Store(openDb(config.dataDir), config.dataDir);
  const p = createSampleProject(store);
  console.log(`샘플 프로젝트를 만들었어요: ${p.title} (${p.id})`);
}
