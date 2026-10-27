import { z } from 'zod';
import {
  DURATION_MAX_SEC,
  DURATION_MIN_SEC,
  SCENE_COUNT,
  TEXT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from './limits';

export const sceneInputSchema = z.object({
  text: z.string().max(TEXT_MAX_LENGTH),
  durationSec: z.number().int().min(DURATION_MIN_SEC).max(DURATION_MAX_SEC),
});

/** 자동 저장 본문. 이미지는 별도 엔드포인트로 올리므로 여기에 포함하지 않는다. */
export const saveProjectSchema = z.object({
  title: z.string().max(TITLE_MAX_LENGTH),
  scenes: z.array(sceneInputSchema).length(SCENE_COUNT),
});

export type SaveProjectInput = z.infer<typeof saveProjectSchema>;
