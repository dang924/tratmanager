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

test('grab profile config stores channel and role allowlists', () => {
  const db = loadDatabase();

  const initial = db.getGrabProfileConfig('guild-2');
  assert.equal(initial.channel_id, null);
  assert.deepEqual(initial.allowed_role_ids, []);

  db.setGrabProfileChannel('guild-2', 'channel-1');
  db.addGrabProfileAllowedRole('guild-2', 'role-1');

  const updated = db.getGrabProfileConfig('guild-2');
  assert.equal(updated.channel_id, 'channel-1');
  assert.deepEqual(updated.allowed_role_ids, ['role-1']);

  db.removeGrabProfileAllowedRole('guild-2', 'role-1');
  assert.deepEqual(db.getGrabProfileConfig('guild-2').allowed_role_ids, []);
});
