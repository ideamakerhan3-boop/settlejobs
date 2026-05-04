# 알려진 버그 / 이슈 — 2026-04-30 기준

## ✅ 최근 fix (production live)

| 증상 | 원인 | PR |
|---|---|---|
| Public 옛 비번 `gks125412` 노출 | middleware.js fallback (commit 06f743b ~ ff5513f 사이) | PR #3 (이전), STAGING_PASS 로테이션 |
| 옛 preview 4개 `gks125412` 받음 | env 생성(2026-04-24 12:40Z) 이전 빌드 | 4개 모두 DELETED |
| 본인 폰 `+12508554037` 공개 노출 | alerts.js fallback | PR #12 (a907042) |
| 페이지 리로드 시 어드민 빈 화면 / 0 크리딧 / "Session expired" | `_ACCOUNTS[em].pw = undefined` (서버가 pw 컬럼 안 돌려줌) | PR #18 (c7e3ae1) — pw_hash localStorage 영속화 |
| Invalid 프로모 입력 시 화면 5 → 0 크리딧 | `if(!promoRes)` 가드가 error envelope 못 잡음 → `_totalCredits = undefined` | PR #18 |
| 가입 보너스 race window | client signup_bonus 별도 콜이 실패하면 0 credits | PR #20 (open, 머지 대기) |
| Location field에 이메일 autofill | `autocomplete="off"` Chrome 무시 | PR #20 — readonly-onfocus hack |

## 🔴 미해결 버그

### 1. Register 폼 다른 필드도 같은 autofill 누출 가능
- `r-name`, `r-email`, `r-company`, `pj-email`, `pj-email2` 모두 `autocomplete="off"` 만 있고 readonly hack 없음
- Location 필드와 같은 패턴이라 동일 증상 재현 가능
- **블로커**: register 폼 디자인이 다른 채팅에서 작업 중 — 충돌 회피 위해 보류
- 디자인 작업 완료 확인 후 readonly-onfocus hack 적용

### 2. Client-side Turnstile widget 미연결
- 서버 verify는 활성 (`api/auth-api.js:84` register에서 `body.turnstile_token` 검증)
- 클라이언트 위젯 (`<script>` + `<div class="cf-turnstile">`) 없음 → 봇이 그냥 토큰 없이 register 가능
- 서버는 backwards-compatible로 토큰 없으면 통과 → 사실상 봇 차단 효과 0
- **블로커**: register 폼 작업 동시 진행 중. 디자인 끝나면 통합 필요.

### 3. Client-side honeypot 미연결
- 서버는 `body.website || body.url || body.homepage || body.phone_number` 체크 (auth-api.js register 핸드폴드)
- 클라이언트에 hidden trap 필드 없음 → 봇이 이 필드 안 채울 가능성 ↑ → 현재 구현은 사실상 무용
- 같이 묶어서 fix.

### 4. Vercel ALERT_PHONE / ALERT_PHONE_EMAIL env 미설정
- alerts.js는 fail-closed로 수정됨 (PR #12)
- 즉 production에서 SMS 알람 silent
- TWILIO_SID/TOKEN/FROM도 미설정이라 voice도 비활성
- 사용자 직접 추가 필요 (agent의 prod env 쓰기 시스템 차단)

### 5. Supabase `public.rate_limits` RLS-no-policy
- INFO 레벨 lint
- service_role만 쓰니 동작에 문제 없음
- 명시적 policy 추가하면 lint 깨끗
