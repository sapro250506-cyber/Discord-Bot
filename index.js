const cron = require("node-cron");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField
} = require("discord.js");

const config = require("./config");
const { loadState, saveState } = require("./storage");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ]
});

const QUESTIONS = [
  "Wie aktiv war die Person heute?",
  "War sie romantisch genug?",
  "Hast du genug Aufmerksamkeit bekommen?",
  "Emotionale Nähe heute?",
  "Kommunikation (Qualität & Klarheit)?",
  "Initiative gezeigt?",
  "Interesse an dir spürbar?",
  "Zeit für dich genommen?",
  "Zuverlässigkeit & Verbindlichkeit?",
  "Gesamteindruck des Tages?"
];

const DESCRIPTIONS = {
  1: "Sehr schlecht",
  2: "Schlecht",
  3: "Okay",
  4: "Gut",
  5: "Sehr gut"
};

function todayKey() {
  // YYYY-MM-DD (lokal). Für Berlin-Genauigkeit: Server TZ auf Europe/Berlin setzen.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function stars(n) {
  return "⭐".repeat(Math.max(0, Math.min(5, Number(n) || 0)));
}

function clamp1to5(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x < 1 || x > 5) return null;
  return x;
}

function freshDailyState(state) {
  const key = todayKey();
  if (!state.daily || state.daily.date !== key) {
    state.daily = {
      date: key,
      started: false,
      completed: false,
      startedAt: null,
      completedAt: null,
      // answers: array length 10, values 1..5 or null
      answers: Array(QUESTIONS.length).fill(null),
      messages: {
        introMessageId: null,
        questionMessageIds: Array(QUESTIONS.length).fill(null)
      },
      reminder: {
        r1: false,
        r2: false,
        r3: false
      }
    };
  }
  return state;
}

async function safeFetchChannel() {
  const guild = await client.guilds.fetch(config.guildId);
  const channel = await guild.channels.fetch(config.reviewChannelId);
  return { guild, channel };
}

function isReviewer(userId) {
  return userId === config.reviewerUserId;
}

function buildIntroEmbed(state) {
  const d = state.daily;
  const status = d.completed ? "✅ Abgeschlossen" : (d.started ? "🟡 Läuft" : "⚪ Nicht gestartet");
  const answered = d.answers.filter(v => v !== null).length;

  return new EmbedBuilder()
    .setTitle("📝 Daily Relationship Review")
    .setDescription(
      [
        `Datum: **${d.date}**`,
        `Status: **${status}**`,
        `Fortschritt: **${answered}/${QUESTIONS.length}**`,
        "",
        "Bewerte jede Frage über das Select-Menu (⭐ 1–5).",
        "Sobald alles beantwortet ist, wird automatisch ausgewertet und per DM versendet."
      ].join("\n")
    )
    .setColor(0xE91E63)
    .setFooter({ text: "Zugriff: Nur autorisierter Bewerter & nur im festgelegten Channel." })
    .setTimestamp();
}

function buildQuestionEmbed(i) {
  return new EmbedBuilder()
    .setTitle(`Frage ${i + 1}/${QUESTIONS.length}`)
    .setDescription(QUESTIONS[i])
    .setColor(0xE91E63)
    .setFooter({ text: "Wähle 1–5 Sterne" });
}

function buildSelectRow(i) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`review_${i}`)
      .setPlaceholder("Bewertung auswählen")
      .addOptions([1, 2, 3, 4, 5].map(n => ({
        label: `${stars(n)} (${n}/5)`,
        value: String(n),
        description: DESCRIPTIONS[n]
      })))
  );
}

