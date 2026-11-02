# 2단계 구현 보고 · Codex 검수용

> 이 문서는 2단계 시점의 기록이다. 문서 끝 "결정이 필요한 사항" 3건은 3단계에서 결정·반영되었다(자막 미리보기 글꼴은 Noto Sans KR 로 변경, 박스 폭 규칙 유지, 마지막 생성 영상 보기 추가). [stage3-review.md](stage3-review.md) 참고.

범위: 무음 MP4 렌더링, 렌더 작업 상태 관리(요청/조회 분리, 중복 방지, 스냅샷, 재시작 복구), 한글 글꼴 관리, 미리보기↔영상 차이 측정.
결과 화면 디자인 적용과 전체 흐름 점검은 3단계다. 1단계 내용은 [stage1-review.md](stage1-review.md).

## 1. 결정 사항 반영

| 결정 | 구현 |
|---|---|
| ffmpeg 직접 호출 | `server/render/renderer.ts` 가 ffmpeg/ffprobe 를 `spawn` 한다(셸 없음, 인자 배열). 이미지당 디코딩 확인 1회 + 인코딩 1회 + ffprobe 검증 |
| 1280×720, 30fps, 무음 | `-an -r 30 -c:v libx264 -pix_fmt yuv420p`, 장면 이미지는 cover(`scale…increase,crop`). 결과를 ffprobe 로 확인해 해상도·소리 트랙·길이(±0.5초)가 다르면 `OUTPUT_INVALID` |
| 미리보기와 영상이 같다고 가정하지 않음 | `scripts/compare-frame.ts` 로 같은 샘플의 영상 프레임과 미리보기 캡처를 같은 픽셀 분석으로 비교 → [frame-comparison.md](frame-comparison.md) |
| Noto Sans KR + 라이선스 전문 | `fonts/NotoSansKR-SemiBold.ttf`, `fonts/OFL.txt`, 출처·변환 방법·원본 SHA-256 은 `fonts/README.md`. 실제 영상에서 한글 출력 확인(아래 4) |
| 재시작 시 진행 중 작업은 실패, 사용자가 재시도 | 서버 시작 때 `waiting`/`generating` 전부 `failed(SERVER_RESTARTED)`. **자동 재실행 없음**(테스트로 확인). 임시 파일만 정리하고 입력·이미지는 보존 |
| 완성 영상 자동 삭제 없음 | 영상은 프로젝트 삭제 때만 지운다(1단계의 확인 모달 문구 그대로) |

## 2. API

| 메서드 · 경로 | 설명 |
|---|---|
| `POST /api/projects/:id/renders` | 요청 접수만 하고 **202** 로 즉시 반환. 빈 제목·문구·이미지가 있으면 **422** `RENDER_INCOMPLETE`(+`missing` 목록), 진행 중이면 **409** `RENDER_IN_PROGRESS`(+기존 `job`) |
| `GET /api/renders/:id` | 작업 상태 조회 (`status`, `step`, `error`, `videoUrl`, 요청 시점 `snapshot`) |
| `GET /api/projects/:id/renders/latest` | 프로젝트의 가장 최근 작업(없으면 `null`) |
| `GET /api/renders/:id/video[?download=1]` | MP4. `Range` 지원(206/416), `download=1` 이면 제목 기반 안전한 파일명으로 `attachment` |

요청과 조회가 분리되어 있어 화면을 닫아도 작업은 계속되고, 화면은 1.5초마다 조회(폴링)한다. 남은 시간·퍼센트는 만들어 내지 않는다(`step` 은 단계 목록의 활성 항목 번호일 뿐).

## 3. 상태 모델

작업(`render_jobs.status`): `waiting → generating → done | failed`. 프로젝트(`projects.status`)는 작업을 따라가되 아래 규칙이 있다.

| 사건 | 프로젝트 상태 |
|---|---|
| 요청 접수 | `waiting` (updated_at 은 건드리지 않음 — "내용을 고친 시각"이므로) |
| 작업 시작 | `generating` |
| 작업 종료, **요청 이후 내용을 고치지 않음** | `done` / `failed` |
| 작업 종료, **요청 이후(생성 중) 내용을 고침** | `editing` (영상은 이전 버전이라는 뜻. 작업 기록은 `done` 으로 남음) |
| 완료/실패 뒤 편집 | `editing` (1단계 규칙) |
| 생성 중 편집 | 상태 유지 (편집 화면에 안내 배너) |

판정은 `projects.updated_at > render_jobs.created_at`(`RenderStore.finish`). 두 값이 같은 밀리초면 "고치지 않음"으로 본다.

## 4. 중요한 설계 결정 (검수 포인트)

