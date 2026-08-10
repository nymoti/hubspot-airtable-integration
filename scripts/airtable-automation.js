/**
 * Paste this into an Airtable automation's "Run script" action.
 *
 * One automation per table:
 *   Trigger: "When record is created" and a second for "When record updated"
 *            (or a single "When record matches conditions" trigger).
 *   Action:  Run script — with `recordId` added as an input variable, mapped to
 *            the trigger record's id.
 *
 * The script sends only the table name and the record id. The service re-reads
 * the record from the Airtable API, so the payload cannot go stale between the
 * trigger firing and the sync running, and linked-record fields are always
 * present regardless of how the automation is configured.
 *
 * Configure the two constants below, then set `TABLE_NAME` per automation.
 *
 * NOTE: this file is documentation for the Airtable UI — it runs inside
 * Airtable's scripting sandbox, not in this Node project.
 */

// --- Configure ------------------------------------------------------------
const ENDPOINT = 'https://REGION-PROJECT.cloudfunctions.net/airtable-hubspot-sync/webhook';
const WEBHOOK_SECRET = 'paste-the-same-value-as-the-WEBHOOK_SECRET-env-var';
const TABLE_NAME = 'Companies'; // Companies | Contacts | Deals | Line Items
// --------------------------------------------------------------------------

const { recordId } = input.config();

const response = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Secret': WEBHOOK_SECRET,
  },
  body: JSON.stringify({
    table: TABLE_NAME,
    recordId,
  }),
});

const body = await response.json();

// Surfacing the status in the automation run log makes a failed sync visible
// in Airtable itself, not only in Cloud Logging.
console.log(`${response.status} ${JSON.stringify(body)}`);

// A non-retryable failure (bad data) should not fail the automation run —
// retrying it would never succeed. Transient failures are re-thrown so
// Airtable marks the run as failed and it is visible for investigation.
if (!response.ok && body.retryable !== false) {
  throw new Error(`Sync failed (${response.status}): ${body.error}`);
}
