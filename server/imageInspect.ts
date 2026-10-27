import { imageSize } from 'image-size';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE_PX,
  IMAGE_TYPES,
  type ImageExt,
} from '../shared/limits';
import { AppError } from './errors';

export interface InspectedImage {
  ext: ImageExt;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * 업로드된 바이트를 직접 읽어 실제 형식과 크기를 확인한다.
 * 클라이언트가 보낸 확장자와 Content-Type 은 신뢰하지 않고, 파일 머리의 시그니처만 본다.
 */
export function inspectImage(buf: Buffer): InspectedImage {
  if (buf.length === 0) {
    throw new AppError('IMAGE_INVALID', 400, '빈 파일이에요. 다른 이미지를 선택해 주세요.');
  }
  if (buf.length > IMAGE_MAX_BYTES) {
    throw new AppError('IMAGE_TOO_LARGE', 413, '이미지는 10MB 이하만 올릴 수 있어요.');
  }

  let info: ReturnType<typeof imageSize>;
  try {
    info = imageSize(buf);
  } catch {
    throw new AppError(
      'IMAGE_UNSUPPORTED_TYPE',
      415,
      'JPG, PNG, WebP 이미지만 올릴 수 있어요.',
    );
  }

  const ext = info.type as string | undefined;
  if (!ext || !(ext in IMAGE_TYPES)) {
    throw new AppError(
      'IMAGE_UNSUPPORTED_TYPE',
      415,
      'JPG, PNG, WebP 이미지만 올릴 수 있어요.',
    );
  }

  const { width, height } = info;
  if (!width || !height || width < 1 || height < 1) {
    throw new AppError('IMAGE_INVALID', 400, '이미지를 읽을 수 없어요. 다른 파일로 올려 주세요.');
  }
  if (width > IMAGE_MAX_SIDE_PX || height > IMAGE_MAX_SIDE_PX) {
    throw new AppError(
      'IMAGE_DIMENSIONS_TOO_LARGE',
      413,
      `이미지가 너무 커요. 가로와 세로 모두 ${IMAGE_MAX_SIDE_PX}px 이하로 줄여 주세요.`,
    );
  }

  return {
    ext: ext as ImageExt,
    mime: IMAGE_TYPES[ext as ImageExt],
    width,
    height,
    sizeBytes: buf.length,
  };
}

/** 화면에 보여줄 이름만 남긴다. 경로 구분자와 제어 문자를 제거하고 길이를 제한한다. */
export function sanitizeDisplayName(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .trim();
  const limited = Array.from(cleaned).slice(0, 100).join('');
  return limited || '이미지';
}
