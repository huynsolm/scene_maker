# 씬 메이커 (scene_maker)

제목과 장면 3개(문구·이미지·길이)를 입력해 짧은 **무음 MP4 안내 영상**을 만드는 웹앱. 단일 사용자, 로컬 개발 환경 기준.

> 현재 **1단계(프로젝트·장면 저장, 이미지 업로드, 목록·편집 화면)** 까지 구현되어 있다.
> 영상 렌더링과 결과 화면은 2~3단계 범위이며, 화면에는 "임시"로 표시되어 있다. 자세한 내용은 [docs/stage1-review.md](docs/stage1-review.md).

## 요구 사항
- Node.js 22 이상
- (2단계부터) ffmpeg 6 이상 — `libx264`, `libass`(subtitles) 포함 빌드

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

환경 변수: `DATA_DIR`(기본 `./data`), `PORT`(3001), `HOST`(127.0.0.1), `WEB_DIST`(`dist/web`).
로그인이 없으므로 기본은 로컬 접속만 허용한다. 외부에 노출하지 말 것.

## 테스트
```bash
npm run typecheck
npm test               # 서버 API·규칙 단위 테스트 (Vitest)
npm run build && npm run test:e2e   # 브라우저 E2E (Playwright, 먼저 build 필요)
```
E2E 는 Chromium 이 필요하다. 처음이면 `npx playwright install chromium`.

## 구조
```
shared/   서버·화면이 함께 쓰는 제한값(limits.ts), 입력 스키마(schemas.ts), 타입
server/   Fastify API, SQLite 저장소(store.ts), 이미지 검증(imageInspect.ts)
web/      React 화면 (screens/), 자동 저장 훅(useProjectEditor.ts), 스타일(styles.css)
tests/    API·규칙 단위 테스트        e2e/  브라우저 테스트
docs/     검수 문서
data/     (git 제외) SQLite DB 와 업로드 이미지
```
