# Live Slack session, 2026-09-13 20:18 to 20:26 UTC

The eval calls the approval function directly. This session goes through the real path: the card is posted in Slack, Approve is pressed in Slack (with its confirm dialog), and the Socket Mode server does the rest. Recorded for the demo video. Stripe is in test mode.

## A. A teammate credits first (run `run_mu099wbk_620483`, Acme Inc)

1. `A_demo.log`: the thread is posted and Claude's verdict is PASS. The card is posted.
2. `C06_manual_credit.log`: at 20:22:01 UTC a $1,000 credit without TwiceShy metadata is added to the Acme Inc Stripe customer, standing in for a teammate crediting by hand (`stripe-teammate-credit-acme.png`).
3. `A_approvals.log`: Approve pressed at 20:23:14, run blocked at 20:23:15.
4. `slack-card-stopped.png`: "Stopped: Acme Inc was already credited $1,000. Nothing was credited and no reply was sent." The ledger (`run_mu099wbk_620483.jsonl`) has the run intent and the failed line, and no step was executed.

## B. The server dies after Stripe accepted the credit (run `run_mu09i54n_2ed9eb`, Wayne Retail)

1. `B_demo.log`: thread posted, verdict PASS, card posted.
2. `B_crash_server.log`: server started with `--crash-after lost-response:stripe_credit`. Approve pressed at 20:25:21, `EXECUTE stripe_credit`, `CRASH lost-response:stripe_credit`, exit code 137. The ledger had only `stripe_credit intent`.
3. `B_resume_server.log`: plain restart. `RECONCILED stripe_credit -> cbtxn_1UFJy0QL5bFVYvXnsKhhGz51` (found in Stripe by run ID), then the HubSpot note and the Slack reply, `Resume finished: done`.
4. `stripe-one-credit-wayne.png`: one credit for Wayne Retail. `slack-card-credited-after-crash.png`: "Credited $1,000 to Wayne Retail ... Resumed after an interruption; nothing was done twice."
