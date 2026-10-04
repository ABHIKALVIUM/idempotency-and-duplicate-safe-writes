const crypto = require('crypto');
const { db } = require('./db');

function canonicalize(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(obj[key]);
  }
  return result;
}

function hashRequest(body) {
  const canonical = canonicalize(body || {});
  const jsonStr = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(jsonStr).digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey || !idempotencyKey.trim()) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const tenantId = req.user.tenantId;
  const operation = 'POST:/incidents';
  const currentHash = hashRequest(req.body);
  const { title, severity, serviceId } = req.body;

  // 1. Initial lookup for existing record
  const existing = await db.oneOrNone(
    `SELECT * FROM idempotency_keys
     WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
    [tenantId, operation, idempotencyKey]
  );

  if (existing) {
    // Check if record is expired
    if (new Date(existing.expires_at) <= new Date()) {
      await db.none(
        `DELETE FROM idempotency_keys
         WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, operation, idempotencyKey]
      );
    } else {
      if (existing.request_hash !== currentHash) {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }

      if (existing.state === 'processing') {
        return res.status(409).json({ error: 'operation_in_progress' });
      }

      if (existing.state === 'failed') {
        return res.status(409).json({ error: 'prior_operation_failed' });
      }

      if (existing.state === 'completed') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.response_status).json(existing.response_body);
      }
    }
  }

  // 2. Atomic claim and transactional execution
  try {
    const incident = await db.tx(async (t) => {
      // Claim key before business write
      await t.none(
        `INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
         VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')`,
        [tenantId, operation, idempotencyKey, currentHash]
      );

      // Create incident
      const inc = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );

      // Create durable paging job in same transaction
      await t.none(
        `INSERT INTO paging_jobs (tenant_id, incident_id, status)
         VALUES ($1, $2, 'pending')`,
        [tenantId, inc.id]
      );

      // Mark key completed with response metadata atomically
      await t.none(
        `UPDATE idempotency_keys
         SET state = 'completed',
             response_status = 201,
             response_body = $1
         WHERE tenant_id = $2 AND operation = $3 AND key = $4`,
        [inc, tenantId, operation, idempotencyKey]
      );

      return inc;
    });

    return res.status(201).json(incident);
  } catch (err) {
    if (err.code === '23505') {
      // Unique constraint race: another concurrent request claimed ownership
      let record = await db.oneOrNone(
        `SELECT * FROM idempotency_keys
         WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, operation, idempotencyKey]
      );

      let attempts = 0;
      while (record && record.state === 'processing' && attempts < 25) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        record = await db.oneOrNone(
          `SELECT * FROM idempotency_keys
           WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
          [tenantId, operation, idempotencyKey]
        );
        attempts++;
      }

      if (!record) {
        return res.status(500).json({ error: 'internal_error' });
      }

      if (record.request_hash !== currentHash) {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }

      if (record.state === 'completed') {
        res.set('Idempotent-Replayed', 'true');
        return res.status(record.response_status).json(record.response_body);
      }

      if (record.state === 'failed') {
        return res.status(409).json({ error: 'prior_operation_failed' });
      }

      if (record.state === 'processing') {
        return res.status(409).json({ error: 'operation_in_progress' });
      }
    }

    throw err;
  }
}

module.exports = { createIncident, hashRequest };
