# Milestone: AI escrow for freelance work

A client funds a milestone with a PayPal **authorization hold**. The freelancer delivers a GitHub PR.
An AI reviewer checks the work against acceptance criteria both sides agreed up front. Fixed rules
(never the model) then **capture** the hold and **pay out** the freelancer, or send it back for changes.

Built for the PayPal AI Hackathon 2026. Work in progress: the money flow (hold → authorize → capture →
payout, void, reauthorize) is in; the AI reviewer, webhooks and Bryntum Gantt timeline are next.

## Stack
- Next.js 15 (app router) + TypeScript, Postgres
- PayPal server SDK (TypeScript, APIMatic-generated) for orders and payments; REST for payouts
- Built with the APIMatic Context Plugin in Claude Code
- Hosting: Render (planned)

## Run locally
```bash
npm install
cp .env.example .env        # fill in PayPal sandbox + OpenRouter keys
createdb milestone
npm run db:migrate
npm run dev                 # http://localhost:3000
```

Tests (uses a separate `milestone_test` database, PayPal faked at the fetch layer):
```bash
createdb milestone_test
npm test
```

## Money rules
1. The AI never moves money. Only deterministic code calls capture, void, payout or refund.
2. Every money-moving call sends a `PayPal-Request-Id` derived from the milestone and action, and is
   claimed in the DB first, so a double click or a retry can't move money twice.
3. Never capture more than was authorized. Payout = captured minus the platform fee.
4. Every PayPal id is stored on the milestone; every state change writes an audit-log row.

See `paypal-plan.md` for the full contract (idempotency, unknown-outcome handling, error mapping).

## License
MIT
