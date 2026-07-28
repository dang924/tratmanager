const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.WEIGHT_DB_PATH || path.join(__dirname, 'data', 'weight.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS offenders (
  user_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  case_channel_id TEXT,
  case_message_id TEXT,
  display_name TEXT,
  discord_id TEXT,
  char_id TEXT,
  is_external INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weight_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('add', 'remove')),
  amount REAL NOT NULL,
  reason TEXT,
  moderator_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY,
  log_channel_id TEXT,
  cases_channel_id TEXT,
  role_log_channel_id TEXT,
  allowed_role_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS role_permission_mappings (
  guild_id TEXT NOT NULL,
  grant_role_id TEXT NOT NULL,
  target_role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, grant_role_id, target_role_id)
);
`);

// Migrations for older DBs created before these fields existed.
const guildConfigCols = db.prepare("PRAGMA table_info(guild_config)").all().map((c) => c.name);
if (!guildConfigCols.includes('cases_channel_id')) {
  db.exec('ALTER TABLE guild_config ADD COLUMN cases_channel_id TEXT');
}
if (!guildConfigCols.includes('role_log_channel_id')) {
  db.exec('ALTER TABLE guild_config ADD COLUMN role_log_channel_id TEXT');
}

const offenderCols = db.prepare('PRAGMA table_info(offenders)').all().map((c) => c.name);
if (!offenderCols.includes('display_name')) {
  db.exec('ALTER TABLE offenders ADD COLUMN display_name TEXT');
}
if (!offenderCols.includes('discord_id')) {
  db.exec('ALTER TABLE offenders ADD COLUMN discord_id TEXT');
}
if (!offenderCols.includes('is_external')) {
  db.exec('ALTER TABLE offenders ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0');
}
if (!offenderCols.includes('char_id')) {
  db.exec('ALTER TABLE offenders ADD COLUMN char_id TEXT');
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

function getConfig(guildId) {
  let row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
  if (!row) {
    db.prepare('INSERT INTO guild_config (guild_id, allowed_role_ids) VALUES (?, ?)').run(guildId, '[]');
    row = { guild_id: guildId, log_channel_id: null, cases_channel_id: null, role_log_channel_id: null, allowed_role_ids: '[]' };
  }
  return {
    ...row,
    role_log_channel_id: row.role_log_channel_id ?? null,
    allowed_role_ids: JSON.parse(row.allowed_role_ids ?? '[]'),
  };
}

function setLogChannel(guildId, channelId) {
  getConfig(guildId);
  db.prepare('UPDATE guild_config SET log_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
}

function setCasesChannel(guildId, channelId) {
  getConfig(guildId);
  db.prepare('UPDATE guild_config SET cases_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
}

function setRoleLogChannel(guildId, channelId) {
  getConfig(guildId);
  db.prepare('UPDATE guild_config SET role_log_channel_id = ? WHERE guild_id = ?').run(channelId, guildId);
}

function addAllowedRole(guildId, roleId) {
  const cfg = getConfig(guildId);
  if (!cfg.allowed_role_ids.includes(roleId)) {
    cfg.allowed_role_ids.push(roleId);
    db.prepare('UPDATE guild_config SET allowed_role_ids = ? WHERE guild_id = ?')
      .run(JSON.stringify(cfg.allowed_role_ids), guildId);
  }
}

function removeAllowedRole(guildId, roleId) {
  const cfg = getConfig(guildId);
  const next = cfg.allowed_role_ids.filter((r) => r !== roleId);
  db.prepare('UPDATE guild_config SET allowed_role_ids = ? WHERE guild_id = ?')
    .run(JSON.stringify(next), guildId);
}

function getRolePermissions(guildId) {
  return db.prepare(
    'SELECT grant_role_id, target_role_id FROM role_permission_mappings WHERE guild_id = ? ORDER BY grant_role_id, target_role_id'
  ).all(guildId);
}

function addRolePermission(guildId, grantRoleId, targetRoleId) {
  db.prepare(`
    INSERT OR IGNORE INTO role_permission_mappings (guild_id, grant_role_id, target_role_id)
    VALUES (?, ?, ?)
  `).run(guildId, grantRoleId, targetRoleId);
}

function removeRolePermission(guildId, grantRoleId, targetRoleId) {
  db.prepare('DELETE FROM role_permission_mappings WHERE guild_id = ? AND grant_role_id = ? AND target_role_id = ?')
    .run(guildId, grantRoleId, targetRoleId);
}

function canGrantRole(guildId, grantRoleId, targetRoleId) {
  const row = db.prepare(
    'SELECT 1 FROM role_permission_mappings WHERE guild_id = ? AND grant_role_id = ? AND target_role_id = ?'
  ).get(guildId, grantRoleId, targetRoleId);
  return Boolean(row);
}

function ensureOffender(userId, guildId, details = {}) {
  const existing = db.prepare('SELECT * FROM offenders WHERE user_id = ?').get(userId);
  if (existing) {
    const nextDisplayName = details.displayName ?? existing.display_name;
    const nextDiscordId = details.discordId ?? existing.discord_id;
    const nextCharId = details.charId ?? existing.char_id;
    const nextIsExternal = details.isExternal ?? (existing.is_external ?? 0);

    if (
      existing.display_name !== nextDisplayName ||
      existing.discord_id !== nextDiscordId ||
      existing.char_id !== nextCharId ||
      (existing.is_external ?? 0) !== nextIsExternal
    ) {
      db.prepare(`
        UPDATE offenders
        SET display_name = ?, discord_id = ?, char_id = ?, is_external = ?
        WHERE user_id = ?
      `).run(nextDisplayName, nextDiscordId, nextCharId, nextIsExternal ? 1 : 0, userId);
    }

    return db.prepare('SELECT * FROM offenders WHERE user_id = ?').get(userId);
  }

  db.prepare(`
    INSERT INTO offenders (user_id, guild_id, display_name, discord_id, char_id, is_external)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, guildId, details.displayName ?? null, details.discordId ?? null, details.charId ?? null, details.isExternal ? 1 : 0);

  return db.prepare('SELECT * FROM offenders WHERE user_id = ?').get(userId);
}

