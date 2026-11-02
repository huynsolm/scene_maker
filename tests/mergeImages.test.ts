import { describe, expect, it } from 'vitest';
import { mergeImages } from '../web/mergeImages';

const img = (id: string) => ({ id, fileName: id, url: `/${id}`, width: 1, height: 1, isSample: false });
const scene = (id: string, image: ReturnType<typeof img> | null = null) => ({ id, image });

describe('mergeImages (서버 응답의 이미지를 장면 ID 로 합친다)', () => {
  it('화면 [A,B,C] 에서 서버가 A 를 지우고 B 에 업로드한 응답([B,C])을 받아도 B 에는 B 의 이미지가 붙는다(검수 반례)', () => {
    const current = [scene('A'), scene('B'), scene('C', img('cImg'))];
    const server = [scene('B', img('bImg')), scene('C', img('cImg'))];
    const merged = mergeImages(current, server);
    expect(merged.map((s) => [s.id, s.image?.id ?? null])).toEqual([['A', null], ['B', 'bImg'], ['C', 'cImg']]);
  });

  it('서버 응답에 있는 이미지 삭제(null)는 반영하고, 응답에 없는 장면은 그대로 둔다', () => {
    const current = [scene('A', img('a')), scene('B', img('b'))];
    const merged = mergeImages(current, [scene('B', null)]);
    expect(merged.map((s) => [s.id, s.image?.id ?? null])).toEqual([['A', 'a'], ['B', null]]);
  });

  it('장면의 다른 필드는 건드리지 않는다', () => {
    const current = [{ id: 'A', image: null, text: '그대로' }];
    expect(mergeImages(current, [scene('A', img('x'))])[0]).toMatchObject({ text: '그대로', image: { id: 'x' } });
  });
});
