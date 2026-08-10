'use strict';

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { ValidationError } = require('../shared/errors');

/**
 * Reads a CSV file from the data directory into an array of row objects.
 *
 * The files here are ~400 rows, so loading them fully into memory is the right
 * trade-off — it keeps the migration logic straightforward and lets us build
 * the id→id lookup tables that associations need. A genuinely large export
 * would want a streaming, two-pass approach instead.
 *
 * @param {string} fileName
 * @param {string} dataDir
 * @returns {Promise<Array<Record<string, string>>>}
 */
function readCsv(fileName, dataDir) {
  const filePath = path.resolve(dataDir, fileName);

  if (!fs.existsSync(filePath)) {
    throw new ValidationError(`CSV file not found: ${filePath}`, {
      context: { fileName, dataDir },
    });
  }

  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(
        csv({
          // Trim the UTF-8 BOM and surrounding whitespace from headers so
          // `﻿company_id` does not silently become an unknown column.
          mapHeaders: ({ header }) => header.replace(/^﻿/, '').trim(),
          mapValues: ({ value }) =>
            typeof value === 'string' ? value.trim() : value,
        })
      )
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', (error) =>
        reject(
          new ValidationError(`Failed to parse ${fileName}: ${error.message}`, {
            context: { filePath },
            cause: error,
          })
        )
      );
  });
}

module.exports = { readCsv };
