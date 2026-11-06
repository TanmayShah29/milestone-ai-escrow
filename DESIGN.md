# Design system: Clear ledger

Milestone reads like a precise financial instrument: a cool canvas, white surfaces, ink actions, and money
set large and tight. It evolved from "Security print" (Nov 6, 2026): the guilloche seal and the money states
stayed, and the chrome got quieter. Product truth lives in `PRODUCT.md`; the direction contract is in
`docs/design/deal-room.brief.md`.

## Tokens (`src/app/globals.css`)
| Token | Light | Dark | Use |
|---|---|---|---|
| `paper` | #f5f6f8 | #0a0f18 | Page canvas, inputs inside surfaces |
| `panel` | #ffffff | #111827 | Surfaces (sections, cards) |
| `ink` | #0a1628 | #eef1f6 | Text, and the primary action (the one accent) |
| `ink-2` | #475467 | #a8b2c2 | Secondary text |
| `ink-3` | #5e6878 | #8c97a8 | Tertiary text, timestamps |
| `rule` / `rule-strong` | #e3e7ed / #cdd3dc | #1f2937 / #2f3b4d | Hairlines, borders |
| `held` / `held-field` | #9a5b05 / #fdf1dc | #f0b45b / #33240c | Money on hold |
| `paid` / `paid-field` | #0b7a53 / #dff4ea | #5fd3a3 / #0f2f24 | Captured, paid, pass |
| `failed` / `failed-field` | #c0262d / #fde4e4 | #f59a9e / #3a1518 | Fail, injection, returned payout |
| `blocked` / `blocked-field` | #5e6878 / #eceff3 | #8c97a8 / #1a2230 | Cancelled, waiting behind a gate |
| `focus` | #2d5bd6 | #8fb0ff | Focus rings, caret (the only blue, never an accent) |
| `seal` / `seal-2` | #0b7a53 / #0a1628 | #5fd3a3 / #c8d2e0 | Guilloche threads |
| `--shadow-card` | soft, two layers | deeper | The one shadowed element per screen |

Radius sets hierarchy: controls `md` (10px), sections `lg` (14px), the landing cheque `xl` (20px).
Shell: a sticky translucent header on the canvas (`bg-paper/80` + blur) with a hairline under it, the mark
(a ring with a paid-green tick), quiet `ink-2` links, and the ink "New milestone" button. On phones only
Deals and Bounties show beside it.

## Type
- **Geist Sans** for everything, tabular figures by default, `ss01`/`cv11` alternates, slight negative
  tracking. Display and amounts track tighter (`h1` −0.032em; `h2` and `.money` −0.022em).
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
  `MoneyPanel` (state-tinted: held amber, paid green; the split is a receipt: label left, amount right,
  the worker's total under a rule), `ContractSeal`, `TermsCard`, `VerdictTable`
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