function buildResultEmbed(state, avg) {
  const d = state.daily;
  const roundedAvg = Math.round(avg);

  const fields = QUESTIONS.map((q, i) => {
    const val = d.answers[i];
    return {
      name: q,
      value: val ? `${stars(val)} (**${val}/5**) — ${DESCRIPTIONS[val]}` : "—",
      inline: false
    };
  });

  fields.push({
    name: "📊 Durchschnitt",
    value: `${stars(roundedAvg)} (**${avg.toFixed(2)}/5**)`,
    inline: false
  });

  // Simple “Highlights”
  const max = Math.max(...d.answers.filter(v => v !== null));
  const min = Math.min(...d.answers.filter(v => v !== null));
  const bestIdx = d.answers.findIndex(v => v === max);
  const worstIdx = d.answers.findIndex(v => v === min);

  fields.push({
    name: "🔎 Highlights",
    value: [
      `Top: **${QUESTIONS[bestIdx]}** → ${stars(max)} (${max}/5)`,
      `Low: **${QUESTIONS[worstIdx]}** → ${stars(min)} (${min}/5)`
    ].join("\n"),
    inline: false
  });

  return new EmbedBuilder()
    .setTitle("💖 Tages-Auswertung")
    .setDescription(`Datum: **${d.date}**`)
    .setColor(0xE91E63)
    .addFields(fields)
    .setTimestamp();
}

async function sendReminderDM(state, which) {
  if (!config.behavior.dmReminders) return;

  const d = state.daily;
  if (!d.started || d.completed) return;

  const answered = d.answers.filter(v => v !== null).length;
  const missing = QUESTIONS.length - answered;

  const embed = new EmbedBuilder()
    .setTitle("⏰ Erinnerung: Daily Review offen")
    .setDescription(
      [
        `Datum: **${d.date}**`,
        `Fortschritt: **${answered}/${QUESTIONS.length}**`,
        `Offen: **${missing}**`,
        "",
        "Bitte im vorgesehenen Channel die fehlenden Fragen beantworten."
      ].join("\n")
    )
    .setColor(0xFF9800)
    .setFooter({ text: `Reminder ${which}` })
    .setTimestamp();

  try {
    const reviewer = await client.users.fetch(config.reviewerUserId);
    await reviewer.send({ embeds: [embed] });
  } catch {
    // DM kann deaktiviert sein – ignorieren.
  }
}

async function maybePingInChannel(text) {
  if (!text) return;
  const { channel } = await safeFetchChannel();
  await channel.send({ content: text });
}

async function startDailyReview(state, initiatedBy = "cron") {
  state = freshDailyState(state);
  const d = state.daily;

  if (d.started) return { ok: false, reason: "already_started" };

  const { channel } = await safeFetchChannel();

  d.started = true;
  d.startedAt = new Date().toISOString();

  // Intro
  const intro = await channel.send({ embeds: [buildIntroEmbed(state)] });
  d.messages.introMessageId = intro.id;

  if (config.behavior.pingReviewerInChannelOnStart) {
    await maybePingInChannel(`<@${config.reviewerUserId}> Daily Review ist bereit.`);
  }

  // Fragen
  for (let i = 0; i < QUESTIONS.length; i++) {
    const msg = await channel.send({
      embeds: [buildQuestionEmbed(i)],
      components: [buildSelectRow(i)]
    });
    d.messages.questionMessageIds[i] = msg.id;
  }

  saveState(state);
  return { ok: true, initiatedBy };
}

async function completeIfReady(state) {
  const d = state.daily;
  if (!d.started || d.completed) return;

  const answered = d.answers.filter(v => v !== null).length;
  if (answered !== QUESTIONS.length) return;

  const sum = d.answers.reduce((a, b) => a + b, 0);
  const avg = sum / QUESTIONS.length;

  const resultEmbed = buildResultEmbed(state, avg);

  // DM an Target
  const target = await client.users.fetch(config.targetUserId);
  await target.send({ embeds: [resultEmbed] });

  d.completed = true;
  d.completedAt = new Date().toISOString();

  // Optional: Abschluss-Notice im Channel
  const { channel } = await safeFetchChannel();
  const doneEmbed = new EmbedBuilder()
    .setTitle("✅ Review abgeschlossen")
    .setDescription("Auswertung wurde erfolgreich per DM versendet.")
    .setColor(0x4CAF50)
    .setTimestamp();
  await channel.send({ embeds: [doneEmbed] });

  saveState(state);
}

