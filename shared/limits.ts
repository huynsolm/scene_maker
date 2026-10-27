// 서버와 화면이 같은 규칙을 쓰도록 한 곳에 둔다. 사용자 결정 사항(1단계 계획 승인)을 그대로 옮긴 값이다.

export const SCENE_COUNT = 3;
export const DEFAULT_TOTAL_SEC = 30;

export const DURATION_MIN_SEC = 3;
export const DURATION_MAX_SEC = 30;
export const DURATION_DEFAULT_SEC = 10;
export const DURATION_QUICK_PICKS = [5, 10, 15] as const;

export const TITLE_MAX_LENGTH = 100;
/** 화면에서 안내하는 권장 글자 수. 넘어도 저장은 된다. */
export const TEXT_RECOMMENDED_LENGTH = 40;
/** 서버가 거부하는 글자 수 상한. */
export const TEXT_MAX_LENGTH = 200;

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_SIDE_PX = 4096;
export const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;
export type ImageExt = keyof typeof IMAGE_TYPES;
export const IMAGE_ACCEPT = Object.values(IMAGE_TYPES).join(',');
export const IMAGE_LABEL = 'JPG · PNG · WebP';

/** 출력 영상 규격(2단계 렌더링에서 사용). 세로형은 범위 밖. */
export const VIDEO = { width: 1280, height: 720, fps: 30 } as const;

/**
 * 자막 배치. 화면 미리보기와 렌더러가 같은 값을 읽는다.
 * 모두 프레임 너비/높이에 대한 비율이다. 미리보기와 실제 출력이 완전히 같다고 가정하지 않으며,
 * 2단계에서 출력 프레임과 비교해 차이를 보고한다.
 */
export const SUBTITLE = {
  sideMarginPct: 10,
  bottomMarginPct: 11,
  fontSizeWidthPct: 3.2,
  lineHeight: 1.45,
  /** 박스 안쪽 여백과 모서리 반지름. 프레임 너비에 대한 % (미리보기 CSS 의 cqw 와 같은 값) */
  padXWidthPct: 1.8,
  padYWidthPct: 0.9,
  radiusWidthPct: 0.6,
  background: 'rgba(18,19,24,.74)',
  color: '#FFFFFF',
} as const;
