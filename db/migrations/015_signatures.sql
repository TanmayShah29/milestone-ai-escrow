-- Signing the terms with a key, not just a link (src/lib/contract/signatures.ts): a person signs with a
-- passkey (WebAuthn), an AI agent with its own ES256 key. Each signature is kept with what it signed, so
-- anyone can check it against the published public key (GET /api/proof/<id>, src/lib/proof/verify.ts).

create table party_keys (
  id             bigserial primary key,
  milestone_id   uuid not null references milestones (id) on delete cascade,
  role           text not null check (role in ('client', 'worker')),
  kind           text not null check (kind in ('passkey', 'agent')),
  credential_id  text not null,               -- passkey credential id, or the agent key's JWK thumbprint
  public_jwk     jsonb not null,              -- ES256 public key (P-256)
  cose_key       text,                        -- passkey: the COSE public key, base64url, as WebAuthn checks it
  counter        bigint not null default 0,   -- passkey signature counter (0 for most platform passkeys)
  transports     text[],
  created_at     timestamptz not null default now(),
  unique (milestone_id, role, credential_id)
);

-- The one open WebAuthn challenge per milestone, side and purpose; replaced by each new request.
create table signing_challenges (
  milestone_id   uuid not null references milestones (id) on delete cascade,
  role           text not null check (role in ('client', 'worker')),
  purpose        text not null check (purpose in ('register', 'sign')),
  challenge      text not null,               -- base64url, as sent to the authenticator
  statement      text,                        -- sign: the terms statement whose sha256 is the challenge
  expires_at     timestamptz not null,
  primary key (milestone_id, role, purpose)
);

create table term_signatures (
  id                  bigserial primary key,
  milestone_id        uuid not null references milestones (id) on delete cascade,
  role                text not null check (role in ('client', 'worker')),
  terms_hash          text not null,
  kind                text not null check (kind in ('passkey', 'agent')),
  credential_id       text not null,
  -- What was signed. Passkey: the challenge is base64url(sha256(statement)); agent: the statement itself.
  statement           text not null,
  rp_id               text,
  authenticator_data  text,                   -- base64url (passkey)
  client_data_json    text,                   -- base64url (passkey)
  signature           text not null,          -- base64url: DER for a passkey, r || s for an agent key
  created_at          timestamptz not null default now()
);
create index term_signatures_milestone_idx on term_signatures (milestone_id, created_at);

-- The GitHub account the worker signed as: a submitted pull request must be opened by it.
alter table milestones add column worker_github_login text;
