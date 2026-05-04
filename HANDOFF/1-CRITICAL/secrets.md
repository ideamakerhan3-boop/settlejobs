# Secrets / Token Locations

## 토큰 직접 사용 금지
- 채팅에 echo 안 함
- "사용자가 준 토큰" / "Vercel CLI 토큰" 등 추상적 지칭만

## 위치
- **Vercel CLI 토큰**: `C:/Users/ideam/AppData/Roaming/com.vercel.cli/Data/auth.json`
  - `vercel whoami` 실행 시 자동 갱신
  - 만료 (`expiresAt` UNIX ms) — 만료 시 401, refresh token으로 자동 갱신됨
  - REST API 사용법: `Authorization: Bearer $TOKEN`
- **Supabase 접근**: MCP `mcp__693286dd-...` 도구 사용 (project_id `xouvuqqkbtaikrnnueda`)
- **Vercel 접근**: MCP `mcp__d63f8df7-...` 도구 또는 REST API

## 사용 패턴
```bash
TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('C:/Users/ideam/AppData/Roaming/com.vercel.cli/Data/auth.json','utf8')).token)")
curl -sS -H "Authorization: Bearer $TOKEN" "https://api.vercel.com/v9/projects/prj_uFFCDb0S7HXCnArzr5VRSUwA5mJb/env?teamId=team_zsrOjeC2B4XqPmzfXE9e8lVw"
```

## Vercel CLI 비대화형 한계
- `vercel env add` 비대화형으로 깨짐 (`{status:"action_required", reason:"git_branch_required"}`)
- → REST API 우회 필수 (위 패턴 사용)
- env 추가 시 `?upsert=true` 쿼리로 기존 값 교체

## 안전 행동
- env 변경은 사용자 명시 승인 필요 (시스템이 agent의 prod env 쓰기 차단함)
- agent-inferred 값 production env에 쓰기 금지
- preview env 쓰기는 OK (스테이징 한정)