### A. 중복 생성 방지 — 3겹
1. **화면**: 시작/재시도/새 영상 버튼은 `useRef` 로 **같은 틱의 두 번째 클릭**까지 막는다. (`useState` 만 쓰면 아직 갱신되지 않은 값을 읽어 요청이 2번 나간다. E2E 가 같은 틱 더블클릭으로 확인하고, 이 보호를 되돌리면 실패하는 것도 확인했다.)
2. **서버**: 진행 중이면 409 로 기존 작업을 돌려준다.
3. **DB**: `render_jobs` 의 부분 유니크 인덱스(`project_id` WHERE 진행 중)가 최종 보장. 서버 코드에 사전 조회는 두지 않았다(경쟁 상태를 인덱스가 단일 진실로 처리). 인덱스를 일반 인덱스로 바꾸면 테스트 3개가 실패한다.

### B. 요청 시점 스냅샷
- 요청 때 제목·문구·길이·**이미지 ID** 를 `snapshot_json` 에 복사하고 `render_job_images` 에 이미지를 기록한다. 렌더는 스냅샷만 읽는다.
- 생성 중에 이미지를 교체해도 이전 이미지는 `render_job_images` 참조 때문에 지워지지 않는다(1단계의 정리 규칙). 파일 복사는 하지 않는다.
- **트레이드오프**: 작업이 쓴 이미지는 영구 보존된다(영상 자동 삭제를 하지 않기로 했으므로 일관). 이미지를 자주 교체하면 디스크가 늘어난다. 정리 정책은 첫 버전에서 의도적으로 두지 않았다.
- 화면의 "요청 직전 저장": 시작 버튼은 먼저 `saveNow()` 로 대기 중인 자동 저장을 모두 끝낸 뒤 요청한다. 그렇지 않으면 마지막 편집이 영상에 빠진다(E2E: 입력 직후 즉시 시작 → 스냅샷에 그 문구).

### C. 큐와 복구
- 큐는 프로세스 안에서 **한 번에 1개** 처리한다. 작업의 진실은 DB 이고 큐는 일꾼일 뿐이라, 프로세스가 죽어도 DB 만 보면 복구된다.
- 시작 시: `failInterrupted()` → `sweepFiles()`(임시 폴더 `data/tmp` 전체, 완료 작업이 가리키지 않는 영상 파일·`.part`) → `sweepOrphans()`(1단계).
- 완성 파일은 **파일 이동 → DB 완료** 순서다(반대면 파일 없는 '완료'가 생길 수 있다). 임시 폴더는 성공·실패 모두 `finally` 에서 지운다.
- 정상 종료(`app.close`)는 진행 중 ffmpeg 를 `SIGKILL` 하고 작업을 `generating` 으로 남긴다(비정상 종료와 같은 경로로 다음 시작 때 실패 처리).

### D. 자막: libass 의 자체 배치를 쓰지 않는다
처음에는 ASS 의 `BorderStyle=3`(줄별 상자)과 libass 줄바꿈을 썼는데, 프레임을 확인하니 **줄마다 반투명 상자가 겹쳐 진한 띠가 생기고**, 미리보기(상자 1개)와 줄바꿈 규칙도 달랐다. 그래서:
- `server/render/font.ts`: `opentype.js` 로 실제 글꼴 폭을 잰다(커닝 포함).
- `server/render/layout.ts`: 줄바꿈(**띄어쓰기에서만**, CSS `text-wrap: balance` 와 같은 균형 배분, 한 단어가 너무 길면 글자 단위)과 상자 크기·위치를 서버가 계산.
- `server/render/ass.ts`: 레이어 0 에 둥근 사각형 1개(`\p4` 벡터), 레이어 1 에 줄마다 `\an5\pos` 로 글자. `WrapStyle 2`(libass 자동 줄바꿈 끔).
- libass 의 `Fontsize` 는 글자 칸(ascent+descent=1.448em) 기준이라 CSS 의 em 과 다르다 → 글꼴 hhea 값으로 계산해 곱한다(측정으로 확인: 예측 글자 폭과 프레임 일치).
- 미리보기 CSS 에는 `word-break: keep-all; overflow-wrap: anywhere` 를 추가해 브라우저도 한글을 띄어쓰기에서만 끊게 했다(기본값은 글자 사이에서도 끊어 "어려우셨나/요?" 처럼 나뉘었다).
- 상자 폭 규칙을 미리보기 CSS 와 맞췄다: 한 줄에 들어가면 글자 폭+여백, 줄바꿈이 생기면 `text-wrap: balance` 로 줄이 고르게 나뉘어도 **최대 폭 유지**. (비교 측정에서 영상 상자가 최대 416px 좁게 나오는 차이를 발견해 영상 쪽을 미리보기에 맞췄다.)

