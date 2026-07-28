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
    .addSubcommand((sub) => sub.setName('view').setDescription('View current configuration'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('roleadd')
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
