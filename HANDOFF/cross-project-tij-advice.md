# TIJ 세션이 본 것 → YouthHire에 적용 검토 권고

작성: 2026-05-03 (TIJ 자율 세션 — 추가 업데이트 같은 날). 두 사이트 코드 베이스 유사도가 높아서 TIJ에서 발견·해결한 보안 항목이 YouthHire에도 그대로 있을 가능성 큼. 토큰 절약 위해 결론만 적음. 적용 전 본 사이트에서 직접 확인 필수.

---

## 🆕 2026-05-03 PM 업데이트 — 오늘 TIJ에 적용한 함정 + 학습

### 🔥 PostgREST column-level GRANT의 함정 (TIJ에서 직접 겪고 1분간 prod 깨짐)

**함정**: REVOKE + 컬럼 화이트리스트 GRANT만 적용하면 클라이언트의 `_sb.from('jobs').select('*')`가 **401 permission denied**로 깨짐. 홈페이지 잡 리스트 빈 페이지.

**원인**: PostgREST는 `select=*`를 모든 컬럼 SELECT로 펼침 → anon이 권한 없는 컬럼(email/notified_expiry)에도 SELECT 요구 → Postgres 거부 → 전체 401.

**올바른 순서** (TIJ에서 학습한 룰):
1. **클라이언트 먼저**: `_sb.from('jobs').select('*')` → `_sb.from('jobs').select('id,job_id,title,...,28개 안전 컬럼')` 명시 화이트리스트로 변경, prod 배포 완료까지 대기
2. **그 다음 DB**: `REVOKE SELECT ON public.jobs FROM anon; GRANT SELECT (안전한 28컬럼) ON public.jobs TO anon;`
3. 검증:
   - `?select=*` → 401 (PII path 차단 증명) ✓
   - `?select=email` → 401 ✓
   - `?select=<28cols>` → 200, email 필드 없음 ✓

**롤백** (실수했을 때 1줄): `GRANT SELECT ON public.jobs TO anon;`

YouthHire에 같은 anon select 패턴 있으면 같은 순서로 가야 함. 반대로 가면 1분간 홈페이지 깨짐.

### 데이터 정리 패턴 (테스트 계정 일괄 삭제 — 트랜잭션 안전)

CTE + DELETE...RETURNING 으로 다 테이블 한 번에 정리. TIJ에서 18 테스트 계정 + 관련 row(jobs/credits/transactions/promo_usage) 삭제에 사용:

```sql
BEGIN;
WITH targets(email) AS (VALUES ('test1@x'),('test2@x') /*...*/),
del_promo AS (DELETE FROM public.promo_usage  WHERE email IN (SELECT email FROM targets) RETURNING 1),
del_txn   AS (DELETE FROM public.transactions WHERE email IN (SELECT email FROM targets) RETURNING 1),
del_cred  AS (DELETE FROM public.credits      WHERE email IN (SELECT email FROM targets) RETURNING 1),
del_jobs  AS (DELETE FROM public.jobs         WHERE email IN (SELECT email FROM targets) RETURNING 1),
del_acct  AS (DELETE FROM public.accounts     WHERE email IN (SELECT email FROM targets) RETURNING 1)
SELECT (SELECT count(*) FROM del_promo)..., ..., (SELECT count(*) FROM del_acct);
COMMIT;
```

장점: 단일 트랜잭션 (중간 실패 자동 롤백) + 삭제 카운트 즉시 확인.

### admin 권한 부여 (단일 row UPDATE — Supabase MCP)

```sql
UPDATE public.accounts SET is_admin = true
WHERE email = 'target@x'
RETURNING email, name, is_admin;
```
RETURNING으로 즉시 검증. 이미 로그인된 세션은 한 번 로그아웃 → 재로그인 필요 (localStorage 캐시 갱신).

### applyPromoCode 강한 가드 (today 적용)

