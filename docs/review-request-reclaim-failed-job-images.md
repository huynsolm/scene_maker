# 코덱스 검수 요청: 실패한 작업이 붙잡은 이미지 회수 — 계획

검수 대상: `docs/plan-reclaim-failed-job-images.md` (브랜치 `claude/great-mayer-hvh0o2`). 기준 코드: `main` 337a2a5.
**구현 전 계획 검수**다. 코드는 아직 바꾸지 않았다. 계획이 기대는 사실이 코드에서 맞는지, 설계에 빠진 경로가 없는지를 봐 달라.

## 1. 한 줄 요약
실패한 작업은 다시 렌더되지 않는데 이미지 연결(`render_job_images`)이 남아 업로드 이미지를 영구히 붙잡는다. 실패하는 순간 연결을 끊고 쓰지 않는 이미지를 지우며, 이미 쌓인 실패 기록은 다음 서버 시작 때 정리한다. 실패 기록 행은 지우지 않는다.

## 2. 사용자 결정 (바꾸지 않을 것)
- 회수 방식: 실패 시 **자동 회수**(화면 변경 없음). 실패 기록 수동 삭제 기능은 만들지 않는다.
- 기존 실패 기록: **다음 서버 시작 때** 회수.
- "실패 기록 삭제는 범위 밖"이라는 기존 결정 유지(실패 기록 삭제 요청은 계속 409).

## 3. 계획이 기대는 사실 — 코드에서 확인해 달라
| # | 주장 | 근거 위치 |
|---|---|---|
| F1 | 이미지는 렌더하는 동안에만 필요하다 | `server/renderStore.ts:310` `sceneInputs()`만 스냅샷 `imageId`로 파일 경로를 얻는다 |
| F2 | 실패한 작업은 다시 활성 상태가 되지 않는다 | 상태는 `waiting → generating → done/failed`로만 간다. `failInterrupted()`(`:355`)는 활성 → 실패만 한다 |
| F3 | "다시 시도"는 실패 작업을 재사용하지 않고 현재 내용으로 새 작업을 만든다 | `web/screens/ResultScreen.tsx:75` `api.createRender(projectId)` → `createJob()`(`server/renderStore.ts:57`) |
| F4 | 화면은 실패 작업의 장면 이미지를 쓰지 않는다 | `toView`의 `imageUrl`(`:276`)을 쓰는 곳이 `web/`·`tests/`·`e2e/`·`scripts/` 어디에도 없다 |
| F5 | 이미지 파일 제공은 작업 연결과 무관하다 | `server/store.ts:391` `getImageFile()`은 `images` 표만 본다 |
| F6 | 렌더 큐는 실패를 `catch` 안에서 `renders.fail()`로 처리한다 → `fail()`이 던지면 큐 밖으로 샌다 | `server/renderQueue.ts:63-66` |
| F7 | 참조가 사라진 이미지는 시작 시 `sweepOrphans()`가 행·파일을 지운다 | `server/store.ts:427-439` |
| F8 | 시작 순서는 `failInterrupted` → `sweepFiles` → `sweepOrphans` | `server/app.ts:44-46` |

이 가운데 하나라도 틀리면 설계가 무너진다. 특히 F1·F2·F4에 예외 경로가 있는지 봐 달라.

## 4. 설계 요약 (상세는 계획 문서 §4)
1. **실패할 때**: 지금처럼 상태를 `failed`로 바꾸는 트랜잭션을 먼저 커밋 → 그 뒤(실패일 때만) 연결 이미지 id 읽기 → 연결 삭제 → 이미지마다 `collectImageIfUnused`. 이 후처리 전체는 **최선만 다한다**(예외는 로그 후 계속, 이미지별로도 따로). 완료 작업은 건드리지 않는다.
2. **서버 시작 때**: 새 `releaseFailedImages()`가 실패 작업의 연결을 모두 지운다. 순서는 `failInterrupted` → `releaseFailedImages` → `sweepFiles` → `sweepOrphans`. 매번 실행해도 안전하다.
3. **API**: 실패 작업의 장면 `imageUrl`은 `null`(`shared/types.ts`의 타입을 `string | null`로).

### 자체 검토에서 바꾼 점
처음 계획은 연결 삭제를 상태 변경과 **같은 트랜잭션**에 넣었다. 그러면 연결 삭제가 실패할 때 실패 기록까지 롤백되어 작업이 '생성 중'에 갇힌다(다음 시작 때까지 그 프로젝트는 새 영상을 못 만든다 — 프로젝트당 활성 작업은 하나). 연결은 남아도 이미지가 남을 뿐이고 다음 시작 때 정리되므로, 상태 기록을 먼저 커밋하고 회수는 그 뒤에 최선만 다하도록 순서를 나눴다.

