# Bank SMS → Gedara (Phase 2b)

Bank and card SMS alerts reach Gedara in two ways. Both end in **Money › Alerts** (the review
inbox). Nothing is added to the ledger until you confirm it there.

| Way | For | How |
|---|---|---|
| **Live forwarding** | every new alert from now on | Android app "SMS to URL Forwarder" → `sms-ingest` Edge Function |
| **SMS backup file** | older alerts (e.g. 30 May – today), to match the "card" bills | "SMS Backup & Restore" .xml → Money › Import › Bank SMS |

Only these senders are accepted: `BOC` (savings ..319 and credit card ..8873), `SAMPCCTXN`
(Sampath ..6577), `PeoplesCard` (..1913) and `Seylan Bank` (..6029). OTP, PIN and password
messages are blocked on the phone, in the browser, in the Edge Function and in the database, so
they are never stored. The Flex wallet thread is not forwarded.

## A. Connect the phone (once, about 10 minutes)

1. On the laptop, open Gedara (production: https://gedara.vercel.app) → **Settings → SMS forwarding**.
2. Type a name, e.g. `Didula's Android`, and tap **Add phone**. A card appears with five boxes and
   copy buttons. **Leave this page open.** The secret is shown only once.
3. On the Android phone, install **F-Droid** from https://f-droid.org, then install
   **SMS to URL Forwarder** inside F-Droid. (It isn't on the Play Store because of Google's SMS rules.)
4. Open SMS to URL Forwarder, allow **SMS** permission and allow it to run in the background (tap
   "Allow" for battery optimisation).
5. Tap **+** (add a forwarding rule), then fill it in using the copy buttons on the laptop. To get
   text from the laptop to the phone, open Gedara on the phone, or email the values to yourself.
   - **Sender**: paste the *Sender (regular expression)* box and tick **Sender is a regular expression**.
   - **Webhook URL**: paste the *Webhook URL* box.
   - **Headers**: paste the *Headers (secret)* box. It looks like `{"X-Gedara-Device":"…"}`.
   - **JSON template**: paste the *JSON template* box.
   - **Text filter (regex)**: paste the *Text filter* box. This is what stops OTPs on the phone.
   - Leave retries at the default (10).
6. Save the rule. On the laptop, tap **I've copied everything**.
7. Wait for the next real bank SMS, or ask the bank app to send one (for example a small
   transfer). Within a few seconds:
   - Settings › SMS forwarding shows **Last seen …, 1 alerts**.
   - **Money › Alerts** shows the alert.
8. If "Ignored a message from …" appears on the Settings page, the bank used a sender name we
   don't know yet. Tell Claude that name; it is added to the allow-list, never anything else.

Lost the phone, or suspect the secret leaked? On the Settings page, tap **Remove**. The secret stops
working at once. Add the phone again to get a new one.

## B. Import older alerts (once)

1. On the phone, install **SMS Backup & Restore** (SyncTech) from the Play Store.
2. Choose **Back up** → **Messages only** → **Selected conversations**, then tick only **BOC,
   SAMPCCTXN, PeoplesCard, Seylan Bank** and save as XML (to Google Drive or the phone).
3. Get the .xml file onto the laptop (e.g. from Google Drive).
4. In Gedara, go to **Money → Import → Bank SMS**, choose the file, and optionally set **From** / **To**
   dates. The screen shows how many alerts per bank were found and what was left out (other
   conversations, OTPs, promotions). Tap **Send … bank alerts to the inbox**.
5. Importing the same file again is safe: duplicates are recognised.

## C. Review the inbox

**Money → Alerts** lists new alerts by day. Each one shows what it most likely is:

- **Matches <bill>**: the scanned bill or Sheet row with the same amount (±2 days). Tap **Link**.
  If the bill was in "Card — to be matched", it moves to the card named in the alert.
- **Transfer BOC → card, plus Rs 25 fee**: a BOC CEFT debit and the card's "payment received"
  are saved together as one transfer, with the Rs 25 fee as a separate expense.
- **Transfer BOC → Cash**: an ATM withdrawal.
- **Not in the ledger yet**: pick a category and tap **Save expense** (or **Save income**).
  Gedara remembers the category for that merchant.
- **USD charges** (e.g. Supabase): the rupee amount is worked out from the drop in "Balance
  Available". Check it against the statement if you want it exact.
- An amber note means the bank's balance doesn't follow from the previous alert: either an alert
  is missing or a card hold is still pending.

The gold **Accept N clear matches** button does all the unambiguous links and transfers at once.
The **Reviewed** tab can undo a link or an ignore. To undo a saved expense, delete it from the
transaction page; its alert returns to the inbox.

## Formats understood (parser version 1)

| Sender | Alerts |
|---|---|
| BOC | CEFT / Online Transfer Debit, No Book Deposit (money in), ATM Withdrawal: savings, with "Balance available" · Credit Card "Transaction approved … for USD/LKR … at …" with "Balance Available" |
| SAMPCCTXN | "Auth Pmt LKR … at …" · "Credited LKR … for PAYMENT RECEIVED" (DD-MON date without a year) |
| PeoplesCard | "trxn LKR … @ … [Av.Bal …]" · "Your Payment Received. Rs.… on DD-Mon-YYYY" (promotions ignored) |
| Seylan Bank | "debit Txn <id> of LKR … done on dd/mm/yyyy … at …" · "Thank you for your payment of LKR …" |

Any other message from these senders that contains an amount appears as **New kind of alert**.
Forward it to Claude so a parser can be added (BOC credit-card payments haven't been seen yet).