### E. 오류 분류 (`server/render/errors.ts`)
화면에는 제목·해결 방법·오류 코드만 보이고, 개발자용 상세(ffmpeg stderr 끝부분)는 DB 의 `error_detail` 에만 남는다(API 응답에 싣지 않음 — 테스트 확인).

| 코드 | 원인 |
|---|---|
| `IMAGE_DECODE_FAILED` | 장면 번호와 함께 표시. 업로드 검증은 파일 머리만 보므로 본문이 손상된 이미지는 여기서 걸린다 |
| `FFMPEG_NOT_FOUND` / `FONT_MISSING` | 서버 환경 문제 |
| `RENDER_TIMEOUT` | ffmpeg 한 번 실행이 `RENDER_TIMEOUT_MS`(기본 10분) 초과 |
| `RENDER_FAILED` / `OUTPUT_INVALID` / `INTERNAL` | 그 밖 |
| `SERVER_RESTARTED` | 시작 시 복구 |

### F. 보안·안전
- ffmpeg 는 셸 없이 인자 배열로 실행. 이미지 경로는 서버가 만든 UUID 경로뿐이고 사용자 문자열은 파일명에 쓰지 않는다.
- 자막 텍스트의 `{ } \` 는 전각 문자로 바꿔 ASS 태그 주입을 막는다(테스트).
- 다운로드 파일명은 제목에서 경로 구분자·제어문자를 제거하고 80자로 제한, `filename*=UTF-8''…` 로 한글 지원.

## 5. 변경 파일

| 경로 | 내용 |
|---|---|
| `server/render/{renderer,ffmpeg,ass,layout,font,errors}.ts` | 렌더 파이프라인 |
| `server/renderStore.ts`, `server/renderQueue.ts` | 작업 DB 처리, 큐/일꾼 |
| `server/app.ts`, `server/config.ts`, `server/db.ts`, `server/store.ts`, `server/errors.ts` | 라우트·설정·스키마(+마이그레이션)·오류 payload |
| `shared/limits.ts`, `shared/types.ts` | 자막 여백·반지름 비율, `RenderJobView` |
| `web/screens/ResultScreen.tsx`(임시), `ConfirmModal.tsx`, `Editor.tsx`, `ProjectList.tsx`, `useProjectEditor.ts`, `api.ts`, `styles.css` | 시작 버튼 연결, 요청 직전 저장, ref 중복 방지, 폴링 |
| `fonts/*` | 글꼴·라이선스·출처 |
| `scripts/compare-frame.ts`, `scripts/frames.ts` | 미리보기↔영상 비교 |
| `tests/{renders,layout,ffmpeg,migrate}.test.ts`, `e2e/render.e2e.ts` | 테스트 |
| `docs/frame-comparison.md`, 이 문서, `README.md` | 문서 |

DB: 1단계에서 만든 `render_jobs` 에 `step`, `error_detail` 컬럼을 추가했다. 기존 DB 는 열 때 자동 마이그레이션(`tests/migrate.test.ts`).

## 6. 테스트 결과 (이 환경에서 실제 실행)

| 명령 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm test` | **75개 통과** (1단계 39 + 렌더 상태·중복·복구·전달 18 + 레이아웃 10 + 실제 ffmpeg 7 + 마이그레이션 1) |
| `npm run build && npm run test:e2e` | **18개 통과** (1단계 15 + 생성 흐름 3, 약 55초) |

핵심 검증:
- **실제 MP4**: 샘플 3장면 30초 → ffprobe 로 h264/yuv420p, 1280×720, 30/1fps, 길이 30±0.1초, **스트림 1개(소리 없음)**. 장면 전환이 10초·20초(±1프레임). 장면별 프레임에서 배경색 일치, 자막 상자가 설계 좌표와 ±4px 이내, 흰 글자 픽셀 존재(한글 출력 확인). 긴 3줄 문구도 안전 영역 안.
- **실제 이미지 형식**: ffmpeg 가 만든 진짜 JPEG(1600×900)·WebP(세로 540×960)·PNG(320×180) 를 업로드해 영상까지 확인(세로 이미지는 cover 로 가득 채움).
- **브라우저 재생**: 이 Chromium 은 H.264 재생을 지원(`canPlayType: probably`). 영상 길이를 29.5초 초과로 읽고, `play()` 후 `currentTime` 이 증가하며 `error` 가 없음을 확인.
- **실제 서버 수동 스모크**: `server/index.ts` 를 다른 작업 디렉터리에서 실행해 샘플 요청 → 8초 만에 완료 → 다운로드(95KB) → Range 206 → SPA 새로고침 폴백 확인.
- **변이 검사**(테스트가 실제로 결함을 잡는지): 시작 시 복구 호출 제거 → 재시작 테스트 실패 / 유니크 인덱스 제거 → 중복 방지 테스트 3개 실패 / 화면의 ref 보호 제거 → 더블클릭 E2E 실패(프로젝트 2개 생성). 확인 후 모두 원복.

테스트·측정이 잡은 결함: ① 같은 틱 더블클릭 시 요청 중복(1단계 "새 영상 만들기" 포함), ② 줄별 반투명 상자 겹침, ③ libass `Fontsize` 가 em 과 다름, ④ 브라우저의 글자 단위 한글 줄바꿈, ⑤ 상자 폭 규칙 차이.

## 7. 미리보기 ↔ 영상 차이 (요약)
자세한 표는 [frame-comparison.md](frame-comparison.md). 6개 사례(1줄·2줄·3줄·사용자 줄바꿈·영문 혼합), 1280×720 기준, 측정 오차 ±1px.

| 미리보기 글꼴 | 상자 위치/크기 최대 차이 | 글자 경계 최대 차이 | 줄바꿈 위치 |
|---|---|---|---|
| Noto Sans KR 로 맞춤(렌더링 엔진 차이만) | 2px / 4px | 3px / 6px | 6/6 같음 |
| Pretendard (CDN 이 열릴 때 사용자가 보는 모습) | 31px / 62px | 30px / 59px | 6/6 같음(이 사례에서) |
| 배포 CSS 그대로(이 환경은 CDN 불가 → 시스템 대체 글꼴) | 33px / 66px | 35px / 69px | 6/6 같음 |

해석: **배치 엔진 차이는 3px 이내로 작다.** 남는 차이는 **글꼴 차이**다 — 미리보기는 Pretendard(디자인 지정), 영상은 Noto Sans KR(결정 4)이라 같은 문구가 Pretendard 쪽이 약 6% 좁다. 줄바꿈이 갈리는 경계 길이의 문구에서는 미리보기와 영상의 줄 수가 달라질 수 있다(이번 6개 사례에서는 발생하지 않았지만 보장하지 않는다).

## 8. 확인하지 못한 것 / 한계
- **Pretendard CDN**: 이 환경에서 접속이 안 되어 npm 패키지 사본을 측정에만 주입했다. 실제 CDN 렌더링은 확인하지 못했다.
- **투명 PNG, EXIF 회전 JPEG, 애니메이션 WebP, 16비트/CMYK** 이미지는 렌더 테스트를 하지 않았다(투명 영역이 어떤 색으로 합성되는지, 회전 정보가 반영되는지 미확인).
- **Noto Sans KR 에 없는 문자**(이모지 등): 폭 측정이 어긋나 줄바꿈·상자 크기가 틀릴 수 있다(libass 가 대체 글꼴로 그리는 폭은 모른다). 미테스트.
- 큰 이미지(4096×4096)·낮은 사양에서의 인코딩 시간·메모리, 디스크 부족, 동시 요청 부하는 확인하지 않았다.
- Node 프로세스가 `SIGKILL` 로 죽으면 ffmpeg 자식이 고아로 잠시 남아 `data/tmp` 에 쓸 수 있다. 다음 시작이 폴더를 지우지만 그 순간 쓰기와 겹치는 경우는 다루지 않았다.
- Windows 경로 이스케이프(`subtitles` 필터의 `fontsdir`), Chromium 외 브라우저, 실제 모바일 기기는 미확인.
- 결과 화면은 **임시판**이다: 디자인 미적용, 이전(완료) 영상은 프로젝트가 `editing` 으로 돌아가면 화면에서 다시 열 수 없다(API 로는 가능).
- 1단계 문서의 "2단계 예정" 항목 중 서버 재시작 처리·글꼴 관리는 이번에 완료. 남은 것은 3단계(결과 화면 디자인, 전체 흐름 점검).

## 9. 결정이 필요한 사항
1. **미리보기 자막 글꼴을 Noto Sans KR 로 바꿀지.** 바꾸면 미리보기↔영상 차이가 3px 이내로 줄지만, 디자인(Pretendard)에서 자막만 벗어나고 웹 자산이 늘어난다(한글 완성형 포함 woff2 약 540KB 로 줄여 측정, 전체 글꼴은 6MB). 안 바꾸면 위 6% 폭 차이와 줄 수 불일치 가능성을 안고 간다.
2. **자막 상자 폭 규칙.** 지금은 미리보기 CSS 를 따라 "줄바꿈이 생기면 최대 폭"이다. 글자에 딱 맞는 상자를 원하면 미리보기도 JS 로 측정해 맞춰야 한다.
3. **3단계에서 이전 영상 보기.** 편집 중으로 돌아간 프로젝트에서도 마지막 완성 영상을 볼 수 있게 할지.
