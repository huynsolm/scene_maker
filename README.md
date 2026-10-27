# 씬 메이커 (scene_maker)

제목과 장면 3개(문구·이미지·길이)를 입력해 짧은 **무음 MP4 안내 영상**(1280×720, 30fps)을 만드는 웹앱. 단일 사용자, 로컬 개발 환경 기준.

> 진행 상황: 1~3단계 구현 완료(저장·이미지 업로드·편집 → ffmpeg 렌더링·상태 관리·재시작 복구 → 결과 화면·실패 복구·전체 흐름 점검).
> 검수 문서: [1단계](docs/stage1-review.md) · [2단계](docs/stage2-review.md) · [3단계](docs/stage3-review.md) · [미리보기↔영상 비교](docs/frame-comparison.md)

## 요구 사항
- **Node.js 22.x** (`.nvmrc`). 다른 버전에서는 `.npmrc` 의 `engine-strict` 때문에 `npm install`/`npm ci` 가 설치 초기에 중단된다.
- **ffmpeg / ffprobe 6 이상** (`libx264`, `libass` 포함 빌드). 없으면 영상 생성이 `FFMPEG_NOT_FOUND` 로 실패한다.

## 실행
```bash
npm install
npm run dev            # 서버(3001) + 화면(5173). http://localhost:5173
```

빌드해서 한 프로세스로 실행:
```bash
npm run build
npm start              # http://127.0.0.1:3001 (API + 빌드된 화면)
```

샘플 프로젝트 "매장 재고 관리 사용법"(단색 플레이스홀더 이미지, 화면에 "샘플"로 표시):
```bash
npm run seed:sample
```

환경 변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `DATA_DIR` | `./data` | SQLite DB, 업로드 이미지, 완성 영상, 임시 작업 폴더 |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | 로그인이 없으므로 기본은 로컬 접속만 허용. 외부에 노출하지 말 것 |
| `WEB_DIST` | `dist/web` | 빌드된 화면 위치 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | 실행 파일 위치 |
| `FONTS_DIR` | 저장소의 `fonts/` | 자막 글꼴 폴더 |
| `RENDER_TIMEOUT_MS` | `600000` | ffmpeg 한 번 실행의 제한 시간 |

## 테스트
```bash
npm run typecheck
npm test                # 단위·API·실제 ffmpeg 테스트 78개 (Vitest). ffmpeg 가 없으면 ffmpeg 테스트는 건너뜀
npm run build && npm run test:e2e   # 브라우저 E2E 27개 (Playwright). 먼저 build 필요. 전체 흐름·결과 화면·미리보기↔영상 자막 일치 포함
npm run build && npm run compare:frame -- --out report.md   # 미리보기↔영상 자막 차이 측정
```
E2E 와 비교 스크립트는 Chromium 이 필요하다. 처음이면 `npx playwright install chromium`.
`compare:frame` 에 `--pretendard <PretendardVariable.ttf>` 를 주면 Pretendard 로 미리보기를 렌더한 결과도 함께 잰다.

## 구조
```
shared/   서버·화면이 함께 쓰는 제한값(limits.ts), 입력 스키마(schemas.ts), 타입
server/   Fastify API, SQLite 저장소(store.ts, renderStore.ts), 작업 큐(renderQueue.ts)
  render/ ffmpeg 렌더러, 자막 레이아웃·ASS 생성, 오류 분류
web/      React 화면 (screens/), 자동 저장 훅(useProjectEditor.ts), 스타일(styles.css)
fonts/    영상 자막 글꼴(Noto Sans KR SemiBold) + OFL 라이선스 전문 + 출처
  web/public/fonts/  같은 글꼴의 웹용 부분집합(미리보기 자막용, scripts/make-web-font.py)
scripts/  미리보기↔영상 비교
tests/    API·렌더·규칙 테스트        e2e/  브라우저 테스트
docs/     검수 문서
data/     (git 제외) SQLite DB, 업로드 이미지, 완성 영상
```