## 5. 특히 봐 주었으면 하는 부분 (스스로 의심하는 곳)
1. **"실패 작업은 이미지가 필요 없다"(F1~F4)의 예외 경로**: 실패 작업의 스냅샷이나 이미지를 다시 읽는 곳이 정말 없는가? 예를 들어 실패 화면이 앞으로 장면 썸네일을 보여 주게 되면 깨진다(지금은 없음).
2. **순서와 원자성**: 상태 커밋과 회수 사이에 서버가 멈추면 연결이 남는다 → 다음 시작의 `releaseFailedImages`가 정리한다. 반대로 회수가 상태보다 먼저 일어나는 경로가 있는가?
3. **같은 이미지의 경쟁**: 실패 직후 "다시 시도"가 같은 이미지를 참조하는 새 작업을 만드는 경우. 단일 프로세스·동기 실행이라 실패 처리와 새 작업 생성이 끼어들지 않고, 새 작업이 먼저 연결을 넣었다면 `collectImageIfUnused`가 남긴다고 보았다. 놓친 순서가 있는가?
4. **완료 작업 보호**: 회수는 실패일 때만 한다. `finish()`가 완료·실패를 함께 처리하므로 분기를 잘못 쓰면 완성 영상의 이미지가 지워진다 — 변이 검사(완료 작업에도 연결 삭제)로 막을 계획이다. 충분한가?
5. **API 계약 변경**: 실패 작업의 `imageUrl`을 `null`로 바꾸는 것이 적절한가, 아니면 그대로 두고(404) 문서화만 하는 편이 나은가?
6. **시작 시 정리의 비용과 안전성**: `DELETE FROM render_job_images WHERE job_id IN (SELECT id FROM render_jobs WHERE status = 'failed')`를 매 시작마다 실행한다. 연결 표의 기본 키는 `(job_id, image_id)`다. 문제가 되는 규모가 있는가?
7. **실측 방법**: 업로드 때 이미지를 검사하므로(`server/store.ts:316` `inspectImage`) 손상 이미지는 올릴 수 없다. 실측에서는 업로드 뒤 저장된 파일을 손상시켜 렌더를 실패하게 할 계획이다. 이 방식이 실제 실패 경로(렌더러가 이미지를 읽다 실패)를 대표하는가?
8. **빠진 테스트**: 계획 §5.1 목록에 더해야 할 경우가 있는가? (예: 연결 삭제 자체가 예외를 던지는 경우도 주입할 예정)

## 6. 검토 방법
```
git show e56bd03 -- docs/plan-reclaim-failed-job-images.md   # 계획 초안
git diff e56bd03 HEAD -- docs/plan-reclaim-failed-job-images.md   # 자체 검토 반영(§4.1 순서 변경)
```
위 표의 위치를 열어 사실 F1~F8을 확인하고, §5의 질문에 답해 주면 된다.

---

# 코덱스 검수 요청 (2차): 구현 — 1·2단계

검수 대상: 브랜치 `claude/great-mayer-hvh0o2` `9c6f60b`. 기준: `main` 337a2a5. 계획 검수(위 1차)의 보완 사항을 `b36249c`로 계획에 반영한 뒤 구현했다. **제품 코드 변경은 `99d2342` 한 커밋**(서버 3파일 + 테스트)이고, 나머지는 측정 스크립트와 문서다. CI #86(`9c6f60b`) 성공.

## 1. 커밋
| 커밋 | 내용 |
|---|---|
| `b36249c` | 계획에 1차 검수 반영(계획 §8 표) |
| `99d2342` | 서버: 실패 시 회수, 시작 시 정리, `imageUrl: null` + `tests/reclaimFailedImages.test.ts` 20개 |
| `5df5c48`, `1f38bff` | 1단계 결과 기록(계획 §9), 상태 줄 정리 |
| `b513ec1` | `scripts/measure-disk.ts` P3(실패 반복) 추가, `--report-only` |
| `9c6f60b` | `docs/disk-usage.md` P3 결과, 계획 §10 |

## 2. 구현 요약 (코드 위치)
- `server/renderStore.ts`
  - `fail()`(`:333`): `finish(..., 'failed')`(상태 트랜잭션, 예외는 그대로 던짐) → `releaseImagesOf(jobId)`.
  - `releaseImagesOf()`(`:356`, private): `linkedImageIds` → `unlinkImages`를 한 `try`로 감싸고 실패하면 경고 후 반환. 그 뒤 이미지마다 `collectImageIfUnused`를 따로 `try`. 완료(`complete`)에서는 부르지 않는다.
  - `linkedImageIds()`·`unlinkImages()`(`:339`, `:346`): 공개 메서드로 뺐다(테스트가 단계별로 예외를 주입하려고).
  - `releaseFailedImages()`(`:408`): 실패 작업의 연결을 한 문장으로 삭제.
  - `toView`(`:277`): `imageUrl: j.status === 'failed' ? null : imageUrl(...)`.
  - `failInterrupted()`는 그대로 `fail()`을 부르므로 중단된 작업도 시작 때 같은 회수를 거친다(주석만 고침).
