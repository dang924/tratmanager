require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const cron = require('node-cron');
const db = require('./database');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function isAuthorized(member, guildId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cfg = db.getConfig(guildId);
  return member.roles.cache.some((r) => cfg.allowed_role_ids.includes(r.id));
}

function canGrantRoleForMember(member, guildId, targetRoleId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((role) => db.canGrantRole(guildId, role.id, targetRoleId));
}

function canChangeNameForMember(member, guildId, targetRoleId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((role) => db.canChangeRoleName(guildId, role.id, targetRoleId));
}

function thresholdNote(weight) {
  if (weight > 10) return '🔴 **Over 10 Weight — punishment must be decided by HC.**';
  if (weight > 0) return '🟠 **Punishment must be decided by Head Enforcer+ or HC.**';
  return '🟢 No active Weight.';
}

function parseCustomId(customId) {
  const separatorIndex = customId.indexOf(':');
  if (separatorIndex === -1) return { action: customId, offenderId: null };
  return {
    action: customId.slice(0, separatorIndex),
    offenderId: decodeURIComponent(customId.slice(separatorIndex + 1)),
  };
}

function buildButtonId(action, offenderId) {
  return `${action}:${encodeURIComponent(offenderId)}`;
}

function buildCaseIdentity({ targetUser, name, charId }) {
  if (targetUser) {
    return {
      offenderId: targetUser.id,
      displayName: targetUser.username,
      discordId: targetUser.id,
      charId: null,
      isExternal: false,
      resolvedUser: targetUser,
    };
  }

  const trimmedName = name?.trim();
  const trimmedCharId = charId?.trim();
  const externalName = trimmedName || trimmedCharId || 'External User';
  const profileId = `external:${trimmedCharId || externalName}`;

  return {
    offenderId: profileId,
    displayName: externalName,
    discordId: null,
    charId: trimmedCharId || null,
    isExternal: true,
    resolvedUser: null,
  };
}

function buildCaseEmbed({ offenderId, displayName, avatarUrl, charId }) {
  const weight = db.getCurrentWeight(offenderId);
  const entries = db.getEntries(offenderId, 5);

  const embed = new EmbedBuilder()
    .setTitle(`Offender Case — ${displayName}`)
    .setColor(weight > 10 ? 0xe74c3c : weight > 0 ? 0xe67e22 : 0x2ecc71)
    .setFooter({ text: 'Weight entries auto-expire 60 days after being added' })
    .setTimestamp();

  const identityFields = [];
  if (displayName) identityFields.push({ name: 'Name', value: displayName, inline: true });
  if (charId) identityFields.push({ name: 'Char ID', value: charId, inline: true });
  if (identityFields.length) embed.addFields(...identityFields);

  embed.addFields(
    { name: 'Current Weight', value: `**${weight}**`, inline: true },
    { name: 'Status', value: thresholdNote(weight), inline: true }
  );

  if (avatarUrl) {
    embed.setThumbnail(avatarUrl);
  }

  if (entries.length) {
    const lines = entries.map((e) => {
      const date = `<t:${Math.floor(e.created_at / 1000)}:R>`;
      const sign = e.type === 'add' ? '+' : '-';
      const expiry =
        e.type === 'add'
          ? e.expires_at > Date.now()
            ? ` (expires <t:${Math.floor(e.expires_at / 1000)}:R>)`
            : ' (expired)'
          : ' (permanent adjustment)';
      return `**${sign}${e.amount}** — ${e.reason} — by <@${e.moderator_id}> ${date}${expiry}`;
    });
    embed.addFields({ name: 'Recent Entries', value: lines.join('\n').slice(0, 1024) });
  } else {
    embed.addFields({ name: 'Recent Entries', value: 'No entries logged yet.' });
  }

  return embed;
}

function buildCaseButtons(offenderId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(buildButtonId('add_weight', offenderId)).setLabel('➕ Add Weight').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(buildButtonId('remove_weight', offenderId)).setLabel('➖ Remove Weight').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(buildButtonId('refresh', offenderId)).setLabel('🔄 Refresh').setStyle(ButtonStyle.Secondary)
  );
}

function canUseGrabProfile(member, guildId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cfg = db.getConfig(guildId);
  return member.roles.cache.some((role) => cfg.grab_profile_allowed_role_ids.includes(role.id));
}

