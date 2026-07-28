const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weight-bot-role-tests-'));
  const dbPath = path.join(tempDir, 'weight.db');
  process.env.WEIGHT_DB_PATH = dbPath;
  delete require.cache[require.resolve('../database')];
  return require('../database');
}

test('role permission helpers store and query role mappings', () => {
  const db = loadDatabase();

  assert.equal(db.canGrantRole('guild-1', 'grant-role-id', 'target-role-id'), false);

  db.addRolePermission('guild-1', 'grant-role-id', 'target-role-id');
  assert.equal(db.canGrantRole('guild-1', 'grant-role-id', 'target-role-id'), true);
  assert.deepEqual(db.getRolePermissions('guild-1'), [
    { grant_role_id: 'grant-role-id', target_role_id: 'target-role-id' },
  ]);

  db.removeRolePermission('guild-1', 'grant-role-id', 'target-role-id');
  assert.equal(db.canGrantRole('guild-1', 'grant-role-id', 'target-role-id'), false);
});
