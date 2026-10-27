import { describe, expect, it } from 'vitest';
import { inspectImage } from '../server/imageInspect';
import { solidPng } from '../server/solidPng';

describe('solidPng', () => {
  it('1280x720 PNG 로 인식된다', () => {
    const info = inspectImage(solidPng(1280, 720, [10, 20, 30]));
    expect(info).toMatchObject({ ext: 'png', width: 1280, height: 720, mime: 'image/png' });
  });
});
