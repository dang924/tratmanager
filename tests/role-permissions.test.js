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

test('grab profile config stores search sources, destinations, and allowed roles', () => {
  const db = loadDatabase();

  const initial = db.getConfig('guild-2');
  assert.deepEqual(initial.grab_profile_source_channel_ids, []);
  assert.deepEqual(initial.grab_profile_destination_map, {});
  assert.deepEqual(initial.grab_profile_allowed_role_ids, []);

  db.addGrabProfileSourceChannel('guild-2', 'source-1');
  db.addGrabProfileDestination('guild-2', 'role-1', 'dest-1');
  db.addGrabProfileAllowedRole('guild-2', 'role-1');

  const updated = db.getConfig('guild-2');
  assert.deepEqual(updated.grab_profile_source_channel_ids, ['source-1']);
  assert.deepEqual(updated.grab_profile_destination_map, { 'role-1': ['dest-1'] });
  assert.deepEqual(updated.grab_profile_allowed_role_ids, ['role-1']);

  db.removeGrabProfileSourceChannel('guild-2', 'source-1');
  db.removeGrabProfileDestination('guild-2', 'role-1', 'dest-1');
  db.removeGrabProfileAllowedRole('guild-2', 'role-1');

  const final = db.getConfig('guild-2');
  assert.deepEqual(final.grab_profile_source_channel_ids, []);
  assert.deepEqual(final.grab_profile_destination_map, {});
  assert.deepEqual(final.grab_profile_allowed_role_ids, []);
});

test('join-role helpers store and remove role IDs for auto-assignment', () => {
  const db = loadDatabase();

  assert.deepEqual(db.getJoinRoles('guild-3'), []);

  db.addJoinRole('guild-3', 'role-1');
  db.addJoinRole('guild-3', 'role-2');
  db.addJoinRole('guild-3', 'role-1');

  assert.deepEqual(db.getJoinRoles('guild-3'), ['role-1', 'role-2']);

  db.removeJoinRole('guild-3', 'role-1');

  assert.deepEqual(db.getJoinRoles('guild-3'), ['role-2']);
});
