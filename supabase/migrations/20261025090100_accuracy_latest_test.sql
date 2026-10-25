-- Phase 9 · 90 — the accuracy report counts only the latest test (9b.2 fix).
--
-- A test re-checks every decided item and refreshes its row (created_at = now()); items no longer in the
-- test (e.g. CEFT debits rebooked as transfers in "Check past bookings") kept their old rows, and the report
-- went on counting them against the AI. The latest test = the rows saved within 6 hours of the household's
-- newest one (the same window the test uses to carry on in batches). Older rows stay, unused.

create or replace view public.v_match_accuracy
with (security_invoker = true) as
  select e.household_id, e.task, count(*)::integer as n,
         count(*) filter (where e.rule_correct is not null)::integer as rule_answered,
         count(*) filter (where e.rule_correct)::integer as rule_correct,
         count(*) filter (where e.ai_correct is not null)::integer as ai_answered,
         count(*) filter (where e.ai_correct)::integer as ai_correct,
         count(*) filter (where (e.ai ->> 'confidence')::numeric >= 0.9)::integer as sure_n,
         count(*) filter (where (e.ai ->> 'confidence')::numeric >= 0.9 and e.ai_correct)::integer as sure_correct,
         max(e.created_at) as tested_at,
         count(*) filter (where (e.ai ->> 'main_correct')::boolean)::integer as ai_main_correct,
         count(*) filter (where e.truth ->> 'evidence' = 'true')::integer as evidence_n,
         count(*) filter (where e.truth ->> 'contradicted' = 'true')::integer as contradicted_n,
         count(*) filter (where e.truth ->> 'no_shop' = 'true')::integer as no_shop_n
    from public.match_eval e
   where e.created_at >= (select max(x.created_at) - interval '6 hours' from public.match_eval x
                           where x.household_id = e.household_id)
   group by e.household_id, e.task;

create or replace view public.v_match_accuracy_pattern
with (security_invoker = true) as
  select e.household_id, e.task, coalesce(e.ai ->> 'pattern', 'rule') as pattern, count(*)::integer as n,
         count(*) filter (where coalesce(e.ai_correct, e.rule_correct))::integer as correct
    from public.match_eval e
   where e.created_at >= (select max(x.created_at) - interval '6 hours' from public.match_eval x
                           where x.household_id = e.household_id)
   group by 1, 2, 3;

update public.app_meta set value = '90' where key = 'schema_version';
