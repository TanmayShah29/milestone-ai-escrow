-- The proof chain (src/lib/proof/): every audit_log row of a milestone also becomes a signed event, each
-- one carrying the hash of the one before, so anyone can check offline that the record was not edited,
-- reordered or cut short. Signing keys are ECDSA P-256 (ES256); public keys are published at
-- /.well-known/milestone-proof-keys.json.

create table proof_keys (
  id             text primary key,             -- first 16 hex chars of sha256(SPKI)
  alg            text not null default 'ES256',
  public_jwk     jsonb not null,
  -- Present only for a key the app generated itself (no PROOF_SIGNING_KEY set); an env key never lands here.
  private_pkcs8  text,
  created_at     timestamptz not null default now()
);

create table proof_events (
  milestone_id   uuid not null references milestones (id) on delete cascade,
  seq            int not null check (seq >= 1),
  audit_id       bigint references audit_log (id) on delete set null,
  body           text not null,                -- the exact canonical JSON that is hashed and signed
  body_hash      text not null,                -- sha256(body), hex
  prev_hash      text,                         -- body_hash of seq - 1; null only for seq 1
  key_id         text not null references proof_keys (id),
  sig            text not null,                -- ES256 over body: base64url of r || s
  -- Salt of the detail digest in body. Kept with the row so a reader holding the audit detail can check it.
  detail_salt    text,
  created_at     timestamptz not null default now(),
  primary key (milestone_id, seq),
  check ((seq = 1) = (prev_hash is null))
);

create unique index proof_events_audit_idx on proof_events (audit_id) where audit_id is not null;