async function collectRelevantMessages({ guild, targetUser }) {
  const botMember = guild.members.me;
  const botPermissions = botMember?.permissions ?? null;
  if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.ReadMessageHistory)) {
    return [];
  }

  const sourceChannelIds = db.getGrabProfileSourceChannels(guild.id);
  if (!Array.isArray(sourceChannelIds) || sourceChannelIds.length === 0) {
    return [];
  }

  const MAX_SEARCH_MESSAGES = 1000;
  const SEARCH_BATCH_SIZE = 100;
  const candidates = [];

  for (const channelId of sourceChannelIds) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isThread?.()) continue;
    const permissions = channel.permissionsFor?.(botMember) || null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.ReadMessageHistory)) {
      continue;
    }

    let lastMessageId = null;
    let totalFetched = 0;
    while (totalFetched < MAX_SEARCH_MESSAGES) {
      const fetchOptions = { limit: SEARCH_BATCH_SIZE };
      if (lastMessageId) fetchOptions.before = lastMessageId;

      let messages;
      try {
        messages = await channel.messages.fetch(fetchOptions);
      } catch (error) {
        break;
      }

      if (!messages?.size) break;
      totalFetched += messages.size;
      lastMessageId = messages.last().id;

      for (const message of messages.values()) {
        if (message.author.id === targetUser.id) continue;

        const content = message.content ?? '';
        const mentionsTarget = message.mentions.users.has(targetUser.id) || message.mentions.members?.has(targetUser.id);
        const containsName = [targetUser.username, targetUser.displayName, targetUser.globalName]
          .filter(Boolean)
          .some((value) => content.toLowerCase().includes(value.toLowerCase()));
        const containsTag = content.includes(`<@${targetUser.id}>`) || content.includes(targetUser.tag);

        if (!mentionsTarget && !containsName && !containsTag) {
          continue;
        }

        candidates.push({
          id: message.id,
          channelId: message.channelId,
          channelName: channel.name,
          content: message.content || '(no text content)',
          createdAt: message.createdTimestamp,
          link: `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`,
        });
      }

      if (candidates.length >= 10) break;
    }
  }

  return candidates
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
}

function parseNameFromLogMessage(content) {
  const normalized = content.replace(/\s+/g, ' ');
  const match = normalized.match(/Name:\s*([^\n]+?)\s+Date:/i);
  return match?.[1]?.trim() ?? null;
}

async function pickGrabProfileDestinationChannel(guild, channelIds) {
  if (!Array.isArray(channelIds) || channelIds.length === 0) {
    return null;
  }

  for (const channelId of channelIds) {
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.()) continue;
    const botMember = guild.members.me;
    const botPermissions = channel.permissionsFor?.(botMember) || null;
    if (
      botPermissions?.has(PermissionFlagsBits.ViewChannel) &&
      botPermissions.has(PermissionFlagsBits.SendMessages) &&
      botPermissions.has(PermissionFlagsBits.EmbedLinks)
    ) {
      return channel;
    }
  }

  return null;
}

