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

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function isAuthorized(member, guildId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const cfg = db.getConfig(guildId);
  return member.roles.cache.some((r) => cfg.allowed_role_ids.includes(r.id));
}

function canGrantRoleForMember(member, guildId, targetRoleId) {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((role) => db.canGrantRole(guildId, role.id, targetRoleId));
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
        } else if (sub === 'view') {
          const cfg = db.getConfig(interaction.guildId);
          const roles = cfg.allowed_role_ids.length
            ? cfg.allowed_role_ids.map((r) => `<@&${r}>`).join(', ')
            : 'None configured (only server Administrators can act)';
          await interaction.reply({
            content: `**Log channel:** ${cfg.log_channel_id ? `<#${cfg.log_channel_id}>` : 'Not set'}\n**Cases channel:** ${cfg.cases_channel_id ? `<#${cfg.cases_channel_id}>` : 'Not restricted (any channel)'}\n**Allowed roles:** ${roles}`,
            flags: MessageFlags.Ephemeral,
          });
        }
      }

      if (interaction.commandName === 'roleadd') {
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