async function autoCloseIfOpen(state) {
  state = freshDailyState(state);
  const d = state.daily;
  if (!d.started || d.completed) return;

  const answered = d.answers.filter(v => v !== null).length;
  const missingIdx = d.answers
    .map((v, i) => (v === null ? i : null))
    .filter(v => v !== null);

  const embed = new EmbedBuilder()
    .setTitle("🛑 Daily Review automatisch geschlossen")
    .setDescription(
      [
        `Datum: **${d.date}**`,
        `Fortschritt: **${answered}/${QUESTIONS.length}**`,
        "",
        missingIdx.length
          ? `Offene Fragen:\n${missingIdx.map(i => `• ${i + 1}) ${QUESTIONS[i]}`).join("\n")}`
          : "Keine offenen Fragen."
      ].join("\n")
    )
    .setColor(0x9E9E9E)
    .setTimestamp();

  // DM an Reviewer
  try {
    const reviewer = await client.users.fetch(config.reviewerUserId);
    await reviewer.send({ embeds: [embed] });
  } catch {}

  // Optional: DM an Target
  if (config.behavior.dmTargetOnIncompleteClose) {
    try {
      const target = await client.users.fetch(config.targetUserId);
      await target.send({ embeds: [embed] });
    } catch {}
  }

  // Markiere als "abgeschlossen" um keine weiteren Reminders zu senden
  d.completed = true;
  d.completedAt = new Date().toISOString();
  saveState(state);
}

let STATE = loadState();
STATE = freshDailyState(STATE);
saveState(STATE);

client.once("ready", async () => {
  console.log(`Bot online als ${client.user.tag}`);
  STATE = freshDailyState(STATE);
  saveState(STATE);

  // Cron Jobs
  cron.schedule(config.cron.dailyPost, async () => {
    try {
      STATE = loadState();
      await startDailyReview(STATE, "cron");
    } catch (e) {
      console.error("dailyPost error:", e);
    }
  });

  cron.schedule(config.cron.reminder1, async () => {
    try {
      STATE = loadState(); STATE = freshDailyState(STATE);
      if (!STATE.daily.reminder.r1) {
        await sendReminderDM(STATE, 1);
        STATE.daily.reminder.r1 = true;
        saveState(STATE);

        if (config.behavior.pingReviewerInChannelOnReminders) {
          await maybePingInChannel(`<@${config.reviewerUserId}> Reminder: Daily Review ist noch offen.`);
        }
      }
    } catch (e) {
      console.error("reminder1 error:", e);
    }
  });

  cron.schedule(config.cron.reminder2, async () => {
    try {
      STATE = loadState(); STATE = freshDailyState(STATE);
      if (!STATE.daily.reminder.r2) {
        await sendReminderDM(STATE, 2);
        STATE.daily.reminder.r2 = true;
        saveState(STATE);

        if (config.behavior.pingReviewerInChannelOnReminders) {
          await maybePingInChannel(`<@${config.reviewerUserId}> Reminder: Daily Review ist noch offen.`);
        }
      }
    } catch (e) {
      console.error("reminder2 error:", e);
    }
  });

  cron.schedule(config.cron.reminder3, async () => {
    try {
      STATE = loadState(); STATE = freshDailyState(STATE);
      if (!STATE.daily.reminder.r3) {
        await sendReminderDM(STATE, 3);
        STATE.daily.reminder.r3 = true;
        saveState(STATE);

        if (config.behavior.pingReviewerInChannelOnReminders) {
          await maybePingInChannel(`<@${config.reviewerUserId}> Letzter Reminder heute.`);
        }
      }
    } catch (e) {
      console.error("reminder3 error:", e);
    }
  });

  cron.schedule(config.cron.autoClose, async () => {
    try {
      STATE = loadState();
      await autoCloseIfOpen(STATE);
    } catch (e) {
      console.error("autoClose error:", e);
    }
  });
});

