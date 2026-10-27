export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PROJECT_BUSY'
  | 'RENDER_INCOMPLETE'
  | 'RENDER_IN_PROGRESS'
  | 'IMAGE_MISSING_FILE'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_UNSUPPORTED_TYPE'
  | 'IMAGE_DIMENSIONS_TOO_LARGE'
  | 'IMAGE_INVALID'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    /** 응답의 error 객체에 그대로 합쳐지는 추가 정보(예: 이미 진행 중인 작업) */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = '프로젝트') => new AppError('NOT_FOUND', 404, `${what}를 찾을 수 없어요.`);
