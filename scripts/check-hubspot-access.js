#!/usr/bin/env node
'use strict';

/**
 * Reports which HubSpot permissions the configured token actually has.
 *
 * HubSpot's 403 response lists every scope that could conceivably grant the
 * call — 26 of them for a property write — which makes it almost useless for
 * working out what to fix. And the token-introspection endpoint does not cover
 * private-app tokens. So the only reliable answer is to attempt each call and
 * see what happens.
 *
 * Read probes are harmless. The one write probe creates a company named
 * `__access_probe__` and deletes it immediately.
 *
 * Usage: npm run doctor
 */

const HubSpotClient = require('../src/shared/hubspotClient');
const logger = require('../src/shared/logger');
const { OBJECT_TYPES } = require('../src/shared/hubspotSchema');

const OBJECT_TYPE_LIST = Object.values(OBJECT_TYPES);

/** @param {() => Promise<unknown>} probe */
async function attempt(probe) {
  try {
    await probe();
    return { ok: true };
  } catch (error) {
    return { ok: false, status: error.status, message: error.message };
  }
}

async function main() {
  const hubspot = new HubSpotClient();
  const results = [];

  // Reading records — needed by both the migration and the sync.
  for (const objectType of OBJECT_TYPE_LIST) {
    const outcome = await attempt(() =>
      hubspot.request('GET', `/crm/v3/objects/${objectType}?limit=1`, undefined, {}, {
        expectedStatuses: [403],
      })
    );
    results.push({ scope: `crm.objects.${objectType}.read`, ...outcome });
  }

  // Reading the property schema — needed to detect existing custom properties.
  for (const objectType of OBJECT_TYPE_LIST) {
    const outcome = await attempt(() =>
      hubspot.request('GET', `/crm/v3/properties/${objectType}`, undefined, {}, {
        expectedStatuses: [403],
      })
    );
    results.push({ scope: `crm.schemas.${objectType}.read`, ...outcome });
  }

  // Writing records, probed once and cleaned up. Company is used because it is
  // the least intrusive object to create and remove.
  const writeProbe = await attempt(async () => {
    const created = await hubspot.request(
      'POST',
      `/crm/v3/objects/${OBJECT_TYPES.COMPANIES}`,
      { properties: { name: '__access_probe__' } },
      {},
      { expectedStatuses: [403] }
    );
    await hubspot.request(
      'DELETE',
      `/crm/v3/objects/${OBJECT_TYPES.COMPANIES}/${created.id}`,
      undefined,
      {},
      { expectedStatuses: [403, 404] }
    );
  });
  results.push({ scope: 'crm.objects.companies.write', ...writeProbe });

  const lines = results.map(
    (result) =>
      `  ${result.ok ? 'OK     ' : `MISSING`}  ${result.scope}` +
      (result.ok ? '' : `   (${result.status})`)
  );

  const missing = results.filter((result) => !result.ok);

  process.stdout.write(
    ['', 'HubSpot token access:', '', ...lines, ''].join('\n')
  );

  if (missing.length === 0) {
    logger.info('All probed permissions are granted');
    return;
  }

  process.stdout.write(
    [
      `${missing.length} permission(s) missing.`,
      '',
      'Fix in HubSpot → Settings → Integrations → Private Apps → your app →',
      'Scopes tab. Tick the scopes listed above, then click Save and confirm',
      'with "Continue updating". Re-run `npm run doctor` to verify.',
      '',
      'Note: `crm.schemas.*.write` is not probed here (it would create a real',
      'property). If `npm run bootstrap` returns 403, that is the scope to add.',
      '',
    ].join('\n')
  );

  process.exitCode = 1;
}

main().catch((error) => {
  logger.error('Access check failed', {
    error: error.message,
    status: error.status,
    hint: 'A 401 here means the token itself is wrong or revoked.',
  });
  process.exitCode = 1;
});
