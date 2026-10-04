# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### Implementation Design Decisions

#### 1. Why Database Uniqueness is Needed
Application-level pre-checks (such as `SELECT ... WHERE key = ...`) are vulnerable to race conditions (Time-of-Check to Time-of-Use / TOCTOU). In a high-concurrency environment where multiple retries or parallel requests arrive within milliseconds (e.g., 20 concurrent requests hitting the endpoint simultaneously), both requests would execute the pre-check before either has committed to the database. Both would conclude that the key does not exist and proceed to insert, causing duplicate incidents.
By enforcing a database unique constraint on `(tenant_id, operation, key)` in `idempotency_keys`, the database engine acts as the atomic synchronization authority. PostgreSQL serializes concurrent insertions into the unique index: one request successfully claims ownership, while concurrent duplicates block and subsequently raise a unique violation error (`23505`). The losing requests safely await the winner's completion and replay the stored result without creating duplicate incidents or paging jobs.

#### 2. How Request Contents Are Canonicalized and Compared
Clients may serialize semantically identical JSON payloads with different key orderings, whitespace, or formatting (e.g. `{"title": "x", "severity": "P1"}` vs `{"severity": "P1", "title": "x"}`). If raw request byte streams or standard unformatted JSON strings were hashed, identical logical requests would produce differing hashes, causing spurious 409 conflicts.
To guarantee deterministic comparison, `hashRequest`:
1. Recursively traverses objects and sorts all keys lexicographically.
2. Preserves primitive types and array order.
3. Serializes the normalized structure into canonical JSON.
4. Generates a SHA-256 cryptographic digest.
When an existing idempotency record is evaluated, the incoming request hash is compared against the stored `request_hash`. Matching hashes identify legitimate retries, while differing hashes signal that a client reused a key for an altered payload, returning a `409 Conflict` (`idempotency_key_conflict`).

#### 3. What 24-Hour Expiry Means
Idempotency records cannot be preserved indefinitely without creating unbounded table growth, index degradation, and storage bloat. A 24-hour Time-to-Live (TTL) establishes a bounded retention horizon matching realistic client retry behaviors (network dropouts, mobile client retries, transient server degradation).
- **Within the 24-hour window:** Duplicate requests with matching keys and payloads are safely recognized and replayed with the stored response status and payload; mismatched payloads yield `409 Conflict`.
- **After 24-hour expiry:** Stored keys are eligible for automatic eviction. Once an expired key record is removed, the key can be safely reused for a new request without conflicting with past operations, as duplicate protection is no longer guaranteed beyond the retention horizon.

#### 4. Why Paging Job is Stored in Same Transaction
Creating an incident triggers an essential operational side effect: notifying responders via a paging job. If paging jobs were dispatched outside the database transaction or directly called via third-party HTTP/queue APIs:
- If external dispatch succeeds but the database write fails or rolls back, responders are alerted for a non-existent incident ("phantom alert").
- If the database write commits but the network crashes before dispatching the job, an incident exists without alerting responders.
By persisting the job record to a durable `paging_jobs` table within the **same atomic database transaction** (`db.tx`) as the incident creation and idempotency key completion, we uphold the Transactional Outbox pattern. Either both the incident and the paging job are durably persisted together, or neither is. Background workers can then reliably process and deliver the paging jobs asynchronously with at-least-once guarantees.

#### 5. Privacy and Size Risks of Stored Responses
Persisting full response bodies in the `idempotency_keys` table introduces specific operational trade-offs:
- **Privacy and Data Leakage:** Response bodies may contain Personally Identifiable Information (PII), authentication tokens, customer data, or internal system metadata. Storing responses in the idempotency log expands the attack surface and audit scope (GDPR, SOC2). Mitigations include encrypting sensitive columns at rest, masking or redacting credentials/PII before storage, or storing lightweight canonical resource references instead of complete response payloads.
- **Table Bloat and Storage Footprint:** For high-traffic APIs or endpoints returning large payloads, storing serialized JSON responses causes rapid database table and index bloat, impacting memory cache hit rates and query latency. Mitigations include enforcing strict TTL retention with partition pruning, capping payload storage limits, or offloading large blobs to object storage while maintaining lightweight metadata in the database.

### Test Execution Output

```text
PASS tests/idempotency.test.js
  √ 1 missing key returns 400 and no incident (52 ms)
  √ 2 first request creates incident (34 ms)
  √ 3 sequential duplicate replays response (35 ms)
  √ 4 replay exposes replay header (35 ms)
  √ 5 changed body conflicts (35 ms)
  √ 6 same key across tenants is independent (37 ms)
  √ 7 twenty concurrent duplicates create one incident (218 ms)
  √ 8 concurrent duplicates create one paging job (93 ms)
  √ 9 lost-response retry produces one effect (36 ms)
  √ 10 existing processing key does not execute (26 ms)
  √ 11 existing failed key follows recovery contract (27 ms)
  √ 12 transaction rollback removes all local writes (29 ms)
  √ 13 canonical hash ignores object property order (18 ms)
  √ 14 operation and scope are stored exactly (28 ms)

Test Suites: 1 passed, 1 total
Tests:       14 passed, 1 total
Snapshots:   0 total
Time:        1.646 s
Ran all test suites.
```


## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
