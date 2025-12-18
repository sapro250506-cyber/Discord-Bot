// deploy-commands.js
const { REST, Routes, SlashCommandBuilder } = require("discord.js");
const config = require("./config");

const commands = [
  new SlashCommandBuilder()
    .setName("review")
    .setDescription("Daily Review System")
    .addSubcommand(s =>
      s.setName("start").setDescription("Startet die heutige Bewertung manuell (nur Reviewer).")
    )
    .addSubcommand(s =>
      s.setName("status").setDescription("Zeigt Status der heutigen Bewertung (nur Reviewer).")
    )
    .addSubcommand(s =>
      s.setName("reset").setDescription("Setzt die heutige Bewertung zurück (nur Reviewer).")
    )
    .toJSON()
];

const rest = new REST({ version: "10" }).setToken(config.token);

(async () => {
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, config.guildId),
    { body: commands }
  );
  console.log("Slash Commands deployed.");
})().catch(console.error);
