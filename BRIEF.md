# TwiceShy: system and reliability brief

**One line.** TwiceShy pays each customer exactly once, even when a teammate got there first or the server crashes.

## System

After an outage, customer success teams promise SLA credits in shared Slack threads. TwiceShy settles one thread end to end across four apps:

1. **Claude (Haiku 4.5) resolves the thread with tools.** It reads Slack, searches HubSpot for the company (there may be two Acmes), picks the Linear incident by the time the customer describes, and finds the promise in force. It proposes; it never writes.
2. **Code verifies.** Every ID must exist, HubSpot must link the company to the Stripe customer, the incident must list the company as affected, and the promise quote must appear verbatim in the stated message by the stated author.
3. **Policy sets the money.** SLA tier from HubSpot times severity from Linear. Role caps apply to promises.
4. **A guard returns PASS, HOLD or BLOCK** (duplicate credit, amount vs policy, promise authority, account identity), and posts a card in Slack.
5. **A human approves in Slack.** Never the author of the promise. On Approve, TwiceShy re-reads Stripe, HubSpot and Linear and stops if anything changed.
6. **A crash-safe runner** writes the Stripe credit, the HubSpot note and the Slack reply once each: a fsynced write-ahead ledger, the run ID on every object, and lookup by run ID after a restart.

## Reliability

All numbers are from one live eval at the submitted code (commit 3f333da): 11 scenarios, k=3, 66 runs against real Slack, HubSpot, Linear and Stripe test mode, with the final state read back from the apps. [results.md](eval/results/2026-09-13T19-33-04-265Z/results.md)

| | TwiceShy | Same flow without TwiceShy |
|---|---|---|
| Correct verdict | 33 of 33 | cannot hold or block |
| Wrongly blocked cases that should be paid | 0 of 15 | n/a |
| Credited the wrong account, more than owed, or twice | 0 of 33 | 12 of 33 |
| Dollars over-credited | $0 | $9,750 |
| Duplicate Stripe credits | 0 | 0 (its idempotency key works) |

- **Real crash, live.** The server is killed after Stripe accepted the credit but before the ledger recorded it. On restart it found the credit in Stripe by run ID: 3 of 3 live runs with one credit, one note, one reply ([eval](eval/results/2026-09-13T19-17-51-324Z/results.md)), plus one run through the real Slack button ([evidence](docs/evidence/2026-09-13-live-slack-session/README.md)).
- **Teammate race, live.** A credit made by hand after the card was posted: Approve stopped, nothing was credited, no reply was sent ([evidence](docs/evidence/2026-09-13-live-slack-session/README.md)).
- **CI** runs 32 tests on every push, including a child process that exits with code 137 at four points, and two offline demos that need no keys.
- **Failure found and fixed today.** Claude once submitted the wrong incident ID while its reasoning named the right one; the guard blocked it. Claude now submits the readable identifier and code maps it. Re-run: 9 of 9, then 33 of 33 in the full eval.

## Limitations

- The eval threads were written by us, and each guard check has a scenario built for it. The sample is small (k=3).
- The workspace has one real person, so the eval and demo allow self-approval; the default blocks it. The eval calls the approval function directly; the Slack button path is shown in the logged live session and the video.
- The guard can only hold a promise Claude reports. Re-verification on Approve narrows the check-to-use window; it does not close it.
- No automatic money reversal, and no Reject button.

Full detail, architecture and sources: [README.md](README.md). Demo video: https://youtu.be/NWAxSzs71Pc
