# Free-tier notification delivery

Level 5 triggers now create a durable campaign in D1 and return immediately. The
`ews-alert-dispatch` Worker wakes `ews-alert-batches`, whose single consumer calls
the authenticated Pages `/api/internal/alert-jobs` endpoint. Each request processes
at most five subscribers (ten provider calls), with up to five sends in flight
and paced SMS starts. A five-minute recovery cron can
restart a campaign after a lost enqueue or an expired queue message. It does not
create alerts or fetch the public emergency signal.

The campaign's cursor advances only after the batch is recorded. Its lease
prevents overlapping consumers. Each delivery has a deterministic primary key
combining campaign, subscriber, and channel, claimed before contacting a provider.
Duplicate queue messages and repeated triggers do not repeat recorded deliveries.
A running campaign resumes even if the current emergency level has fallen. New
campaigns wait until 24 hours after completion; retries of the existing campaign
are not suppressed by that cooldown. The old last-sent metadata remains honored
when upgrading from the previous sender.

## Failure handling

Explicit HTTP 429 rejections retry at one-minute intervals, at most three attempts
per delivery. Permanent 4xx rejections become `failed`. Timeouts, connection loss,
5xx responses, and interrupted in-flight claims become `unknown`: provider
acceptance cannot safely be inferred from these failures. They count as errors
and appear in subscriber history. Do not automatically resend them; confirm the
outcome in SendGrid/Telnyx first. This is deliberately not an exactly-once delivery
claim: the providers and D1 do not participate in one transaction.

Other unfinished recipients continue. If D1 itself is unavailable, the queue and
cron retry the saved job. A database error after provider acceptance cannot cause
an automatic duplicate send. A subscriber who opts out before their batch is
selected is skipped. A subscriber who opts out between a rate-limit rejection
and its retry is not retried.

The dispatcher has no email/SMS provider credentials. It uses only
`INTERNAL_ALERT_TOKEN` to call Pages. Its public workers.dev endpoint is disabled.
Pages and the dispatcher must have the same internal token. No public endpoint
can start or advance a job without that token.

## Reads and writes

Delivery-status indexes were removed because no application query filters on
them. The provider-message index excludes NULL values, so pre-send claims do not
write it. The destination/channel index makes message history use direct lookups.
An ordering index makes subscriber pagination read only the requested window,
and the status/id index supports the campaign cursor. Exact contact search uses
the existing keyed hashes, preserving encrypted contact storage.

Callbacks no longer recount an entire campaign. A SQL trigger changes finalized
alert counters only when a delivery's contribution changes, in the same
transaction as that delivery update. Duplicate callbacks and late `sent` events
after a terminal result do not write. Finalizing a campaign performs one aggregate
recount; this also handles callbacks arriving during sending without stale totals.

Admin history polls once per minute, pauses in hidden tabs, prevents overlapping
requests, and only writes a read marker when opening/refreshing the view or reading a new reply. Subscriber summary
and chart results are reused for one minute across page changes; Refresh clears
that cache. Exact match is the default. Partial searches decrypt at most 25
candidate records per request and cache the complete matches in component memory
for a minute, so pagination does not scan again. Decrypted contacts are not stored
in shared caches or local storage.

D1's daily allowance is shared with other account usage. The synthetic capacity
test enforces less than 500,000 reads and 90,000 writes for a campaign at the current
size (5,327 subscribers, 5,056 emails, 5,054 SMS), including two SMS status events,
duplicate callbacks, and a 1% SMS failure rate. It also asserts fewer than 50 D1
queries and 50 external calls per batch and fewer than 5,000 estimated queue
operations. These are regression ceilings, not reserved account capacity.
Re-run the capacity test when subscriber counts, indexes, or retry policies change.
Index creation itself consumes a one-time D1 read/write allowance on migration day.

## Testing without sending messages

```
npm run test:notifications
npm run build
node tests/admin-free-tier.browser.cjs
npm run lint
wrangler deploy --config wrangler.alerts.toml --dry-run
```

The notification tests use an ephemeral local Miniflare D1 database, synthetic
contacts and keys, and a fetch stub that rejects any unexpected URL. All provider
responses are mocked. The browser test fulfills every request locally, rejects
non-GET API requests, and never visits the production site. The full capacity test
can take several minutes; it prints progress every 250 batches.

Never test by posting a synthetic level 5 snapshot to production. For a safe live
check, GET `/api/internal/alert-jobs` with internal authentication and inspect the
saved job status. An empty `job` means no campaign exists; it must remain empty
after deploying an otherwise idle system.

## Deployment

Create the queue once with `wrangler queues create ews-alert-batches`. Copy
`wrangler.production.toml` to the local ignored `wrangler.toml`, apply migrations,
and deploy `wrangler.alerts.toml`. Provision `INTERNAL_ALERT_TOKEN` using Wrangler's
stdin secret command; do not put secrets in configuration files. Deploy Pages
after the migration and dispatcher exist. The GitHub deployment workflow tests,
migrates, deploys the dispatcher, provisions its token from the existing GitHub
secret, and then deploys Pages. Snapshot workflows retain the same service binding.

The queue configuration is intentionally bounded to one consumer and one message
per batch. Increasing consumer concurrency without redesigning the lease and SMS
pacing will not improve throughput. Queued wake messages contain only an alert ID,
never subscriber contact details. D1 remains the durable source of progress even
if a Free-plan queue message reaches its 24-hour retention limit.

## Measured baseline (2026-09-19)

The production-sized local D1 simulation passed with 192,732 rows read and 84,134
rows written, including both SMS status events, duplicate/late callbacks, and 51
failed SMS deliveries. It used 1,067 sender batches, at most 24 D1 queries and ten
provider calls per batch, and an estimated 3,204 queue operations. The provider
calls were all mocked. Ordinary account activity and one-time migrations are
additional to these figures; write headroom is roughly 16,000 rows at this size.

Synthetic admin checks measured six reads for an exact email search, nine for a
small message history, and 120 for the second subscriber page without repeating
summary/chart queries. A history poll with no new reply wrote zero rows. Actual
history costs scale with that contact's own matching messages.
