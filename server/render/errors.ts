export type RenderErrorCode =
  | 'IMAGE_DECODE_FAILED'
  | 'FFMPEG_NOT_FOUND'
  | 'FONT_MISSING'
  | 'RENDER_FAILED'
  | 'RENDER_TIMEOUT'
  | 'OUTPUT_INVALID'
  | 'SERVER_RESTARTED'
  | 'INTERNAL';

/** 화면의 실패 박스에 그대로 보여줄 수 있는 형태(제목·해결 방법)와 개발자용 상세를 함께 가진다. */
export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    readonly title: string,
    readonly body: string,
    readonly detail?: string,
    /** 문제가 된 장면 번호(1부터). 화면이 해당 장면 편집으로 바로 안내하는 데 쓴다. */
    readonly sceneNo?: number,
  ) {
    super(title);
  }
}

export const imageDecodeFailed = (sceneNo: number, detail?: string) =>
  new RenderError(
    'IMAGE_DECODE_FAILED',
    `장면 ${sceneNo} 이미지를 읽을 수 없어요`,
    `파일이 손상됐거나 지원하지 않는 형식일 수 있어요. 장면 ${sceneNo} 이미지를 JPG나 PNG로 다시 올린 뒤 시도해 주세요.`,
    detail,
    sceneNo,
  );

export const serverRestarted = () =>
  new RenderError(
    'SERVER_RESTARTED',
    '서버가 다시 시작되어 생성이 중단됐어요',
    '입력한 내용과 이미지는 그대로 저장되어 있어요. 다시 시도해 주세요.',
  );

export function toRenderError(e: unknown): RenderError {
  if (e instanceof RenderError) return e;
  return new RenderError(
    'INTERNAL',
    '영상을 만드는 중에 문제가 생겼어요',
    '잠시 후 다시 시도해 주세요. 입력한 내용은 그대로 저장되어 있어요.',
    e instanceof Error ? (e.stack ?? e.message) : String(e),
  );
}
