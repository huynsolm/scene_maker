export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PROJECT_BUSY'
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
  ) {
    super(message);
  }
}

export const notFound = (what = '프로젝트') => new AppError('NOT_FOUND', 404, `${what}를 찾을 수 없어요.`);