client.on("interactionCreate", async (interaction) => {
  try {
    // Select Menus (Antworten)
    if (interaction.isStringSelectMenu()) {
      // Hard-Security: Channel + User + CustomId Format
      if (interaction.channelId !== config.reviewChannelId) {
        return interaction.reply({ content: "❌ Nicht erlaubt (falscher Channel).", ephemeral: true });
      }
      if (!isReviewer(interaction.user.id)) {
        return interaction.reply({ content: "❌ Nicht erlaubt (falscher User).", ephemeral: true });
      }
      if (!interaction.customId.startsWith("review_")) {
        return interaction.reply({ content: "❌ Ungültige Interaktion.", ephemeral: true });
      }

      STATE = loadState();
      STATE = freshDailyState(STATE);

      const d = STATE.daily;
      if (!d.started || d.completed) {
        return interaction.reply({ content: "⚠️ Heute ist keine aktive Review offen.", ephemeral: true });
      }

      const idx = Number(interaction.customId.split("_")[1]);
      if (!Number.isInteger(idx) || idx < 0 || idx >= QUESTIONS.length) {
        return interaction.reply({ content: "❌ Ungültige Frage.", ephemeral: true });
      }

      const value = clamp1to5(interaction.values?.[0]);
      if (!value) {
        return interaction.reply({ content: "❌ Ungültiger Wert.", ephemeral: true });
      }

      d.answers[idx] = value;
      saveState(STATE);

      const answered = d.answers.filter(v => v !== null).length;
      await interaction.reply({
        content: `✅ Gespeichert: ${stars(value)} (${value}/5) — Fortschritt: ${answered}/${QUESTIONS.length}`,
        ephemeral: true
      });

      await completeIfReady(STATE);
      return;
    }

    // Slash Commands
    if (interaction.isChatInputCommand() && interaction.commandName === "review") {
      if (!isReviewer(interaction.user.id)) {
        return interaction.reply({ content: "❌ Nicht erlaubt.", ephemeral: true });
      }
      if (interaction.guildId !== config.guildId) {
        return interaction.reply({ content: "❌ Falscher Server.", ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();
      STATE = loadState();
      STATE = freshDailyState(STATE);

      if (sub === "start") {
        const res = await startDailyReview(STATE, "manual");
        if (!res.ok && res.reason === "already_started") {
          return interaction.reply({ content: "⚠️ Heute läuft bereits eine Review.", ephemeral: true });
        }
        return interaction.reply({ content: "✅ Review gestartet.", ephemeral: true });
      }

      if (sub === "status") {
        const d = STATE.daily;
        const answered = d.answers.filter(v => v !== null).length;
        const missingIdx = d.answers
          .map((v, i) => (v === null ? i : null))
          .filter(v => v !== null);

        const embed = new EmbedBuilder()
          .setTitle("📌 Review Status")
          .setDescription(
            [
              `Datum: **${d.date}**`,
              `Gestartet: **${d.started ? "Ja" : "Nein"}**`,
              `Abgeschlossen: **${d.completed ? "Ja" : "Nein"}**`,
              `Fortschritt: **${answered}/${QUESTIONS.length}**`,
              "",
              missingIdx.length
                ? `Offen:\n${missingIdx.map(i => `• Frage ${i + 1}`).join("\n")}`
                : "Alles beantwortet."
            ].join("\n")
          )
          .setColor(0x2196F3)
          .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (sub === "reset") {
        // Reset nur für heute
        const key = todayKey();
        STATE.daily = {
          date: key,
          started: false,
          completed: false,
          startedAt: null,
          completedAt: null,
          answers: Array(QUESTIONS.length).fill(null),
          messages: {
            introMessageId: null,
            questionMessageIds: Array(QUESTIONS.length).fill(null)
          },
          reminder: { r1: false, r2: false, r3: false }
        };
        saveState(STATE);

        return interaction.reply({ content: "✅ Heutige Review zurückgesetzt.", ephemeral: true });
      }
    }
  } catch (e) {
    console.error("interaction error:", e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: "⚠️ Fehler im System.", ephemeral: true });
      } catch {}
    }
  }
});

client.login(config.token);
