# YouthHire (canadayouthhire.ca)

Canadian youth job board — students, new grads, first-time job seekers.
Live production. Real users, real Stripe payments.

## Stack
- Frontend: vanilla HTML/JS (`index.html`, `admin.html` 7000+ lines each)
- Hosting: Vercel Hobby (`prj_uFFCDb0S7HXCnArzr5VRSUwA5mJb`, 12-function limit)
- DB: Supabase `xouvuqqkbtaikrnnueda`
- Payments: Stripe live | Email: EmailJS (`ideamakerhan2` 계정)
- Repo: `ideamakerhan3-boop/youthhire` (public)

## 공유 지식
Cortex wiki 참조: `C:\Users\ideam\Desktop\Cortex\`
- 위키 진입점: `wiki/INDEX.md` (작업 시작 시 먼저)
- **TurtleJobs 페어 학습 인덱스**: `wiki/lessons/INDEX-job-boards.md` (양쪽 사이트 적용 상태 매트릭스 + 공통 함정 lessons)
- 한국어 톤: `.claude/rules/korean-tone.md`
- 결제/보안: `.claude/rules/payment-security.md`
- Impeccable 스킬: `wiki/skills/impeccable.md`

새로 알게 된 거 cortex/wiki에 업데이트 (복리 지식).

## 페어 프로젝트 학습 룰 (TurtleJobs와 공유)
버그/패턴 fix 후 sibling 프로젝트(TurtleJobs `Desktop/클로드 코드/`)도 적용 가능한지 확인. yes면 `Desktop/Cortex/wiki/lessons/<topic>.md` 에 lesson 추가/갱신 + `INDEX-job-boards.md` 매트릭스 상태 ✅⏳❌ 업데이트.

## 새 채팅 시작 순서
1. `HANDOFF/README.md` → 1-CRITICAL → 2-IMPORTANT 순서로 필요한 것만
2. 글로벌 메모리: `C:/Users/ideam/.claude/projects/.../memory/MEMORY.md` 필요 시
3. 전부 읽지 말 것 — 토큰 효율

## Hard rules (어기면 사고남)
1. **DB 기존 데이터 / 가입자 정보 수정 금지** — accounts/credits/transactions 라이브 데이터 read only
2. `main` 직접 push 금지. PR + squash merge만. push 전 `git fetch + rebase + diff stat` 필수 (다른 채팅 작업 안 날리게)
3. Production env 쓰기는 사용자 직접 (시스템이 agent 차단)
4. 사용자 UI = 영어. Admin만 한국어 OK
5. 결제/크레딧 코드 atomic + idempotent (`SIGNUP-<email>` 같은 unique ref 패턴)
6. 토큰/시크릿 채팅 echo 금지 (`HANDOFF/1-CRITICAL/secrets.md` 참조)

## TurtleJobs와 분리
- TurtleJobs (운영) = `Desktop/클로드 코드/코드/`
- YouthHire = `Desktop/클로드 코드2/` (별도 Supabase, 별도 EmailJS 계정)
- 배포/이메일/결제 절대 섞지 말 것
