import { z } from 'zod';
import {
  DURATION_MAX_SEC,
  DURATION_MIN_SEC,
  SCENE_COUNT,
  TEXT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from './limits';

/** NFC 로 합친 뒤 글자 수를 센다(분해된 한글 자모는 글자당 2~3 칸이라 한도를 일찍 넘기고, 영상 측정도 틀어진다). */
const nfcString = (max: number) =>
  z
    .string()
    .transform((s) => s.normalize('NFC'))
    .pipe(z.string().max(max));

export const sceneInputSchema = z.object({
  text: nfcString(TEXT_MAX_LENGTH),
  durationSec: z.number().int().min(DURATION_MIN_SEC).max(DURATION_MAX_SEC),
});

/** 자동 저장 본문. 이미지는 별도 엔드포인트로 올리므로 여기에 포함하지 않는다. */
export const saveProjectSchema = z.object({
  title: nfcString(TITLE_MAX_LENGTH),
  scenes: z.array(sceneInputSchema).length(SCENE_COUNT),
});

export type SaveProjectInput = z.infer<typeof saveProjectSchema>;
