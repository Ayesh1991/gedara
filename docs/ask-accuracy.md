# Ask Gedara — accuracy

Run 2026-11-04T02:54 UTC · today 2026-11-04 · numbers on **prod** (read-only, rolled back) · plans from the staging function.

**64 of 66 right (97 %)** · Sinhala 9 of 10 · held-out (never tuned on) 16 of 16.
Release bar: ≥ 95 % right, ≥ 7 of 8 in Sinhala, every refusal correct.

"Right" = the plan reads the question the way the hand-written truth does AND the number on screen equals the truth.

| | id | question | plan | model |
|---|---|---|---|---|
| ✓ | veg-june | How much did we spend on vegetables since June? | ask_spend(about=vegetables, from=2026-06-01, to=2026-11-04) | groq |
| ✓ | petrol-oct | How much did we spend on petrol in October? | ask_spend(about=petrol, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | dining-last-month | What did we spend on dining out last month? | ask_spend(about=dining out, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | electricity-april | How much went on electricity since April? | ask_spend(about=electricity, from=2026-04-01, to=2026-11-04) | groq |
| ✓ | subs-year | How much have we paid for subscriptions this year? | ask_spend(about=subscriptions, from=2026-01-01, to=2026-11-04) | groq |
| ✓ | education-year | Education spending this year? | ask_spend(about=education, from=2026-01-01, to=2026-11-04) | groq |
| ✓ | rent-may | What did we pay for house rent since May? | ask_spend(about=house rent, from=2026-05-01, to=2026-11-04) | groq |
| ✓ | milk-aug | How much did we spend on milk since August? | ask_spend(about=milk, from=2026-08-01, to=2026-11-04) | groq |
| ✓ | water-bill-total | How much were the water bills from June to October? | ask_spend(about=water bill, from=2026-06-01, to=2026-10-31) | groq |
| ✓ | cargills-july | How much did we spend at Cargills since July? | ask_spend(about=cargills, from=2026-07-01, to=2026-11-04) | groq |
| ✓ | keells-month | How much did we spend at Keells? | ask_spend(about=keells, from=2026-11-01, to=2026-11-04) | groq |
| ✓ | all-sept | Spending by category in September | ask_spend(from=2026-09-01, to=2026-09-30, group=category) | groq |
| ✓ | top-shop-oct | Which shop did we spend the most at in October? | ask_spend(from=2026-10-01, to=2026-10-31, group=shop) | groq |
| ✓ | last-week | How much did we spend in the last week? | ask_spend(from=2026-10-28, to=2026-11-04) | groq |
| ✓ | clothing-year | How much did we spend on clothes this year? | ask_spend(about=clothing, from=2026-01-01, to=2026-11-04) | groq |
| ✓ | petrol-last3 | Show the last 3 petrol bills | ask_transactions(about=petrol, from=2025-11-04, to=2026-11-04, limit=3) | groq |
| ✓ | water-last | When did we last pay the water bill? | ask_transactions(about=water bill, from=2025-11-04, to=2026-11-04, limit=1) | groq |
| ✓ | due-month | What's due this month? | ask_due(from=2026-11-04, to=2026-11-30) | groq |
| ✓ | due-dec | What do we have to pay in December? | ask_due(from=2026-12-01, to=2026-12-31) | groq |
| ✓ | due-jan | How much are the instalments in January? | ask_due(from=2027-01-01, to=2027-01-31) | groq |
| ✓ | toyota-end | When does the Toyota instalment end? | ask_instalments(about=toyota) | groq |
| ✓ | luxury-left | How much is left to pay on the Luxury X plan? | ask_instalments(about=luxury x plan) | groq |
| ✓ | boc-loan-owed | How much do we still owe on the BOC loan? | ask_instalments(about=boc loan) | groq |
| ✓ | insurance-left | How many insurance instalments are left? | ask_instalments(about=insurance) | groq |
| ✗ | pgim-end | When does the PGIM plan finish? | ask_instalments(about=pgim plan) | groq |
| ✓ | instalments-monthly | How much do we pay in instalments every month? | ask_instalments() | groq |
| ✓ | find-ram | Where is the laptop RAM? | ask_find(about=laptop ram) | groq |
| ✓ | find-housemaid | Where is the Housemaid book? | ask_find(about=housemaid book) | groq |
| ✓ | find-rekha | Where is the Rekha Wuntakal MRCOG book? | ask_find(about=rekha wuntakal mrco g book) | groq |
| ✓ | stock-keeri | How much keeri samba rice is left? | ask_find(about=keeri samba rice) | groq |
| ✓ | stock-dhal | How much red dhal do we have? | ask_find(about=red dhal) | groq |
| ✓ | runout-week | What runs out this week? | ask_pantry(view=runout, within_days=7) | groq |
| ✓ | expiring-2w | What expires in the next two weeks? | ask_pantry(view=expiring, within_days=14) | groq |
| ✓ | below-min | Which pantry items are below their minimum? | ask_pantry(view=below_min, within_days=7) | groq |
| ✓ | bal-boc | How much is in BOC savings? | ask_balances(about=boc savings) | groq |
| ✓ | bal-seylan | How much do we owe on the Seylan card? | ask_balances(about=seylan card) | groq |
| ✓ | bal-flex | What's the balance of the BOC Flex wallet? | ask_balances(about=boc flex wallet) | groq |
| ✓ | budget-none | Are we over budget this month? | ask_budget() | groq |
| ✓ | warranty-3m | Which warranties end in the next 3 months? | ask_warranty(within_days=90) | groq |
| ✓ | refuse-write | Book Rs 500 for fish today | refusal write | groq |
| ✓ | refuse-house | Is the front door open? | refusal house | groq |
| ✓ | refuse-private | Show me the SMS messages from BOC | refusal private | groq |
| ✓ | si-veg-june | ජූනි සිට එළවළු වලට කීයක් වියදම් කළාද? | ask_spend(about=vegetables, from=2026-06-01, to=2026-11-04) | groq |
| ✓ | si-petrol-oct | ඔක්තෝබර් මාසයේ පෙට්‍රල් වලට කීයක් ගියාද? | ask_spend(about=petrol, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | si-due-month | මේ මාසේ ගෙවන්න තියෙන්නේ මොනවද? | ask_due(from=2026-11-04, to=2026-11-30) | groq |
| ✓ | si-toyota | Toyota වාරික ඉවර වෙන්නේ කවදද? | ask_instalments(about=toyota) | groq |
| ✓ | si-boc-loan | BOC ණය තව කීයක් ගෙවන්න තියෙනවද? | ask_instalments(about=boc loan) | groq |
| ✓ | si-keeri | කීරි සම්බා හාල් කීයක් ඉතුරුද? | ask_find(about=keeri samba rice) | groq |
| ✓ | si-boc-bal | BOC ඉතුරුම් ගිණුමේ කීයක් තියෙනවද? | ask_balances(about=boc savings) | groq |
| ✗ | si-runout | මේ සතියේ ඉවර වෙන්නේ මොනවද? | ask_warranty(within_days=7) | groq |
| ✓ | h-restaurant-sep (held-out) | How much did we spend on restaurants in September? | ask_spend(about=restaurants, from=2026-09-01, to=2026-09-30) | groq |
| ✓ | h-veg-oct (held-out) | What did we spend on vegetables last month? | ask_spend(about=vegetables, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | h-bread-july (held-out) | How much on bread and bakery since July? | ask_spend(about=bread, from=2026-07-01, to=2026-11-04) + ask_spend(about=bakery, from=2026-07-01, to=2026-11-04) | groq |
| ✓ | h-laugfs-oct (held-out) | How much did we spend at Laugfs in October? | ask_spend(about=laugfs, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | h-google-year (held-out) | How much did Google One cost us this year? | ask_spend(about=google one, from=2026-01-01, to=2026-11-04) | groq |
| ✓ | h-mobile-oct (held-out) | How much did we spend on mobile and telephone in October? | ask_spend(about=mobile, from=2026-10-01, to=2026-10-31) + ask_spend(about=telephone, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | h-abans-end (held-out) | When does the ABANS plan end? | ask_instalments(about=abans) | groq |
| ✓ | h-hds-left (held-out) | How many HDS instalments are left? | ask_instalments(about=hds) | groq |
| ✓ | h-toyota-left (held-out) | How much is left on the Toyota plan? | ask_instalments(about=toyota) | groq |
| ✓ | h-find-skills (held-out) | Where is the Basic practical skills book? | ask_find(about=basic practical skills book) | groq |
| ✓ | h-milkpowder (held-out) | How much milk powder do we have? | ask_find(about=milk powder) | groq |
| ✓ | h-bal-peoples (held-out) | What's the balance on the People's card? | ask_balances(about=people's card) | groq |
| ✓ | h-bal-cash (held-out) | How much cash do we have? | ask_balances(about=cash) | groq |
| ✓ | h-refuse-delete (held-out) | Delete the last bill | refusal write | groq |
| ✓ | h-si-veg-oct (held-out) | ඔක්තෝබර් මාසේ එළවළු වලට කීයද? | ask_spend(about=vegetables, from=2026-10-01, to=2026-10-31) | groq |
| ✓ | h-si-abans (held-out) | ABANS වාරික ඉවර වෙන්නේ කවදද? | ask_instalments(about=abans) | groq |

Not right: pgim-end, si-runout

Answers and truths (real amounts) are in playwright/.auth/ask-accuracy-detail.md on the PC only.
