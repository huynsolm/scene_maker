# 코덱스 검수 요청: 렌더 큐의 예외가 서버를 죽이지 않게 — 계획

검수 대상: `docs/plan-render-queue-resilience.md`(브랜치 `claude/great-mayer-hvh0o2`), 재현 스크립트 `scripts/repro-queue-crash.mts`. 기준 코드: `main` 1e1f4fb.
**구현 전 계획 검수**다. 제품 코드는 아직 바꾸지 않았다. 문제가 실제로 있는지, 고치는 범위가 맞는지, 빠진 경로가 없는지를 봐 달라.

## 1. 한 줄 요약
렌더 작업을 마무리하다 예외가 나면(작업 폴더 정리의 잠금 오류, `fail()`의 DB 오류) 받아 주는 곳이 없어 처리되지 않은 Promise 거부가 되고, Node 22에서 **서버 프로세스가 종료된다**. 이 경로를 재현했고, 작업 폴더 정리를 `safeRm`으로 바꾸고 큐 루프에서 예외를 받아 로그로 남기도록 고칠 계획이다.

## 2. 사용자 결정 (바꾸지 않을 것)
- `fail()`까지 실패한 작업은 **안 A**: 로그만 남기고 `generating`으로 둔다. 다음 서버 시작 때 `failInterrupted()`가 실패로 바꾼다(계획 §4.3). 재시도(안 B)와 일부러 종료(안 C)는 하지 않는다.

## 3. 계획이 기대는 사실 — 코드에서 확인해 달라
| # | 주장 | 근거 위치 |
|---|---|---|
| F1 | `kick()`은 `loop()` Promise에 `.finally`만 달고 `.catch`가 없다 | `server/renderQueue.ts:24-33` |
| F2 | `loop()`는 `await this.runJob(job)`을 감싸지 않는다 | `:42-48` |
| F3 | `runJob`의 `finally`는 `fs.rmSync(workDir, { recursive: true, force: true })`이고, `force`는 ENOENT만 무시한다(EBUSY·EPERM·EACCES는 던짐) | `:68-69`, 비교: `server/fsSafe.ts` `safeRm` 주석 |
| F4 | `catch` 안의 `this.renders.fail()`이 던지면 `runJob` 밖으로 나간다 | `:63-66` |
| F5 | `complete()`가 던지면 `catch` → `fail()`로 처리된다(서버는 산다) | `:62` |
| F6 | 전역 `unhandledRejection`·`uncaughtException` 처리기가 없다 | `server/index.ts`, `server/app.ts` |
| F7 | `close()`가 `await this.current`를 하므로, 거부된 `current`는 `app.close()`도 실패시킨다 | `:36-40`, `server/app.ts` `onClose` |
| F8 | 남은 `tmp/<jobId>`는 다음 시작 때 `sweepFiles()`가 `tmp` 전체를 지운다 | `server/renderStore.ts` `sweepFiles` |
| F9 | 작업마다 다른 폴더(`tmp/<jobId>`)를 쓰므로, 남은 폴더가 다음 작업과 부딪히지 않는다 | `:51` |

## 4. 재현 (계획 §3)
```
npx tsx scripts/repro-queue-crash.mts rm nohandler        # 작업 폴더 정리가 EBUSY
npx tsx scripts/repro-queue-crash.mts both nohandler      # complete()·fail() 모두 DB 오류
npx tsx scripts/repro-queue-crash.mts complete nohandler  # complete()만 DB 오류(대조군)
```
`nohandler`를 빼면 처리기를 달아 거부를 출력하고 프로세스를 살려 둔다. 이 환경(Linux, Node 22.22)에서의 결과는 다음과 같다.

| 모드 | 결과 |
|---|---|
| `rm` | 작업 `done` 기록 뒤 프로세스 종료 code 1, `Error: EBUSY` |
| `both` | 작업 `generating` 남은 채 프로세스 종료 code 1 |
| `complete` | 살아 있음, 작업 `failed` |