다른 채널에서 권고한 패턴, TIJ에 적용 완료:
```js
if(!promoRes || promoRes.error || typeof promoRes.total !== 'number') {
  showToast('❌ Invalid or expired promo code.','error');
  return false;
}
```
NaN UI 방지. YouthHire도 동일 적용 권장 (이미 PR #18에서 했다고 들음 — 확인 필요).

### doForgot — `dbAcct.pw` 사용 제거

`get_profile` API는 `pw` 컬럼 안 돌려줌 → `dbAcct.pw`는 undefined. 어차피 다음 줄에서 tmp로 덮어쓰니까 dead code였음. 제거하면 의도 명확.

```js
// before:  _ACCOUNTS[em] = { pw: dbAcct.pw, name: ..., company: ... };
// after:   _ACCOUNTS[em] = { name: ..., company: ... };  // pw는 직후에 acct.pw=tmp로 세팅
```

---

---

## 1. 🚨 `jobs.email` PII 누출 (anon select '*') — **확인 권고**

TIJ에서 발견: 클라이언트의 `_sb.from('jobs').select('*').eq('status','active')`가 anon key로 호출돼서 `jobs.email` 컬럼 (포스터 계정 이메일)이 응답에 다 포함됨. RLS는 row-level만 막고 column은 안 막음. 누구든 anon key (HTML에 노출됨)로 PostgREST 직접 호출 → 모든 employer 계정 이메일 일괄 수집 가능.

**YouthHire 검증 1줄**:
```bash
curl -s "<YOUR_SUPABASE_URL>/rest/v1/jobs?status=eq.active&select=email,apply_email&limit=2" \
  -H "apikey: <ANON>" -H "Authorization: Bearer <ANON>"
```
응답에 `email` 필드가 (apply_email과 별도로) 나오면 누출 중. `email` 필드가 없거나 `null`이면 OK.

**Fix SQL** (적용 전 backup, 트랜잭션):
```sql
BEGIN;
REVOKE SELECT ON public.jobs FROM anon;
GRANT SELECT (
  -- 28개 안전 컬럼만 (TIJ 기준 — YouthHire 스키마 확인 후 조정)
  id, job_id, title, company, loc, prov, type, wage, category,
  description, status, posted_date, exp_date, created_at,
  apply_method, apply_email, apply_url, lang, edu, exp_req, vacancy,
  ai_use, remote, requirements, benefits, biz_city, biz_prov,
  posted_by_acc_company
) ON public.jobs TO anon;
COMMIT;

-- 검증
-- curl 위와 동일하게 → email 필드 없어야 함
-- 홈페이지 정상 작동 확인 (job 카드 렌더링)

-- 롤백 (문제 시)
-- GRANT SELECT ON public.jobs TO anon;
```

---

## 2. Pass-the-hash / bcrypt 마이그레이션 — **장기 보안 강화**

TIJ 진단: 클라이언트 SHA-256 해시를 서버가 그대로 DB에 저장 → DB 누출 시 해시 자체로 로그인 가능한 pass-the-hash. `bcrypt(received_hash, 12)`로 서버에서 추가 해시하면 DB 누출돼도 replay 불가.

TIJ에 lazy auto-upgrade 디자인 doc 있음: `Desktop/클로드 코드/코드/.claude/worktrees/nice-chaplygin-715992/HANDOFF/bcrypt-migration-plan.md` (단일 파일 변경 + 클라이언트 무변경 + 점진 마이그레이션).

YouthHire가 동일 SHA-256 구조면 같은 plan 그대로 적용 가능. 단, 라이브 auth 변경이라 staging soak 필수.

---

## 3. 공유 verify 헬퍼 (`api/_lib/verify.js`) — **리팩터 권장**

TIJ에 적용함 (PR #5 머지). auth-api / admin-api / credits-api / refund 4곳에 흩어져있던 `accounts.select + pw_hash compare` 인라인 패턴을 단일 `verifyAccount()` / `verifyAdmin()` 헬퍼로 통일. 효과:
- 보안 일관성 (한 곳만 고치면 전체 반영)
- bcrypt 마이그레이션 시 단일 진입점
- 코드 중복 제거

YouthHire 4개 API 파일도 비슷한 패턴이면 같은 리팩터 가능. 회귀 위험 낮음 (behavior-preserving). negative-auth smoke test로 검증.

---

## 4. Stale admin session auto-recover — **UX 개선**

TIJ 발견: localStorage `cjb_is_admin=1`인데 서버 admin-api가 403 반환하는 경우 (admin pw 회전, 권한 변경 등). 옛 코드는 빈 admin 패널 + 토스트 없음 → 유저 혼란.

Fix (TIJ에 적용됨, index.html `_handleStaleAdminSession`):
- 403 from `/api/admin-api` + 메시지 "admin" 매치 시
- localStorage cjb_is_admin 제거
- `_isAdminUser = false; _adminPwHash = null;`
- "Admin access expired" 토스트 + 홈으로 리다이렉트
- 일반 세션은 보존 (regular 로그인은 그대로 유지)

YouthHire에도 admin 분리됐다면 비슷한 stale 시나리오 존재. 적용 권장.

---

## 5. 추가로 TIJ에서 본 항목들 (참고만)

- **autofill cross-user email leak** — Chrome autofill이 prior 유저 이메일을 새 유저 공고 Application Email에 박던 버그. `!pjE.value` empty-check 제거 + setTimeout(0/150) 두 번 재적용. (TIJ PR #4)
- **fail-closed staging auth** — middleware.js 하드코딩 폴백 제거 (YouthHire는 이미 PR #3에서 했음, TIJ도 같은 패턴 적용)
- **3 Supabase 프로젝트 토폴로지** — TIJ Supabase에 `tijobs-staging`이라는 INACTIVE 프로젝트가 있어서 staging URL 오타 원인이었음. YouthHire도 비슷한 구조 잔재 있는지 확인 (Supabase 대시보드에서 list_projects)
- **package.json 누락 (장기 fragility)** — TIJ는 vanilla HTML이라 package.json 없음. Vercel build cache lineage가 살아있어서 작동. cache 만료 시 prod도 같이 깨짐. YouthHire는 React라서 이미 package.json 있을 가능성 — 체크만.

---

## 우선순위

1. **PII 누출 검증 (#1)** — 1분 curl로 가능. 누출 중이면 `본 서버 올려` 받고 SQL 적용
2. **Stale admin recovery (#4)** — 작은 client fix, 회귀 위험 낮음
3. **공유 verify 헬퍼 (#3)** — 리팩터, behavior preserving
4. **bcrypt 마이그레이션 (#2)** — 큰 작업, 별도 staging soak 필요

각 항목의 자세한 코드/SQL은 TIJ HANDOFF 참조: `Desktop/클로드 코드/코드/.claude/worktrees/nice-chaplygin-715992/HANDOFF/`
