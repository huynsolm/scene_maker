# 계획: 렌더 큐의 예외가 서버를 죽이지 않게

상태: **계획 확정(구현 전)**, §4.3은 안 A로 결정. 기준 코드: `main` 1e1f4fb.

## 1. 목적
렌더 작업 하나를 마무리하다 예외가 나면 그 예외를 받아 주는 곳이 없다. Node 22에서는 처리되지 않은 Promise 거부가 **서버 프로세스를 종료**시킨다. 한 작업의 정리 실패가 서버 전체를 멈추지 않게 한다.

## 2. 현재 구조 (코드 확인 결과)
- `RenderQueue.kick()`(`server/renderQueue.ts:24-33`)은 `this.loop().finally(...)`의 결과를 `this.current`에 담을 뿐 `.catch`가 없다. `loop()`가 거부되면 처리되지 않은 거부가 된다.
- `loop()`(`:42-48`)는 `await this.runJob(job)`을 감싸지 않는다.
- `runJob()`(`:50-70`)에서 `try` 밖으로 나가는 예외 경로는 두 가지다.
  1. `finally`의 `fs.rmSync(workDir, { recursive: true, force: true })`. `force`는 "없는 파일"만 무시하므로, 잠금(EBUSY)·권한(EPERM, EACCES) 오류는 그대로 던진다. 예를 들어 Windows에서 백신·탐색기 미리보기가 임시 파일을 잡고 있을 때 생긴다. 다른 정리 경로는 이미 `safeRm`(`server/fsSafe.ts`)으로 이 오류를 흡수하는데, 여기만 빠져 있다.
  2. `catch` 안의 `this.renders.fail()`이 던질 때. 상태 트랜잭션의 DB 오류 같은 경우다.
- `complete()`가 던지면 `catch`로 가서 `fail()`로 처리된다(서버는 살아 있다). 이때 이미 옮긴 영상 파일은 실패 작업의 고아 파일이 된다. 다음 시작 때 `sweepFiles`가 지운다.
- `server/index.ts`와 `server/app.ts`에는 `unhandledRejection`·`uncaughtException` 처리기가 없다.
- `close()`(`:36-40`)는 `await this.current`를 하므로, 거부된 `current`는 서버 종료(`app.close`)도 실패시킨다.

## 3. 재현 (실제 프로세스, 처리기 없음)
`scripts/repro-queue-crash.mts`로 `buildApp`과 가짜 렌더러를 띄우고 영상 하나를 요청했다. 데이터 폴더의 `tmp` 아래 경로에만 예외를 주입했다. 테스트 러너는 처리되지 않은 예외를 따로 잡아 주므로 쓰지 않았다.

| 주입 | 결과 |
|---|---|
| 작업 폴더 정리(`fs.rmSync`)가 EBUSY | 작업은 `done`으로 기록된 뒤 **프로세스 종료(code 1)**: `Error: EBUSY` |
| `complete()`와 `fail()`이 모두 DB 오류 | 작업이 `generating`에 남은 채 **프로세스 종료(code 1)** |
| `complete()`만 DB 오류 | 서버는 살아 있고 작업은 `failed`(기존 `catch`가 처리) |

처리기를 달고 다시 돌리면 거부가 실제로 생기는 것이 보인다(`unhandledRejection: EBUSY…`). 프로세스는 살아남지만, `fail()`까지 실패한 경우에는 작업이 `generating`에 남는다. 그래서 같은 프로젝트의 새 요청은 409(진행 중)가 된다.

## 4. 설계

### 4.1 작업 폴더 정리를 `safeRm`으로
- `runJob`의 `finally`를 `safeRm(workDir, { recursive: true })`로 바꾼다. 실패하면 경고를 남기고 계속한다.
- 남은 폴더는 다음 시작 때 `sweepFiles`가 `tmp` 전체를 지우며 정리한다(이미 있는 경로).
- 다음 작업은 작업 id별로 다른 폴더(`tmp/<jobId>`)를 쓰므로, 남은 폴더와 부딪히지 않는다.

### 4.2 작업 하나의 예외가 큐 밖으로 새지 않게
- `loop()`에서 `runJob`을 `try/catch`로 감싼다. 예외는 작업 id와 함께 `console.error`로 남기고, 다음 대기 작업으로 넘어간다.
- `kick()`의 `loop()` Promise에도 마지막 안전망으로 `.catch`(로그)를 단다. `claimNext()`·`hasWaiting()`처럼 `runJob` 밖에서 던지는 DB 오류에 대비한 것이다. `close()`의 `await this.current`도 더는 거부되지 않는다.
- 전역 `process.on('unhandledRejection')` 처리기는 **두지 않는다**. 다른 곳의 진짜 버그까지 삼키게 되므로, 큐가 자기 예외를 스스로 처리하게 한다.

