#!/usr/bin/env node
'use strict';

/**
 * inspect-db.js — Print all tables and their columns from a Calibre metadata.db
 * Usage: node inspect-db.js /path/to/calibre/library
 *        node inspect-db.js /path/to/calibre/library/metadata.db
 */

const path = require('path');
const fs = require('fs');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node inspect-db.js /path/to/calibre/library');
  process.exit(1);
}

// Accept either the folder or the .db file directly
let dbPath = arg.endsWith('.db') ? arg : path.join(arg, 'metadata.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Not found: ${dbPath}`);
  process.exit(1);
}

const Database = require('better-sqlite3');
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare(`
  SELECT name FROM sqlite_master
  WHERE type='table' ORDER BY name
`).all().map(r => r.name);

for (const table of tables) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  console.log(`\n── ${table}`);
  for (const col of cols) {
    console.log(`   ${String(col.cid).padStart(2)}  ${col.name.padEnd(30)} ${col.type}${col.notnull ? ' NOT NULL' : ''}${col.dflt_value != null ? ' DEFAULT ' + col.dflt_value : ''}`);
  }
}

// Also show any rows in books_series_link as a sample
try {
  const sample = db.prepare(`SELECT * FROM books_series_link LIMIT 5`).all();
  console.log('\n── books_series_link sample rows:');
  console.log(sample);
} catch (e) {
  console.log('\n── books_series_link: ' + e.message);
}

db.close();
