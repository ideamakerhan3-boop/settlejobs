# Environments — YouthHire

## Production
- **Domain**: `https://www.canadayouthhire.ca` (apex `canadayouthhire.ca` → 301 → www)
- **Registrar**: IONOS (등록 2026-04-23)
- **Vercel project**: `prj_uFFCDb0S7HXCnArzr5VRSUwA5mJb`
- **Vercel team**: `team_zsrOjeC2B4XqPmzfXE9e8lVw`
- **GitHub repo**: `ideamakerhan3-boop/youthhire` (public)
- **Plan**: Vercel Hobby — **12 serverless function 한계**

## Supabase
- **Project ID**: `xouvuqqkbtaikrnnueda`
- **JWT iat**: 2026-03-31, exp 2090-08-21
- **Anon key**: `index.html`/`admin.html`에 하드코딩 (의도된 public, RLS로 보호)
- **Service key**: Vercel env `SUPABASE_SERVICE_KEY` (development/preview/production)

## Deployment Protection
- **Vercel SSO Protection** = `all_except_custom_domains`
  - `*.vercel.app` URL은 SSO 게이트로 보호. 커스텀 도메인 (`www.canadayouthhire.ca`)만 공개
  - 즉 preview 배포는 Vercel 계정 SSO 통과해야 접근 가능
- **middleware.js Basic Auth** = SSO 통과 후 추가 게이트 (preview only, env `STAGING_USER`/`STAGING_PASS`)
  - production에서는 short-circuit (apex→www redirect만)
  - 2026-04-30: `gks125412` 누출 후 새 32자 random 비번으로 로테이션 완료

## Vercel Env Variables (현재 상태)

| Key | development | preview | production | 비고 |
|---|---|---|---|---|
| SUPABASE_URL | ✓ | ✓ | ✓ | |
| SUPABASE_SERVICE_KEY | ✓ | ✓ | ✓ | |
| STRIPE_SECRET_KEY | ✓ | ✓ | ✓ | |
| STRIPE_WEBHOOK_SECRET | ✓ | ✓ | ✓ | |
| CRON_SECRET | ✓ | ✓ | ✓ | |
| EMAILJS_SERVICE_ID | ✗ | ✗ | ✓ | |
| EMAILJS_PUBLIC_KEY | ✗ | ✗ | ✓ | |
| EMAILJS_PRIVATE_KEY | ✗ | ✓ | ✓ | |
| EMAILJS_TEMPLATE_GENERAL | ✗ | ✗ | ✓ | |
| TURNSTILE_SITE_KEY | ✗ | ✗ | ✓ | client widget 미연결 |
| TURNSTILE_SECRET_KEY | ✗ | ✗ | ✓ | server verify 활성 |
| ADMIN_API_KEY | ✗ | ✗ | ✓ | |
| STAGING_USER | ✗ | ✓ | ✗ | preview Basic Auth |
| STAGING_PASS | ✗ | ✓ | ✗ | preview Basic Auth |
| ALERT_PHONE | ✗ | ✗ | ✗ | **누락** — alerts.js fail-closed |
| ALERT_PHONE_EMAIL | ✗ | ✗ | ✗ | **누락** — SMS 알람 silent |
| TWILIO_SID | ✗ | ✗ | ✗ | **누락** — voice 알람 silent |
| TWILIO_TOKEN | ✗ | ✗ | ✗ | **누락** |
| TWILIO_FROM | ✗ | ✗ | ✗ | **누락** |

## EmailJS
- 별도 계정 (TurtleJobs와 분리): `ideamakerhan2`
- Service ID: `service_pbhgrg2`
- Templates: `template_welcome`, `template_reset` (비밀번호 리셋용)

## 도메인 / DNS
- `canadayouthhire.ca` IONOS 등록 (만료 2027-04-23)
- DNS A/CNAME → Vercel
- 세부 ID는 `.env.domain` (gitignored)
