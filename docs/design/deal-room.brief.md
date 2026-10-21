# Surface brief: milestone screens ("deal room"), landing, judge mode

Scope: `/milestones/[id]` (Operate), `/milestones`, `/new` (Operate), `/` landing and `/demo` (Persuade), `/timeline` shell.
Audience and job: see PRODUCT.md; the client leads. Constraints: never look like PayPal; WCAG 2.2 AA; full use at 390px.
Build path: code-led (Operate surface; no image generation available). Impeccable's binary was not run
(it downloads a prebuilt binary), so the concept roll, decision page and detector are unavailable; the
direction was chosen by the user from three grounded candidates plus the category standard.

## Direction contract

THESIS: The milestone is a sealed financial instrument, not a dashboard. Refuse the grey SaaS card grid; every
screen reads like a cheque or banknote: precise fine lines, money set large, a seal that proves the terms.

OWN-WORLD: Security-paper ground (pale mint-grey #EEF3F1), panels #F8FBFA, intaglio ink navy #13233A, secondary
ink #4A5B6E, hairline rules #C9D6D2. Money states: held amber (#8A5A12 text / #F3E3C3 field), paid banknote green
(#1E6B4E / #D6EADF), blocked slate #6B7A88, failed red #B4232C. One accent: the ink navy for primary actions.
Public Sans for the interface with tabular figures; Geist Mono only for ids, hashes and amounts in proof rows.

STORY: The client sees where the money is and what releases it, reads the sealed terms, follows a proof trail of
dated, referenced steps, and acts on the one next step; the worker sees the money is held before starting.

FIRST VIEWPORT: Header row: milestone title, amount large in tabular figures, human status pill, role switch.
Under it the five-step tracker (Agree, Fund, Deliver, Verify, Release). Main column: the Next step panel with
its single primary action. Right column: the money panel (where the money is now, expiry countdown, fee split,
PayPal references) with the terms seal below it. Phone: tracker, next step, money, then the rest stacked.

FORM: Security print, the user's choice (1 of 3 grounded candidates; category standard declined).
seed: none (unavailable)
Signature move: each contract's SHA-256 fingerprint is drawn as a unique guilloche seal (banknote rosette) generated
from the hash bytes; drawn dashed and pale until both sides sign, inked when sealed.
Raise from Certified mail: the activity feed is a proof trail, each step a dated mark with its reference id, linked.
Raise from Certificate of analysis: the verdict is a table (criterion, method, result, evidence) closed by the
sign-off line "Decided by fixed rules, not the model".

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
