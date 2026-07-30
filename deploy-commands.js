require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('case-start')
    .setDescription('Open (or reopen) a Weight case panel for an offender in this channel')
    .addUserOption((opt) => opt.setName('user').setDescription('Discord user if they are still known to Discord').setRequired(false))
    .addStringOption((opt) => opt.setName('name').setDescription('Name for a profile').setRequired(false))
    .addStringOption((opt) => opt.setName('charid').setDescription('Character ID for the profile').setRequired(false))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('weight-config')
    .setDescription('Configure the Weight bot for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('log-channel')
        .setDescription('Set the channel where Weight change logs are posted')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Log channel').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('cases-channel')
        .setDescription('Restrict /case-start to only be usable in this channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Cases channel').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-role')
        .setDescription('Allow a role to add/remove Weight (e.g. Head Enforcer+)')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to allow').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-role')
        .setDescription('Remove a role from the allowed list')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('grab-profile-channel')
        .setDescription('Choose the channel where /grabprofile posts forwarded logs')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Target channel').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('add-grab-profile-role')
        .setDescription('Allow a role to use /grabprofile')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to allow').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove-grab-profile-role')
        .setDescription('Remove a role from the /grabprofile allowlist')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('grab-profile-search-add')
        .setDescription('Allow a role to search hiring logs in a channel')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role that may search this channel').setRequired(true))
        .addChannelOption((opt) => opt.setName('channel').setDescription('Hiring log channel to search').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('grab-profile-search-remove')
        .setDescription('Remove a role from searching hiring logs in a channel')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role that may search this channel').setRequired(true))
        .addChannelOption((opt) => opt.setName('channel').setDescription('Hiring log channel to remove').setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName('grab-profile-destination')
        .setDescription('Set where /grabprofile forwards the hiring log for a role')
        .addRoleOption((opt) => opt.setName('role').setDescription('Role that will forward here').setRequired(true))
        .addChannelOption((opt) => opt.setName('channel').setDescription('Destination channel for forwarded logs').setRequired(true))
    )
    .addSubcommand((sub) => sub.setName('view').setDescription('View current configuration'))
    .toJSON(),

    new SlashCommandBuilder()
      .setName('setname')
      .setDescription("Change a user's nickname")
      .addUserOption((opt) => opt.setName('user').setDescription('User to rename').setRequired(true))
      .addStringOption((opt) => opt.setName('name').setDescription('New nickname for the user').setRequired(true))
      .toJSON(),

    new SlashCommandBuilder()
      .setName('setnameperms')
      .setDescription('Configure which roles can change members\' nicknames')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Allow a role to rename members who have the target role (omit target to allow All)')
          .addRoleOption((opt) => opt.setName('grantrole').setDescription('Role that can rename members').setRequired(true))
          .addRoleOption((opt) => opt.setName('targetrole').setDescription('Role whose members may be renamed').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('Remove a name-change permission')
          .addRoleOption((opt) => opt.setName('grantrole').setDescription('Role that can rename members').setRequired(true))
          .addRoleOption((opt) => opt.setName('targetrole').setDescription('Role whose members may be renamed').setRequired(false))
      )
      .toJSON(),

    new SlashCommandBuilder()
      .setName('nameperms')
      .setDescription('List role rename permissions')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),

  new SlashCommandBuilder()
    .setName('grabprofile')
    .setDescription('Forward a user-related hiring log into the configured channel and open an incident thread')
    .addUserOption((opt) => opt.setName('user').setDescription('User whose profile should be grabbed').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('roleadd')
    .setDescription('Assign a role to a user if your role is permitted to grant it')
    .addUserOption((opt) => opt.setName('user').setDescription('User to receive the role').setRequired(true))
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to assign').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('giverole')
    .setDescription('Assign a role to a user if your role is permitted to grant it')
    .addUserOption((opt) => opt.setName('user').setDescription('User to receive the role').setRequired(true))
    .addRoleOption((opt) => opt.setName('role').setDescription('Role to assign').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('rolepermadd')
    .setDescription('Allow a role to grant another role')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((opt) => opt.setName('grantrole').setDescription('Role that can grant the target role').setRequired(true))
    .addRoleOption((opt) => opt.setName('targetrole').setDescription('Role that this grant role can assign').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('rolepermremove')
    .setDescription('Remove a role grant permission')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption((opt) => opt.setName('grantrole').setDescription('Role that currently grants the target role').setRequired(true))
    .addRoleOption((opt) => opt.setName('targetrole').setDescription('Role that should no longer be assignable').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('rolepermsview')
    .setDescription('List all configured role grant permissions')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('rolelogs')
    .setDescription('Choose a channel to receive role assignment logs')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((opt) => opt.setName('channel').setDescription('Channel for role assignment logs').setRequired(true))
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash commands registered successfully.');
  } catch (err) {
    console.error(err);
  }
})();