예외는 데이터 폴더의 `tmp/` 아래 경로에만 주입한다. 처음 실험에서는 데이터 폴더 전체(`/tmp` 아래)에 주입해 결과가 오염됐고, 경로를 좁혀 다시 쟀다.

## 5. 설계 요약 (상세는 계획 §4)
1. `runJob`의 `finally` → `safeRm(workDir, { recursive: true })`.
2. `loop()`에서 `runJob`을 `try/catch`로 감싸 `console.error` 후 다음 작업으로 넘어간다. `kick()`의 Promise에 마지막 안전망 `.catch`를 단다(`claimNext`·`hasWaiting`의 DB 오류 대비).
3. 전역 처리기는 두지 않는다(다른 버그를 삼키지 않게).
4. `fail()` 실패는 안 A(§2).

## 6. 특히 봐 주었으면 하는 부분 (스스로 의심하는 곳)
1. **현실성**: Windows에서 `fs.rmSync(..., { recursive: true, force: true })`가 백신·인덱서·탐색기 미리보기의 잠금 때문에 EBUSY·EPERM을 던지는 일이 실제로 있는가? `maxRetries` 옵션(EBUSY 등을 재시도)을 함께 쓰는 편이 나은가?
2. **`loop()`의 `catch` 뒤 계속 도는 것이 안전한가**: 어떤 예외(예: `claimNext` 안에서 계속 실패하는 DB 오류)는 루프가 곧바로 다시 실패하는 바쁜 반복을 만들 수 있다. `claimNext`는 `loop`의 `while`에서 부르므로, 그 예외는 `runJob`의 `try` 밖이다 — 계획에서는 `kick()`의 `.catch`가 받고 루프는 끝난다(다음 요청의 `kick` 때 다시 시작). 이 구분이 맞는가?
3. **`kick()`의 `.finally` 재시작 경로**: 지금은 `loop()`가 끝나면 `hasWaiting()`을 보고 다시 `kick()`한다. 거부를 `.catch`로 받은 뒤에도 이 재시작이 일어나면, 같은 DB 오류로 무한 재시작할 수 있는가? `.catch`와 `.finally`의 순서를 어떻게 둬야 하는가?
4. **안 A의 영향**: `fail()`이 실패한 작업은 `generating`으로 남고, 큐는 그 작업을 다시 집지 않는다(`claimNext`는 `waiting`만 집는다). 같은 프로젝트는 409, 다른 프로젝트는 계속 처리된다고 보았다. 맞는가? 그 작업의 이미지 연결은 남지만 다음 시작의 `failInterrupted` → `fail` → 회수로 정리된다(PR #10).
5. **`complete()` 실패 뒤 영상 파일**: 이미 옮긴 영상이 실패 작업의 고아 파일로 남고, 다음 시작 때 `sweepFiles`가 지운다. 이번 범위에서 즉시 지우지 않는 것이 괜찮은가?
6. **`closed` 중 경로**: 종료 중 렌더가 중단되면 `catch`에서 `return`하고 `finally`의 정리를 탄다. 이 정리가 던질 때도 `close()`가 정상으로 끝나야 한다. 계획 §5.1에 넣었는데 충분한가?
7. **테스트 방식**: 처리되지 않은 거부를 테스트 안에서 `process.on('unhandledRejection')`으로 센다. Vitest도 처리되지 않은 오류가 있으면 실행을 실패시킨다. 자식 프로세스로 실제 종료 코드를 보는 자동 테스트까지 둘 필요가 있는가, 아니면 재현 스크립트로 충분한가?
8. **빠진 경로**: `runJob` 밖에서 큐를 죽일 수 있는 다른 경로가 있는가? (예: `setStep` 콜백 안의 DB 오류는 렌더러 안에서 던져지므로 `try`가 받는다고 보았다)

## 7. 검토 방법
```
cat docs/plan-render-queue-resilience.md
sed -n 1,80p server/renderQueue.ts
cat server/fsSafe.ts
npx tsx scripts/repro-queue-crash.mts rm nohandler; echo "exit=$?"
```
