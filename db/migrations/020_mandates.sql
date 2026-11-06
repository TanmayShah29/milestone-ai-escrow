-- Spending mandates and open bounties (V2_PLAN §3.H, §3.I). A person vaults a card once and signs a mandate
-- (its limits) with a passkey; an AI agent holding the mandate's token can then post bounties, and fixed code
-- funds each hold on the vaulted card, only within the signed limits (money rule 1 as amended Nov 6).

create table mandates (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  owner_token_hash      text not null unique,        -- the person's management link (mmo_)
  agent_token_hash      text unique,                 -- the agent's key (mmd_), issued once when signed
  max_per_bounty_cents  integer not null check (max_per_bounty_cents >= 1000),
  total_cents           integer not null,
  max_open_bounties     integer not null check (max_open_bounties between 1 and 50),
  allowed_repos         text[] not null,
  allowed_verifiers     text[] not null default '{code_pr}',
  expires_at            timestamptz not null,
  status                text not null default 'draft' check (status in ('draft', 'active', 'revoked')),
  -- The card vault's claim (paypal-plan.md, DUPLICATE CLAIMS): none → pending → done.
  vault_status          text not null default 'none' check (vault_status in ('none', 'pending', 'done')),
  vault_attempt         integer not null default 1,
  vault_id              text,
  card_last4            text,
  -- What the person signed, and the passkey that signed it (checkable by anyone: GET /api/mandates/<id>).
  document              jsonb,
  document_hash         text,
  credential_id         text,
  public_jwk            jsonb,
  cose_key              text,
  counter               bigint not null default 0,
  transports            text[],
  signature             jsonb,
  challenge             text,
  challenge_purpose     text,
  challenge_statement   text,
  challenge_expires_at  timestamptz,
  signed_at             timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table milestones
  add column mandate_id        uuid references mandates (id),
  add column open_bounty       boolean not null default false,
  add column claim_expires_at  timestamptz;

create index milestones_mandate_idx on milestones (mandate_id) where mandate_id is not null;
create index milestones_offered_idx on milestones (created_at) where state = 'OFFERED';
