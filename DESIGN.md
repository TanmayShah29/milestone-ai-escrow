# Design system: Security print

Milestone's interface treats each milestone as a sealed financial instrument rather than a dashboard row:
security-paper ground, intaglio ink, money set large, and a seal drawn from the contract's fingerprint.
Product truth lives in `PRODUCT.md`; the direction contract is in `docs/design/deal-room.brief.md`.

## Tokens (`src/app/globals.css`)
| Token | Light | Dark | Use |
|---|---|---|---|
| `paper` | #eef3f1 | #0f1a24 | Page ground (security paper) |
| `panel` | #f8fbfa | #15222e | Sections, inputs |
| `ink` | #13233a | #e4ecea | Text, primary action (the one accent) |
| `ink-2` | #4a5b6e | #a7b6c0 | Secondary text (≥6.2:1) |
| `ink-3` | #56656f | #8597a3 | Tertiary text, timestamps (≥5.3:1) |
| `rule` / `rule-strong` | #c9d6d2 / #a9bbb6 | #2a3a46 / #3a4d5a | Hairlines, borders |
| `held` / `held-field` | #8a5a12 / #f3e3c3 | #e7b766 / #3b2e17 | Money on hold |
| `paid` / `paid-field` | #1e6b4e / #d6eadf | #7fcfa6 / #183a2c | Captured, paid, pass |
| `failed` / `failed-field` | #b4232c / #f6dcdd | #f19197 / #3d1c20 | Fail, injection, returned payout |
| `blocked` / `blocked-field` | #56656f / #e2e9ec | #8597a3 / #213039 | Cancelled, waiting behind a gate |
| `focus` | #2e6db4 | #8ab8ef | Focus rings, caret |
| `seal` / `seal-2` | #1e6b4e / #13233a | #7fcfa6 / #c7d4dc | Guilloche threads |
Shell: navy header `#13233a` with `#e4ecea` brand and `#b9c7cf` links (9.1:1). All text pairs meet WCAG 2.2 AA
in both themes (checked Oct 21).

## Type
- **Public Sans** (400–700) for everything, tabular figures by default (`font-variant-numeric: tabular-nums`).
  Display: 4xl–6xl semibold, tight tracking; amounts 3xl–5xl semibold.
- **Geist Mono** only for data: PayPal ids, hashes, test paths, code. Never as decoration.

## Signature move
`GuillocheSeal` (`src/components/GuillocheSeal.tsx`, geometry in `src/lib/client/seal.ts`): three bands of
phase-shifted waves `r(θ) = R + A·sin(kθ + φ)` whose radius, amplitude, frequency and twist come from the
SHA-256 bytes of the terms. Pale and dashed until both sides sign; inked when sealed. It appears once per
screen (the deal room's side column, the landing cheque); never as a background or a repeated ornament.
The landing cheque borrows the same thread language for its border bands.

## Components
- `MoneyTracker` / `StatusPill` (`src/components/MoneyTracker.tsx`): five steps Agree → Fund → Deliver → Verify →
  Release; done = filled paid green with a check, current = ink ring, upcoming = hairline.
- Deal room (`src/app/milestones/[id]/`): `NextStep` (one action per role, the only shadowed panel),
  `MoneyPanel` (state-tinted: held amber, paid green), `ContractSeal`, `TermsCard`, `VerdictTable`
  (certificate table, stacked list under `sm`), `ProofTrail` (date · event · reference).
- `DemoTour` (`src/components/DemoTour.tsx`): non-modal bottom-right panel; dismissible.
- Language: every state and event goes through `src/lib/client/states.ts`; no raw state names in the UI.

## Layout and rules
- Max width 6xl; deal room = main column + 22rem sticky side column; single column under `lg`, with the money
  panel moved directly under the next step.
- Borders are 1px hairlines; radius `md` for controls, `lg` for sections, `xl` only for the landing cheque.
- One shadowed element per screen (the next-step panel, or the cheque on the landing page).
- Motion: one moment per page (the landing cheque's conditions passing and its stamp); everything else is
  instant. `prefers-reduced-motion` shows final states.
- Refused: eyebrow labels, card grids as page structure, gradient text, emoji icons (lucide only).
