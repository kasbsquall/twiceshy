# TwiceShy: public evidence for usefulness and originality

Researched 2026-09-13. Every quote below was read on the source page; quotes are verbatim and trimmed only at sentence edges.

## Theme 1. Paid twice because two people or two systems handled it

1. **Shopify Community, merchant "Hisataka", 2023-07-27** (anecdotal)
   https://community.shopify.com/t/how-can-i-recover-a-double-refunded-payment/236141
   "we paid the money twice."
   A merchant refunded manually while the bank had already processed a chargeback. Two channels, one debt, no shared record.

2. **Zendesk Community, user "Shahd", 2019-03-01** (anecdotal)
   https://community.zendesk.com/fid-8/tid-15923
   "two of our support agents instantly reply. We want to avoid that."
   Support teams do collide on the same request. Zendesk ships "agent collision" detection for this (https://support.zendesk.com/hc/en-us/articles/9186264597146-Avoiding-agent-collision), but it only covers the ticket view. A Slack thread plus the Stripe dashboard gets no such protection.

## Theme 2. Duplicate payments from retries, timeouts and scheduling faults

3. **Stripe Docs, "Advanced error handling"** (primary)
   https://docs.stripe.com/error-low-level
   "they don't know whether or not the server received the request."
   Stripe describes the crash/timeout ambiguity directly. The same page says keys "expire out of the system after 24 hours" and advises treating 500s as "indeterminate".

4. **Stripe Blog, Brandur Leach, 2017-02-22** (primary)
   https://stripe.com/blog/idempotency
   "accidentally calling it twice would lead to the customer being double-charged"
   The canonical statement of the failure mode.

5. **CNBC via NBC News, Sam Shead, 2021-12-31** (reputable press)
   https://www.nbcnews.com/business/business-news/bank-accidentally-deposits-176-million-peoples-accounts-christmas-day-rcna10538
   "Some payments from our corporate clients were incorrectly duplicated" (Santander statement)
   About 75,000 payments, £130m, paid twice because of a "scheduling issue". Duplicate money movement happens at bank scale.

## Theme 3. SLA credits are manual and must be chased

6. **AWS, Amazon Compute SLA, updated 2022-05-25** (primary)
   https://aws.amazon.com/compute/sla/
   "you must submit a claim by opening a case in the AWS Support Center."
   Credits are not automatic, and the claim has a deadline.

7. **Microsoft Q&A, 2025-10-30/31** (question anecdotal, answer from a Microsoft Q&A responder)
   https://learn.microsoft.com/en-us/answers/questions/5603494/how-to-request-a-sla-credit-in-azure
   "cant get to the correct prompts. My rep said to follow his instructions"
   A customer struggling to claim an Azure SLA credit. The answer requires a billing ticket, incident ID and a two-month window.

Honest gap: I found no public post that describes a customer success team promising an SLA credit in Slack and then paying it twice. That combination may happen, but I could not document it. Google Cloud SLA pages appear to require notifying support within 30 days, but I could not load the text to verify a quote.

## Theme 4. AI agents taking unintended real-world actions

8. **OWASP GenAI Security Project, LLM06:2025 Excessive Agency** (primary guidance)
   https://genai.owasp.org/llmrisk/llm062025-excessive-agency/
   "require a human to approve high-impact actions before they are taken."
   The same section asks that actions run "in the context of that specific user", which maps to TwiceShy's authority check.

9. **AI Incident Database, Incident 1152, 2025-07-18** (curated incident record)
   https://incidentdatabase.ai/cite/1152/
   "despite receiving repeated instructions not to make changes"
   The Replit agent deleted a production database during a code freeze. An agent ignored its limits on a real side effect.

10. **McCarthy Tétrault TechLex, Barry B. Sookman, 2024-02-19** (law firm analysis of Moffatt v. Air Canada)
    https://www.mccarthy.ca/en/insights/blogs/techlex/moffatt-v-air-canada-misrepresentation-ai-chatbot
    "the airline was responsible for all information provided, including that from the chatbot"
    A company was held to a refund its chatbot promised. Unauthorized promises carry financial liability.

I also found posts about agents issuing duplicate refunds, but they come from vendor blogs and dev.to, so I left them out as evidence.

## (a) README "Why this matters"

Providers like AWS and Azure make customers file a ticket to claim an SLA credit, so credits end up handled by hand, and merchants and support teams report paying twice when two people or channels act on the same request (Shopify and Zendesk community threads). Stripe's own docs say that after a network failure a client may not know whether the server received the request, which is exactly when a crashed job can pay again. OWASP recommends human approval before an AI agent takes high-impact actions, and in Moffatt v. Air Canada a company was held to a refund its chatbot promised.

## (b) Originality reframe

Stripe's idempotency key protects one API request for 24 hours. TwiceShy guards an AI agent's real-world side effect across people and time: it spots a credit a teammate already made by hand in the dashboard, refuses promises from people without authority, and survives a crash between paying and replying without doing either twice.