async function postGrabProfileLog({ guild, targetUser, messages, moderator, destinationChannelIds }) {
  const channel = await pickGrabProfileDestinationChannel(guild, destinationChannelIds);
  if (!channel) {
    return { posted: false, reason: 'No permitted grabprofile destination channel is available.' };
  }

  const lines = messages.length
    ? messages.map((message) => `• [${message.channelName}](${message.link}) — ${message.content.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')
    : 'No matching messages were found for this user.';

  let incidentName = null;
  for (const message of messages) {
    incidentName = parseNameFromLogMessage(message.content);
    if (incidentName) break;
  }

  const displayName = incidentName || targetUser.displayName || targetUser.username;
  const embed = new EmbedBuilder()
    .setTitle(`Incident: ${displayName}`)
    .setColor(0x3498db)
    .addFields(
      { name: 'Target', value: `<@${targetUser.id}>`, inline: true },
      { name: 'Requested by', value: `<@${moderator.id}>`, inline: true },
      { name: 'Matches', value: `${messages.length}`, inline: true },
      { name: 'Messages', value: lines.slice(0, 1024) }
    )
    .setTimestamp();

  try {
    const sentMessage = await channel.send({ embeds: [embed] });
    await sentMessage.startThread({
      name: `Incident: ${displayName}`,
      autoArchiveDuration: 1440,
    }).catch(() => null);
    return { posted: true, messageId: sentMessage.id, channelId: sentMessage.channelId };
  } catch (error) {
    console.error(`[grabprofile] Failed to post incident to ${channel.id}:`, error);
    return { posted: false, reason: `Failed to post the grab-profile entry (${error?.message || 'unknown error'}).` };
  }
}

async function postLog({ guild, offenderUser, offenderDisplayName, moderator, type, amount, reason, oldWeight, newWeight }) {
  const cfg = db.getConfig(guild.id);
  const channelId = cfg.log_channel_id;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`Weight ${type === 'add' ? 'Added' : 'Removed'}`)
    .setColor(type === 'add' ? 0xe74c3c : 0x2ecc71)
    .addFields(
      { name: 'Offender', value: offenderUser ? `<@${offenderUser.id}>` : offenderDisplayName || 'Unknown', inline: true },
      { name: 'Enforcer', value: `<@${moderator.id}>`, inline: true },
      { name: 'Change', value: `${type === 'add' ? '+' : '-'}${amount}`, inline: true },
      { name: 'Old Weight', value: `${oldWeight}`, inline: true },
      { name: 'New Weight', value: `${newWeight}`, inline: true },
      { name: 'Reason', value: reason }
    )
    .setTimestamp();

  channel.send({ embeds: [embed] }).catch(() => null);
}

async function postRoleAssignmentLog({ guild, giver, recipient, role }) {
  const cfg = db.getConfig(guild.id);
  const channelId = cfg.role_log_channel_id;
  if (!channelId) {
    console.warn(`[role-logs] No role log channel configured for guild ${guild.id}`);
    return;
  }

  const channel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased?.()) {
    console.warn(`[role-logs] Could not resolve role log channel ${channelId} for guild ${guild.id}`);
    return;
  }

  const botPermissions = channel.permissionsFor?.(guild.members.me) || null;
  if (!botPermissions?.has(PermissionFlagsBits.SendMessages) || !botPermissions.has(PermissionFlagsBits.EmbedLinks)) {
    console.warn(`[role-logs] Bot lacks message/embed permissions for role log channel ${channelId}`);
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Role Assigned')
    .setColor(0x2ecc71)
    .addFields(
      { name: 'User who gave role', value: giver ? `<@${giver.id}>` : 'Unknown', inline: true },
      { name: 'User who got role', value: recipient ? `<@${recipient.id}>` : 'Unknown', inline: true },
      { name: 'Role they got', value: role ? `<@&${role.id}>` : 'Unknown', inline: true }
    )
    .setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error(`[role-logs] Failed to send role assignment log to ${channelId}:`, error);
  }
}

async function refreshCaseMessage(guild, userId) {
  const offender = db.getOffender(userId);
  if (!offender || (!offender.case_channel_id || !offender.case_message_id)) return;
  const channel = await guild.channels.fetch(offender.case_channel_id).catch(() => null);
  if (!channel) return;
  const message = await channel.messages.fetch(offender.case_message_id).catch(() => null);
  if (!message) return;

  const offenderUser = offender.discord_id ? await client.users.fetch(offender.discord_id).catch(() => null) : null;
  const member = offender.discord_id ? await guild.members.fetch(offender.discord_id).catch(() => null) : null;
  const displayName = member?.nickname || member?.displayName || member?.user?.globalName || offender.display_name || offenderUser?.username || 'Unknown User';
  const avatarUrl = member?.displayAvatarURL?.() || offenderUser?.displayAvatarURL?.() || null;
  const charId = offender.char_id || null;

  await message.edit({
    embeds: [buildCaseEmbed({ offenderId: userId, displayName, avatarUrl, charId })],
    components: [buildCaseButtons(userId)],
  }).catch(() => null);
}

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Every hour, refresh all known case panels so decayed Weight reflects
  // without requiring anyone to click Refresh.
  cron.schedule('0 * * * *', async () => {
    const offenders = db.getAllOffendersWithCaseMessages();
    for (const o of offenders) {
      const guild = await client.guilds.fetch(o.guild_id).catch(() => null);
      if (!guild) continue;
      await refreshCaseMessage(guild, o.user_id);
    }
  });
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'case-start') {
        const cfg = db.getConfig(interaction.guildId);
        if (cfg.cases_channel_id && interaction.channelId !== cfg.cases_channel_id) {
          await interaction.reply({
            content: `Case panels can only be opened in <#${cfg.cases_channel_id}>.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const targetMember = interaction.options.getMember('user');
        const targetUser = targetMember?.user ?? interaction.options.getUser('user');
        const name = interaction.options.getString('name');
        const charId = interaction.options.getString('charid');

        if (!targetUser && !name && !charId) {
          await interaction.reply({
            content: 'Please provide either a Discord user or at least a Name/CharID for the profile.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply();

        let resolvedDisplayName = null;
        let resolvedAvatarUrl = null;
        if (targetUser) {
          const member = targetMember ?? (await interaction.guild.members.fetch(targetUser.id).catch(() => null));
          resolvedDisplayName = member?.nickname || member?.displayName || member?.user?.globalName || member?.user?.username || targetUser.username;
          resolvedAvatarUrl = member?.displayAvatarURL?.() || targetUser.displayAvatarURL?.() || null;
        }

        const identity = buildCaseIdentity({ targetUser, name, charId });
        db.ensureOffender(identity.offenderId, interaction.guildId, {
          displayName: resolvedDisplayName || identity.displayName,
          discordId: identity.discordId,
          charId: identity.charId,
          isExternal: identity.isExternal,
        });

        const embed = buildCaseEmbed({
          offenderId: identity.offenderId,
          displayName: resolvedDisplayName || identity.displayName,
          avatarUrl: resolvedAvatarUrl,
          charId: identity.charId,
        });
        const row = buildCaseButtons(identity.offenderId);
        await interaction.editReply({ embeds: [embed], components: [row] });
        const message = await interaction.fetchReply();
        db.setCaseMessage(identity.offenderId, message.channelId, message.id);
      }

      if (interaction.commandName === 'weight-config') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'log-channel') {
          const channel = interaction.options.getChannel('channel', true);
          db.setLogChannel(interaction.guildId, channel.id);
          await interaction.reply({ content: `Log channel set to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'cases-channel') {
          const channel = interaction.options.getChannel('channel', true);
          db.setCasesChannel(interaction.guildId, channel.id);
          await interaction.reply({ content: `/case-start is now restricted to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'add-role') {
          const role = interaction.options.getRole('role', true);
          db.addAllowedRole(interaction.guildId, role.id);
          await interaction.reply({ content: `<@&${role.id}> can now add/remove Weight.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'remove-role') {
          const role = interaction.options.getRole('role', true);
          db.removeAllowedRole(interaction.guildId, role.id);
          await interaction.reply({ content: `<@&${role.id}> can no longer add/remove Weight.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'grab-role-add') {
          const role = interaction.options.getRole('role', true);
          db.addGrabProfileAllowedRole(interaction.guildId, role.id);
          await interaction.reply({ content: `<@&${role.id}> can now use /grabprofile.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'grab-role-remove') {
          const role = interaction.options.getRole('role', true);
          db.removeGrabProfileAllowedRole(interaction.guildId, role.id);
          await interaction.reply({ content: `<@&${role.id}> can no longer use /grabprofile.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'grab-source-add') {
          const channel = interaction.options.getChannel('channel', true);
          db.addGrabProfileSourceChannel(interaction.guildId, channel.id);
          await interaction.reply({ content: `<#${channel.id}> has been added to grabprofile search sources.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'grab-source-remove') {
          const channel = interaction.options.getChannel('channel', true);
          db.removeGrabProfileSourceChannel(interaction.guildId, channel.id);
          await interaction.reply({ content: `<#${channel.id}> is no longer a grabprofile search source.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'grab-destination-add') {
          const role = interaction.options.getRole('role', true);
          const channel = interaction.options.getChannel('channel', true);
          db.addGrabProfileDestination(interaction.guildId, role.id, channel.id);
          await interaction.reply({ content: `<#${channel.id}> is now a permitted grabprofile destination for <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'grab-destination-remove') {
          const role = interaction.options.getRole('role', true);
          const channel = interaction.options.getChannel('channel', true);
          db.removeGrabProfileDestination(interaction.guildId, role.id, channel.id);
          await interaction.reply({ content: `<#${channel.id}> is no longer a permitted grabprofile destination for <@&${role.id}>.`, flags: MessageFlags.Ephemeral });
        } else if (sub === 'view') {
          const cfg = db.getConfig(interaction.guildId);
          const roles = cfg.allowed_role_ids.length
            ? cfg.allowed_role_ids.map((r) => `<@&${r}>`).join(', ')
            : 'None configured (only server Administrators can act)';
          const grabRoles = cfg.grab_profile_allowed_role_ids.length
            ? cfg.grab_profile_allowed_role_ids.map((r) => `<@&${r}>`).join(', ')
            : 'None configured (only server Administrators can act)';
          const sourceChannels = cfg.grab_profile_source_channel_ids.length
            ? cfg.grab_profile_source_channel_ids.map((c) => `<#${c}>`).join(', ')
            : 'None configured';
          const destinations = Object.entries(cfg.grab_profile_destination_map || {}).map(
            ([roleId, channels]) => `${roleId}: ${channels.map((c) => `<#${c}>`).join(', ')}`
          ).join('\n') || 'None configured';
          await interaction.reply({
            content: `**Log channel:** ${cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : 'Not set'}\n**Cases channel:** ${cfg.cases_channel_id ? `<#${cfg.cases_channel_id}>` : 'Not restricted (any channel)'}\n**Allowed roles:** ${roles}\n**Grabprofile roles:** ${grabRoles}\n**Search sources:** ${sourceChannels}\n**Destinations:** ${destinations}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      if (interaction.commandName === 'grabprofile') {
        const targetUser = interaction.options.getUser('user', true);
        if (!canUseGrabProfile(interaction.member, interaction.guildId)) {
          await interaction.reply({ content: 'You do not have permission to use /grabprofile.', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const messages = await collectRelevantMessages({ guild: interaction.guild, targetUser });
        const destinationChannelIds = interaction.member.permissions.has(PermissionFlagsBits.Administrator)
          ? Object.values(db.getAllGrabProfileDestinations(interaction.guildId)).flat()
          : db.getGrabProfileDestinationsForRoles(interaction.guildId, interaction.member.roles.cache.map((role) => role.id));
        const result = await postGrabProfileLog({ guild: interaction.guild, targetUser, messages, moderator: interaction.user, destinationChannelIds });

        if (!result.posted) {
          await interaction.editReply({ content: `Unable to create the grab-profile entry: ${result.reason}` });
          return;
        }

        await interaction.editReply({
          content: `Grabbed ${messages.length} match${messages.length === 1 ? '' : 'es'} for <@${targetUser.id}> and posted them to the configured incident channel.`,
        });
        return;
      }

      if (interaction.commandName === 'giverole' || interaction.commandName === 'roleadd') {
        const targetUser = interaction.options.getUser('user', true);
        const targetRole = interaction.options.getRole('role', true);

        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator) && !canGrantRoleForMember(interaction.member, interaction.guildId, targetRole.id)) {
          await interaction.reply({ content: 'You do not have permission to grant that role.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (targetRole.permissions.has(PermissionFlagsBits.Administrator) || targetRole.id === interaction.guild.id) {
          await interaction.reply({ content: 'That role cannot be assigned through this command.', flags: MessageFlags.Ephemeral });
          return;
        }

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
          await interaction.reply({ content: 'That user is not available in this server.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (targetMember.roles.cache.has(targetRole.id)) {
          await interaction.reply({ content: `<@${targetUser.id}> already has <@&${targetRole.id}>.`, flags: MessageFlags.Ephemeral });
          return;
        }

        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          await interaction.reply({ content: 'The bot needs the Manage Roles permission to assign roles.', flags: MessageFlags.Ephemeral });
          return;
        }

        if (targetRole.comparePositionTo(botMember.roles.highest) >= 0) {
          await interaction.reply({
            content: 'The bot cannot manage that role because it is equal to or above the bot\'s highest role in the server hierarchy. Move the bot\'s role above the target role, or choose a lower role.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          const memberHighest = interaction.member.roles.highest;
          if (targetRole.comparePositionTo(memberHighest) >= 0) {
            await interaction.reply({
              content: 'That role is equal to or higher than your highest role, so you cannot assign it.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        try {
          await targetMember.roles.add(targetRole.id);
          await postRoleAssignmentLog({
            guild: interaction.guild,
            giver: interaction.user,
            recipient: targetUser,
            role: targetRole,
          });
          await interaction.reply({ content: `Assigned <@&${targetRole.id}> to <@${targetUser.id}>.`, flags: MessageFlags.Ephemeral });
        } catch (error) {
          console.error(error);
          await interaction.reply({ content: 'I could not assign that role. Check the role hierarchy and bot permissions.', flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (interaction.commandName === 'setname') {
        const targetUser = interaction.options.getUser('user', true);
        const newName = interaction.options.getString('name', true).trim();

        const memberToChange = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!memberToChange) {
          await interaction.reply({ content: 'That user is not available in this server.', flags: MessageFlags.Ephemeral });
          return;
        }

        // Check permissions: Admins or role-based name-change permissions
        const namePermissions = db.getNamePermissions(interaction.guildId);
        const allowed = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
          interaction.member.roles.cache.some((r) => {
            return namePermissions.some((mapping) =>
              mapping.grant_role_id === r.id &&
              (!mapping.target_role_id || memberToChange.roles.cache.has(mapping.target_role_id))
            );
          });

        if (!allowed) {
          await interaction.reply({ content: 'You do not have permission to change that user\'s nickname.', flags: MessageFlags.Ephemeral });
          return;
        }

        const botMember = interaction.guild.members.me;
        if (!botMember.permissions.has(PermissionFlagsBits.ManageNicknames)) {
          await interaction.reply({ content: 'The bot needs the Manage Nicknames permission to change nicknames.', flags: MessageFlags.Ephemeral });
          return;
        }

        try {
          await memberToChange.setNickname(newName);
          await interaction.reply({ content: `Changed nickname of <@${targetUser.id}> to **${newName}**.`, flags: MessageFlags.Ephemeral });
        } catch (error) {
          console.error(error);
          await interaction.reply({ content: 'I could not change that user\'s nickname. Check role hierarchy and bot permissions.', flags: MessageFlags.Ephemeral });
        }
        return;
      }

      if (interaction.commandName === 'setnameperms') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only administrators can manage name permissions.', flags: MessageFlags.Ephemeral });
          return;
        }

        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
          const grantRole = interaction.options.getRole('grantrole', true);
          const targetRole = interaction.options.getRole('targetrole', false);
          db.addNamePermission(interaction.guildId, grantRole.id, targetRole?.id || null);
          await interaction.reply({
            content: targetRole
              ? `<@&${grantRole.id}> can now rename members with <@&${targetRole.id}>.`
              : `<@&${grantRole.id}> can now rename any member.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        } else if (sub === 'remove') {
          const grantRole = interaction.options.getRole('grantrole', true);
          const targetRole = interaction.options.getRole('targetrole', false);
          db.removeNamePermission(interaction.guildId, grantRole.id, targetRole?.id || null);
          await interaction.reply({
            content: targetRole
              ? `<@&${grantRole.id}> can no longer rename members with <@&${targetRole.id}>.`
              : `<@&${grantRole.id}> can no longer rename any member.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      if (interaction.commandName === 'nameperms') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only administrators can view name permissions.', flags: MessageFlags.Ephemeral });
          return;
        }

        const mappings = db.getNamePermissions(interaction.guildId);
        const content = mappings.length
          ? mappings.map(({ grant_role_id, target_role_id }) =>
              target_role_id
                ? `<@&${grant_role_id}> → <@&${target_role_id}>`
                : `<@&${grant_role_id}> → any member`
            ).join('\n')
          : 'No role rename permissions have been configured.';

        await interaction.reply({ content: `**Role rename permissions**\n${content}`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rolepermadd') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only administrators can manage role grant permissions.', flags: MessageFlags.Ephemeral });
          return;
        }

        const grantRole = interaction.options.getRole('grantrole', true);
        const targetRole = interaction.options.getRole('targetrole', true);

        if (grantRole.id === targetRole.id) {
          await interaction.reply({ content: 'A role cannot grant itself.', flags: MessageFlags.Ephemeral });
          return;
        }

        db.addRolePermission(interaction.guildId, grantRole.id, targetRole.id);
        await interaction.reply({ content: `<@&${grantRole.id}> can now grant <@&${targetRole.id}>.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rolepermremove') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only administrators can manage role grant permissions.', flags: MessageFlags.Ephemeral });
          return;
        }

        const grantRole = interaction.options.getRole('grantrole', true);
        const targetRole = interaction.options.getRole('targetrole', true);

        db.removeRolePermission(interaction.guildId, grantRole.id, targetRole.id);
        await interaction.reply({ content: `<@&${grantRole.id}> can no longer grant <@&${targetRole.id}>.`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rolepermsview') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only administrators can view role grant permissions.', flags: MessageFlags.Ephemeral });
          return;
        }

        const mappings = db.getRolePermissions(interaction.guildId);
        const content = mappings.length
          ? mappings.map(({ grant_role_id, target_role_id }) => `<@&${grant_role_id}> → <@&${target_role_id}>`).join('\n')
          : 'No role grant permissions have been configured.';

        await interaction.reply({ content: `**Role grant permissions**\n${content}`, flags: MessageFlags.Ephemeral });
        return;
      }

      if (interaction.commandName === 'rolelogs') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
          await interaction.reply({ content: 'Only administrators can set the role log channel.', flags: MessageFlags.Ephemeral });
          return;
        }

        const channel = interaction.options.getChannel('channel', true);
        db.setRoleLogChannel(interaction.guildId, channel.id);
        await interaction.reply({ content: `Role assignment logs will now be sent to <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
        return;
      }
      return;
    }

    if (interaction.isButton()) {
      const { action, offenderId } = parseCustomId(interaction.customId);

      if (action === 'refresh') {
        await interaction.deferUpdate();
        const offender = db.getOffender(offenderId);
        const offenderUser = offender?.discord_id ? await client.users.fetch(offender.discord_id).catch(() => null) : null;
        const member = offender?.discord_id ? await interaction.guild.members.fetch(offender.discord_id).catch(() => null) : null;
        const displayName = member?.nickname || member?.displayName || member?.user?.globalName || offender?.display_name || offenderUser?.username || 'Unknown User';
        const avatarUrl = member?.displayAvatarURL?.() || offenderUser?.displayAvatarURL?.() || null;
        const charId = offender?.char_id || null;
        await interaction.message.edit({
          embeds: [buildCaseEmbed({ offenderId, displayName, avatarUrl, charId })],
          components: [buildCaseButtons(offenderId)],
        });
        return;
      }

      if (action === 'add_weight' || action === 'remove_weight') {
        if (!isAuthorized(interaction.member, interaction.guildId)) {
          await interaction.reply({
            content: 'You do not have permission to modify Weight. Contact a Head Enforcer+ to have your role added via `/weight-config add-role`.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(buildButtonId(`${action}_modal`, offenderId))
          .setTitle(action === 'add_weight' ? 'Add Weight' : 'Remove Weight');

        const amountInput = new TextInputBuilder()
          .setCustomId('amount')
          .setLabel('Weight amount (e.g. 0.5, 1, 2, 3)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const reasonInput = new TextInputBuilder()
          .setCustomId('reason')
          .setLabel('Reason / offense description')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(amountInput),
          new ActionRowBuilder().addComponents(reasonInput)
        );

        await interaction.showModal(modal);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const { action, offenderId } = parseCustomId(interaction.customId);
      if (action !== 'add_weight_modal' && action !== 'remove_weight_modal') return;

      if (!isAuthorized(interaction.member, interaction.guildId)) {
        await interaction.reply({ content: 'You do not have permission to modify Weight.', flags: MessageFlags.Ephemeral });
        return;
      }

      const rawAmount = interaction.fields.getTextInputValue('amount').trim();
      const reason = interaction.fields.getTextInputValue('reason').trim();
      const amount = Number(rawAmount);

      if (Number.isNaN(amount) || amount <= 0) {
        await interaction.reply({ content: `"${rawAmount}" is not a valid positive number.`, flags: MessageFlags.Ephemeral });
        return;
      }

      const type = action === 'add_weight_modal' ? 'add' : 'remove';
      const offender = db.getOffender(offenderId);
      const offenderUser = offender?.discord_id ? await client.users.fetch(offender.discord_id).catch(() => null) : null;
      const oldWeight = db.getCurrentWeight(offenderId);

      db.addEntry({
        userId: offenderId,
        guildId: interaction.guildId,
        type,
        amount,
        reason,
        moderatorId: interaction.user.id,
      });

      const newWeight = db.getCurrentWeight(offenderId);

      await postLog({
        guild: interaction.guild,
        offenderUser,
        offenderDisplayName: offender?.display_name || offenderUser?.username || 'Unknown User',
        moderator: interaction.user,
        type,
        amount,
        reason,
        oldWeight,
        newWeight,
      });

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await interaction.editReply({
        content: `${type === 'add' ? 'Added' : 'Removed'} **${amount}** Weight ${type === 'add' ? 'to' : 'from'} ${offender?.display_name || offenderUser?.username || 'this profile'}. New total: **${newWeight}**.`,
      });

      await refreshCaseMessage(interaction.guild, offenderId);
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong. Check the bot logs.', flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