- `server/app.ts:44-51`: `failInterrupted()` → `try { releaseFailedImages() } catch { 경고 }` → `sweepFiles()` → `sweepOrphans()`.
- `shared/types.ts:86`: `imageUrl: string | null`. `web/`는 이 필드를 읽지 않아 타입 검사만 통과하면 된다.

## 3. 검증
- 새 테스트 20개(계획 §5.1 전부): 기본 동작 11, 단계별 실패 주입 3(id 읽기 / 연결 삭제 / 첫 이미지 회수), 시작 시 6(옛 데이터·멱등, 여러 실패 기록 공유 + 완성 작업 공유, 충돌 복구 a·b, `failInterrupted`, 시작 시 정리 예외).
- 기존 서버 코드에 새 테스트를 돌리면 16개 실패, 4개 통과(완성 작업 보호 2, 실패 기록·409, 다시 시도 — 원래 성립해야 하는 동작).
- 변이 9종 모두 잡힘(계획 §9에 실패 수). 전체 단위·API 183, E2E 80, 타입 검사 통과.
- 실측 P3(계획 §10, `docs/disk-usage.md`): 변경 전 14→18→22장(실패마다 약 14.7MB), 엄격 모드는 2회차에 스크립트 실패. 변경 후 14장 유지, 서버 재시작 뒤에도 기대 id와 일치. P1·P2 재측정도 모든 검사 일치.

## 4. 특히 봐 주었으면 하는 부분 (스스로 의심하는 곳)
1. **id 읽기와 연결 삭제가 트랜잭션이 아니다**: 단일 프로세스·동기 실행이라 둘 사이에 다른 요청이 끼지 않는다고 보았다. 읽은 뒤 삭제가 실패하면 회수하지 않고 반환한다(연결이 남아 어차피 못 지움). 맞는가?
2. **`linkedImageIds`·`unlinkImages`를 공개로 둔 것**: 테스트 주입을 위해서다. 다른 곳에서 잘못 부를 위험(예: 완료 작업에 `unlinkImages`)이 생긴다. 비공개로 두고 다른 방식으로 주입하는 편이 나은가?
3. **시작 순서에서 `failInterrupted` 안의 회수**: 시작 때 중단 작업마다 `collectImageIfUnused`가 파일을 지운다. 이어지는 `sweepFiles`·`sweepOrphans`와 겹쳐도 문제가 없다고 보았다(이미 지운 것은 건너뜀). 놓친 상호작용이 있는가?
4. **종료 중 실패**: `runJob`은 `closed`면 `fail()`을 부르지 않는다 → 다음 시작의 `failInterrupted`가 처리한다. 이 경로에서 회수가 빠지는 경우가 있는가?
5. **테스트의 인위적 상황**: "진행 중인 다른 작업이 같은 이미지를 참조"는 실제 흐름으로 만들 수 없어(프로젝트당 진행 중 작업 하나, 이미지는 프로젝트 소속) 대기 중인 다른 프로젝트 작업에 연결을 직접 넣었다. 이 테스트가 의미가 있는가, 아니면 빼는 편이 정직한가?
6. **충돌 복구 테스트의 흉내 방식**: (a)는 `releaseImagesOf`를 no-op으로, (b)는 `collectImageIfUnused`를 `false` 반환으로 바꿔 "그 지점에서 멈춘 상태"를 만든다. 실제 프로세스 중단과 다른 점이 있는가?
7. **실측 판정의 독립성**: 기대 id = "완성 작업을 요청할 때의 장면 이미지 ∪ 현재 장면 이미지"를 스크립트가 기억한다. 현재 장면 id는 `store.getProject`(DB)에서 읽는다. 이 정도면 계획 §5.3의 "따로 계산"을 만족하는가? `--report-only` 플래그를 남겨 두는 것이 괜찮은가?
8. **문서의 한계 표현**: `docs/disk-usage.md` 한계 절에 "측정은 이미지 읽기 실패로, 테스트는 이미지 읽기 실패와 서버 중단으로만 확인"이라고 적었다. 과장이나 누락이 있는가?

## 5. 검토 방법
```
git diff 337a2a5 9c6f60b -- server shared            # 제품 코드(작다)
git show 99d2342 -- tests/reclaimFailedImages.test.ts
git diff 337a2a5 9c6f60b -- scripts/measure-disk.ts
npx vitest run tests/reclaimFailedImages.test.ts
npm run measure:disk -- --only P3                     # 약 1분
```
변이를 직접 해 보려면 `releaseImagesOf` 안의 `unlinkImages` 호출 삭제, 또는 `complete()`에 `this.releaseImagesOf(jobId)` 추가 → 테스트가 실패해야 한다.
