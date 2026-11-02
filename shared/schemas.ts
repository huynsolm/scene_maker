import { z } from 'zod';
import { cleanText, cleanTitle } from './text';
import {
  DURATION_MAX_SEC,
  DURATION_MIN_SEC,
  SCENE_COUNT,
  TEXT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from './limits';

/**
 * 저장 경계에서 문구·제목을 정리한 뒤 글자 수를 센다(shared/text.ts).
 * 영상에서 제거될 보이지 않는 문자나 분해된 한글 자모가 글자 수 한도를 차지하지 않게 하고,
 * DB·미리보기·영상이 같은 글자를 보게 한다.
 */
const cleanedString = (max: number, clean: (s: string) => string) => z.string().transform(clean).pipe(z.string().max(max));

export const sceneInputSchema = z.object({
  text: cleanedString(TEXT_MAX_LENGTH, cleanText),
  durationSec: z.number().int().min(DURATION_MIN_SEC).max(DURATION_MAX_SEC),
});

/** 자동 저장 본문. 이미지는 별도 엔드포인트로 올리므로 여기에 포함하지 않는다. */
export const saveProjectSchema = z.object({
  title: cleanedString(TITLE_MAX_LENGTH, cleanTitle),
  scenes: z.array(sceneInputSchema).length(SCENE_COUNT),
});

export type SaveProjectInput = z.infer<typeof saveProjectSchema>;