function setCaseMessage(userId, channelId, messageId) {
  db.prepare('UPDATE offenders SET case_channel_id = ?, case_message_id = ? WHERE user_id = ?')
    .run(channelId, messageId, userId);
}

function addEntry({ userId, guildId, type, amount, reason, moderatorId }) {
  const now = Date.now();
  const expiresAt = type === 'add' ? now + SIXTY_DAYS_MS : null;
  db.prepare(`
    INSERT INTO weight_entries (user_id, guild_id, type, amount, reason, moderator_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, guildId, type, amount, reason || 'No reason given', moderatorId, now, expiresAt);
}

function getEntries(userId, limit = 5) {
  return db.prepare(`
    SELECT * FROM weight_entries WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

// Current active Weight = sum of non-expired 'add' entries minus all 'remove' entries.
function getCurrentWeight(userId) {
  const now = Date.now();
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'add' AND (expires_at IS NULL OR expires_at > ?) THEN amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type = 'remove' THEN amount ELSE 0 END), 0) AS total
    FROM weight_entries WHERE user_id = ?
  `).get(now, userId);
  return Math.max(0, Math.round(row.total * 100) / 100);
}

function getOffender(userId) {
  return db.prepare('SELECT * FROM offenders WHERE user_id = ?').get(userId);
}

function getAllOffendersWithCaseMessages() {
  return db.prepare('SELECT * FROM offenders WHERE case_message_id IS NOT NULL').all();
}

module.exports = {
  getConfig,
  setLogChannel,
  setCasesChannel,
  setRoleLogChannel,
  addAllowedRole,
  removeAllowedRole,
  getRolePermissions,
  addRolePermission,
  removeRolePermission,
  canGrantRole,
  ensureOffender,
  setCaseMessage,
  addEntry,
  getEntries,
  getCurrentWeight,
  getOffender,
  getAllOffendersWithCaseMessages,
};