### 4.3 `fail()`까지 실패한 작업 — **결정: 안 A**(사용자 확인)
`fail()`이 던지면 작업은 DB에 `generating`으로 남는다. 그 프로젝트는 서버를 다시 시작할 때까지(`failInterrupted`가 실패로 바꿈) 새 영상을 만들 수 없고, 화면은 "만드는 중"으로 남는다.
- **안 A (채택): 로그만 남기고 그대로 둔다.** 다음 시작 때 복구된다. `fail()`은 작은 UPDATE 두 개라, 이것까지 실패할 상황(디스크 가득 참, DB 손상)이면 다시 시도해도 대개 같이 실패한다. 코드가 가장 적다.
- 안 B: 큐가 "막힌 작업"을 기억했다가 다음 `kick()` 때 `fail()`을 다시 시도한다. 일시적인 오류라면 재시작 없이 풀린다. 다만 상태를 하나 더 두고, 다시 시도하는 경로를 테스트해야 한다.
- 안 C: 서버를 일부러 종료한다(빨리 실패). 재시작하면 복구되지만, 다른 프로젝트의 작업과 요청까지 끊긴다.

### 4.4 바뀌지 않는 것
- 렌더 실패를 `fail()`로 기록하는 흐름과 오류 안내, 실패 시 이미지 회수(PR #10).
- `complete()` 실패 → `fail()` 경로.
- 종료 중(`closed`)에는 상태를 바꾸지 않는다는 규칙.

## 5. 검증 계획

### 5.1 단위·API 테스트 (`FakeRenderer`)
- 작업 폴더 정리가 EBUSY를 던져도(`fs.rmSync`를 `tmp/<jobId>` 경로에만 던지게 가로챔) 작업은 `done`이고, 경고가 남고, **다음 작업도 처리된다**. 처리되지 않은 거부도 없다. 테스트 안에서 `process.on('unhandledRejection')`으로 직접 센다. Vitest도 처리되지 않은 오류가 있으면 실행을 실패시킨다.
- 남은 작업 폴더는 다음 시작 때 지워진다.
- 실패 처리 중 정리 실패(렌더 실패 + EBUSY): 작업은 `failed`, 큐는 계속 돈다.
- `fail()`이 던짐(렌더 실패 + `fail` 가로챔): 거부가 새지 않고, **다른 프로젝트의 다음 작업은 처리된다**. 막힌 작업은 다음 시작 때 `failed`가 된다(안 A 기준).
- `claimNext()`가 한 번 던짐: 거부가 새지 않는다. 그 뒤의 요청은 다시 처리된다.
- `close()`는 위 경우들 뒤에도 정상으로 끝난다.

### 5.2 재현 스크립트로 프로세스 생존 확인
`npx tsx scripts/repro-queue-crash.mts <rm|both> nohandler`를 고친 코드에서 다시 돌려, 처리기 없이도 프로세스가 살아 있고(종료 코드 0) 다음 요청을 처리하는지 확인한다. 자동 테스트로 만들지(`tests/`에서 자식 프로세스로 띄우기)는 구현 때 정한다.

### 5.3 변이 검사
다음 각각에 대응 테스트가 실패하는지 확인한다.
- `safeRm`을 `fs.rmSync`로 되돌리기
- `loop()`의 `try/catch` 제거
- `kick()`의 `.catch` 제거

### 5.4 E2E
화면 변경이 없으므로 새 E2E는 없다. 기존 E2E가 그대로 통과해야 한다.

## 6. 위험과 한계
- 안 A에서는 `fail()`까지 실패한 작업이 재시작 전까지 '만드는 중'으로 남는다(§4.3).
- `complete()` 실패 뒤에 남는 영상 파일은 지금처럼 다음 시작 때 정리된다(바꾸지 않음).
- 잠금이 계속 풀리지 않으면 임시 폴더가 다음 시작까지 남는다(작업당 최대 수십 MB, `docs/disk-usage.md`의 렌더 중 임시 폴더 최대 24~30MB).
- 단일 프로세스·동기 SQLite 전제는 그대로다.

## 7. 단계
1. 서버: 4.1~4.3 구현과 5.1·5.3 테스트, 5.2 재확인.
2. 문서: 이 계획에 결과를 기록하고, `docs/review-request-delete-previous-videos.md` §19 표의 "실패한 작업 기록이 붙잡는 이미지는 회수되지 않음 — 유지" 줄을 PR #10으로 해결됐다고 고친다.
