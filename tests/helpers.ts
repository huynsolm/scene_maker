import FormData from 'form-data';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuiltApp } from '../server/app';

export async function makeApp(dataDir?: string): Promise<BuiltApp & { dataDir: string }> {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'scene-maker-test-'));
  const built = await buildApp({ dataDir: dir, webDist: null });
  return { ...built, dataDir: dir };
}

export async function upload(
  app: FastifyInstance,
  projectId: string,
  position: number,
  data: Buffer,
  filename = 'photo.png',
  contentType = 'image/png',
) {
  const form = new FormData();
  form.append('file', data, { filename, contentType });
  return app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/scenes/${position}/image`,
    payload: form.getBuffer(),
    headers: form.getHeaders(),
  });
}

/** 헤더만 흉내 낸 최소 JPEG (SOI + JFIF + SOF0). 실제 형식 판별은 시그니처로 하므로 이 정도로 충분하다. */
export function fakeJpeg(width: number, height: number): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    height >> 8, height & 255, width >> 8, width & 255,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ]);
}

/** 최소 WebP (VP8X). */
export function fakeWebp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

export const GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');

export const validSave = (over: Record<string, unknown> = {}) => ({
  title: '제목',
  scenes: [
    { text: '하나', durationSec: 10 },
    { text: '둘', durationSec: 10 },
    { text: '셋', durationSec: 10 },
  ],
  ...over,
});
