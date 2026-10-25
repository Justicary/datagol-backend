---
title: "Telegram webhook CPU throttling, OpenRouter reasoning tokens, and Supabase IPv4 pooler in Cloud Run"
author: Victor
date: 2026-10-25
branch: main
id: l-7129e004
scope: repo
status: active
src: agent
touches:
  - AGENTS.md
  - "__tests__/database-url.test.ts"
  - "__tests__/llm-adapters.test.ts"
  - db/schema.md
  - src/app.ts
  - src/jobs/index.ts
  - src/lib/database-url.ts
  - src/lib/tool-auth.ts
  - src/services/entitlements.ts
  - src/services/llm-config-service.ts
---

## Decided
- Execute `processTelegramUpdateJob` (`src/jobs/process-telegram-update.ts`) inline inside `POST /webhooks/telegram/:webhookToken` (`src/routes/webhooks/telegram.ts`) after enqueueing in `pg-boss`, while `registerProcessTelegramUpdateWorker` checks `webhook_events.processed_at` before running so messages are never processed twice. This keeps 100% CPU allocated in Cloud Run Dev Mode (`--min-instances=0 --cpu-throttling`, $0/month) during the ~2s LLM + Telegram reply cycle.
- Pass `reasoning: { effort: 'low' }` in `OpenAiCompatibleAdapter.complete` (`src/services/llm/adapters/OpenAiCompatibleAdapter.ts`) when `baseUrl` targets `openrouter.ai`, and set `TRANSLATION_MAX_OUTPUT_TOKENS = 1500` in `src/services/reports/nl-translation-service.ts` (`NARRATIVE_MAX_OUTPUT_TOKENS = 800` in `src/services/reports/nl-narrative-service.ts`).
- Use the Supabase IPv4 Session Pooler (`aws-0-us-east-2.pooler.supabase.com:5432`, user `postgres.<project_ref>`) for `DATABASE_URL` in Cloud Run and decode percent-encoded characters (`%3F`, `%2F`, `%21`) in `parseDatabaseUrl` (`src/lib/database-url.ts`).
- Authorize all organization members with `owner` or `admin` role and `use_nl_reports` permission via `getPermissionsForMember` (`src/services/permission-service.ts`, RPC `public.member_permissions_in_org`) in `authorizeTelegramMessageSender` (`src/services/telegram/telegram-identity-service.ts`).

## Tried and ruled out
- Relying solely on asynchronous `pg-boss` background polling after returning `200 OK` in `src/routes/webhooks/telegram.ts` under Cloud Run `--cpu-throttling`: Cloud Run throttles container CPU to near zero as soon as the HTTP response closes, stalling `processTelegramUpdateJob` until another HTTP request arrives.
- Connecting from Cloud Run directly to `db.<project_ref>.supabase.co:5432`: the direct Supabase host only publishes IPv6 `AAAA` records, and Cloud Run lacks IPv6 egress by default, causing `getSecret()` (`src/services/secret-service.ts`) and `pg-boss` to time out.
- Passing `reasoning: { effort: 'none' }` to OpenRouter when `model` is `openrouter/auto`: OpenRouter returns HTTP 400 (`Reasoning is mandatory for this endpoint and cannot be disabled`) when `openrouter/auto` routes to mandatory-reasoning models like `z-ai/glm-5.3-flash`. Without `reasoning: { effort: 'low' }`, a 600-token cap is completely consumed by `message.reasoning` (`finish_reason: "length"`), returning `message.content: null`.

## Watch out
- `public.member_permissions_in_org(p_org_id, p_user_id)` in `db/migrations/75_telegram_channel.sql` is `SECURITY DEFINER` and restricted exclusively to `service_role`; never grant it to `authenticated` or `anon`.
