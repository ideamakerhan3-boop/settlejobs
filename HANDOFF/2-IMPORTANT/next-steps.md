# Next Steps — 2026-04-30

## 🟢 즉시 가능 (코드만, agent 자율)

### 1. PR #20 머지
- 내용: register atomic credit grant + 검색 location 필드 autofill fix
- Vercel preview SUCCESS 확인 후 `gh pr merge 20 --squash`
- 머지 후 5분 안에 스모크 (signup → 5 credits → reload → 5 유지)

### 2. (Register 폼 작업 끝나면) Turnstile + honeypot 연결
- 다른 채팅의 register 디자인 작업 완료 확인 필요
- 작업 내용:
  - `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` head에 추가
  - register 폼에 `<div class="cf-turnstile" data-sitekey="<TURNSTILE_SITE_KEY>"></div>` 삽입
  - register 제출 시 `cfTurnstile.getResponse()` 토큰 읽어서 `turnstile_token`으로 전송
  - Hidden honeypot 필드 4개 추가: `<input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px">` (+ url/homepage/phone_number)
- TURNSTILE_SITE_KEY는 production env에만 있음 → preview 테스트 위해 preview env에도 추가 필요할 수 있음 (사용자 결정)

### 3. r-name / r-company / pj-email 필드 autofill hack 적용
- 같은 readonly-onfocus 패턴
- Register 폼 디자인 작업 끝난 후 진행 (충돌 회피)

## 🟡 사용자 액션 필요

### 4. Vercel env 추가 (production)
- `ALERT_PHONE` = `+12508554037` (또는 새 번호로 교체 권장 — 옛 번호는 git history에 영구)
- `ALERT_PHONE_EMAIL` = `2508554037@txt.bell.ca`
- `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` (음성 알람 활성화 원할 시)

### 5. Google Search Console
- GSC 등록 → 받은 `<meta name="google-site-verification" content="...">` 코드를 사용자가 주면 즉시 `index.html` head에 삽입
- Sitemap 제출: `https://www.canadayouthhire.ca/sitemap.xml`

### 6. Google Analytics
- GA4 Property 만들고 `G-XXXXXXXX` Measurement ID 받기
- 받으면 즉시 gtag 설치

## 🟢 선택적 (안 시급)

### 7. Supabase rate_limits RLS policy
- 현재 INFO lint만 — 동작 영향 없음
- 명시적 policy 추가:
  ```sql
  CREATE POLICY "service_role_only" ON public.rate_limits
    FOR ALL TO authenticated USING (false) WITH CHECK (false);
  ```

### 8. middleware.js 라이브 사용자 데이터 영향 0인지 재확인
- production은 short-circuit (apex→www만)
- preview 만 Basic Auth → 사용자 영향 없음 ✓

## ❌ 하지 말 것

- DB의 accounts/credits/transactions/jobs 데이터 수정 (사용자 정보)
- 머지 시 다른 채팅 작업 날리기 (rebase + diff stat 검증 필수)
- Production env에 agent-inferred 값 쓰기 (사용자가 직접)
- Force push without `--force-with-lease`
- Skip pre-push hooks
