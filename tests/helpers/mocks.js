'use strict';

/**
 * Test doubles for the HubSpot and Airtable clients.
 *
 * Nothing in the suite touches the network. `FakeHubSpotClient` models the
 * parts of HubSpot's behaviour the sync logic actually depends on — object
 * storage keyed by id, exact-match property search, and idempotent
 * associations — so idempotency can be asserted against observable state
 * ("exactly one company exists") rather than against call counts alone.
 */

const logger = require('../../src/shared/logger');

/** A logger that swallows output but can be asserted against. */
function silentLogger() {
  const noop = () => {};
  const child = {
    info: jest.fn(noop),
    warn: jest.fn(noop),
    error: jest.fn(noop),
    debug: jest.fn(noop),
  };
  child.child = () => child;
  return child;
}

class FakeHubSpotClient {
  constructor() {
    /** objectType → Map<id, properties> */
    this.objects = new Map();
    /** Set of `from:fromId:to:toId` strings. */
    this.associations = new Set();
    this.nextId = 1000;
    this.calls = { create: 0, update: 0, search: 0, associate: 0 };
  }

  store(objectType) {
    if (!this.objects.has(objectType)) this.objects.set(objectType, new Map());
    return this.objects.get(objectType);
  }

  /** Every record currently held for an object type. */
  all(objectType) {
    return [...this.store(objectType).entries()].map(([id, properties]) => ({
      id,
      properties,
    }));
  }

  async createObject(objectType, properties) {
    this.calls.create += 1;
    const id = String(this.nextId++);
    this.store(objectType).set(id, { ...properties });
    return { id, properties: { ...properties } };
  }

  async updateObject(objectType, id, properties) {
    this.calls.update += 1;
    const existing = this.store(objectType).get(id);
    if (!existing) {
      const error = new Error('not found');
      error.status = 404;
      throw error;
    }
    this.store(objectType).set(id, { ...existing, ...properties });
    return { id, properties: this.store(objectType).get(id) };
  }

  async getObject(objectType, id) {
    const properties = this.store(objectType).get(id);
    return properties ? { id, properties: { ...properties } } : null;
  }

  async searchByProperty(objectType, propertyName, value) {
    this.calls.search += 1;
    return this.all(objectType).filter(
      (record) => record.properties[propertyName] === String(value)
    );
  }

  async associate(fromType, fromId, toType, toId) {
    this.calls.associate += 1;
    // PUT semantics: writing the same association twice is a no-op, which is
    // what makes replayed events safe.
    this.associations.add(`${fromType}:${fromId}->${toType}:${toId}`);
  }

  hasAssociation(fromType, fromId, toType, toId) {
    return this.associations.has(`${fromType}:${fromId}->${toType}:${toId}`);
  }
}

class FakeAirtableService {
  /** @param {Record<string, Array<{ id: string, fields: object }>>} tables */
  constructor(tables = {}) {
    /** tableName → Map<recordId, fields> */
    this.tables = new Map();
    for (const [name, records] of Object.entries(tables)) {
      this.tables.set(
        name,
        new Map(records.map((record) => [record.id, { ...record.fields }]))
      );
    }
    this.writeBacks = [];
  }

  table(name) {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }

  async getRecord(tableName, recordId) {
    const fields = this.table(tableName).get(recordId);
    return fields ? { id: recordId, fields: { ...fields } } : null;
  }

  async findByField(tableName, fieldName, value) {
    for (const [id, fields] of this.table(tableName)) {
      if (String(fields[fieldName]) === String(value)) {
        return { id, fields: { ...fields } };
      }
    }
    return null;
  }

  async writeBackHubspotId(tableName, recordId, hubspotId) {
    this.writeBacks.push({ tableName, recordId, hubspotId });
    const fields = this.table(tableName).get(recordId);
    if (fields) fields.hubspot_record_id = String(hubspotId);
  }
}

module.exports = { FakeHubSpotClient, FakeAirtableService, silentLogger, logger };
