# Hard Rules — 어기면 안 됨

## 데이터 안전 (사용자 명시 — 2026-04-30)
1. **DB 기존 데이터 수정 금지** — accounts/credits/transactions/jobs 등 라이브 데이터 변경하지 말 것.
   - 예외: 사용자가 명시적으로 지시한 경우 (예: "FREE5 promo 만들어")
   - 예외라도 SQL 미리 보여주고 확인 받기
2. **가입자 정보 수정 금지** — accounts 테이블의 email/name/company/pw/is_admin 등 프로덕션 값 절대 변경 안 함.
3. **머지 시 다른 채팅 작업 안 날리기** — push 전 반드시:
   - `git fetch origin main`
   - `git rebase origin/main`
   - `git diff origin/main..HEAD --stat` 으로 의도된 파일만 변경되는지 확인
4. **Force push 시 `--force-with-lease`** 만 사용. 다른 브랜치/main 절대 force push 금지.

## 브랜치 / 배포
1. **PR 머지 전 Vercel preview 통과 확인** (`gh pr view <num> --json statusCheckRollup`).
2. **머지 후 5분 안에 스모크 테스트**: `https://www.canadayouthhire.ca/` 200, 주요 라우트 (`/`, `/pricing`, `/admin`, `/about`) 응답 확인.
3. **Production env 변경 시 사용자 직접 수행** — agent가 production env 쓰기는 시스템이 차단함. 코드 변경만 PR로.

## API / 보안
1. **클라이언트 쓰기 금지** — Supabase 직접 INSERT/UPDATE 클라이언트에서 안 함, 모두 `/api/*` 경유.
2. **Service role key는 서버사이드만**. 클라이언트는 anon key (RLS 보호 받는 것).
3. **Vercel Hobby 12 함수 제한**. `api/` 루트에 13번째 추가 시 silent deploy 실패. 새 endpoint 만들기 전 카운트 확인.
4. **공유 폴더 (`api/_lib/`)에 helper 모아두기** — 함수 카운트 안 늘림.

## UI 언어
1. **사용자 UI는 영어**. 모달/토스트/에러 한국어 금지.
2. **Admin 페이지만 한국어 OK**.
3. **코드 내부 주석은 한국어 OK**, 사용자 노출 텍스트만 영어 강제.

## 코드 품질
1. **결제/크레딧 코드는 atomic하게**. fire-and-forget 금지. unique ref + idempotent 패턴 사용 (`SIGNUP-<email>`, `STRIPE-<intent>` 등).
2. **세션 상태는 localStorage 유지** (cjb_email, cjb_pwh 등). 페이지 리로드 후 복원 안 되면 모든 인증 API 죽음.
3. **큰 파일 (1000+ lines) edit 후 재읽기로 검증**. admin.html, index.html은 7000+ lines라 실수 잘 남.
