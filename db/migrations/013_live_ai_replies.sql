-- The AI step of a judge's live run: the last reply per exact prompt (which names the commit's diff), so a busy
-- free model falls back to the verdict on the same commit instead of stalling the run (src/lib/demo-live.ts).

create table live_ai_replies (
  prompt_hash text primary key,
  reply       text not null,
  model       text not null,
  created_at  timestamptz not null default now()
);
