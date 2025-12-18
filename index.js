/**
 * Multi-Region Topic News Bot (single-file)
 * - Pulls RSS feeds
 * - Clusters items by topic
 * - Posts one embed per topic per region to dedicated channels
 * - Dedup with persistent state.json
 *
 * Node 18+, discord.js v14
 */

import fs from "fs";
import cron from "node-cron";
import Parser from "rss-parser";
import { fetch as undiciFetch } from "undici";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

/* =========================
   CONFIG (EDIT THIS)
========================= */
const CONFIG = {
  token: "DEIN_BOT_TOKEN",
  // pro Region ein Channel (du kannst beliebig viele hinzufügen/ändern)
  channels: {
    DE: "1444337505292914860",
    IT: "CHANNEL_ID_IT",
    ES: "CHANNEL_ID_ES",
    UK: "CHANNEL_ID_UK",
    NATO: "CHANNEL_ID_NATO",
    GR: "CHANNEL_ID_GR",
    HR: "CHANNEL_ID_HR"
  },

  // Cron: alle 20 Minuten (stell’s ein wie du willst)
  schedule: "*/20 * * * *",

  // pro Region: wie viele neue Items max. pro Pull verarbeiten
  maxItemsPerRegion: 20,

  // pro Topic: wie viele Headlines in ein Embed
  maxHeadlinesPerTopic: 4,

  // Nur neue Artikel seit X Stunden (reduziert Spam)
  onlySinceHours: 24,

  // Wenn true: Postet auch dann, wenn sich Themen leicht überschneiden (aggressiver)
  aggressivePosting: false
};

/* =========================
   FEEDS
   (RSS-URLs können sich ändern – hier sind robuste Startpunkte)
========================= */
const FEEDS = {
  DE: [
    { source: "Tagesschau", url: "https://www.tagesschau.de/xml/rss2" },
    { source: "WELT", url: "https://www.welt.de/feeds/latest.rss" }
  ],
  IT: [
    // ANSA: die Kategorien stehen auf der offiziellen RSS-Seite
    // Du kannst hier weitere ANSA-Feeds ergänzen (Politica, Mondo, Economia, etc.)
    { source: "ANSA Top News", url: "https://www.ansa.it/sito/notizie/topnews/topnews_rss.xml" }
  ],
  ES: [
    // RTVE: je nach Feed-Endpoint kann es 400/403 geben -> wir senden User-Agent + Accept
    { source: "RTVE Noticias", url: "https://www.rtve.es/rss/temas_noticias.xml" },
    // EL PAÍS (ultimas-noticias): Endpoint kann je nach Region/UA empfindlich sein
    { source: "EL PAÍS Últimas", url: "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/ultimas-noticias/portada" }
  ],
  UK: [
    { source: "BBC UK", url: "http://newsrss.bbc.co.uk/rss/newsonline_uk_edition/front_page/rss.xml" },
    { source: "BBC Politics", url: "http://newsrss.bbc.co.uk/rss/newsonline_uk_edition/uk_politics/rss.xml" }
  ],
  NATO: [
    { source: "NATO Watch", url: "https://natowatch.org/news.xml" }
  ],
  GR: [
    // Falls du später eine direkte eKathimerini RSS-URL hast, einfach ergänzen:
    // { source: "eKathimerini", url: "..." }
    // Stabiler Fallback (PressDisplay liefert RSS-Endpoints, kann Paywall/Limit haben)
    { source: "Kathimerini English (PressDisplay)", url: "https://www.pressdisplay.com/pressdisplay/services/rss.ashx?cid=1142&type=full" }
  ],
  HR: [
    // Kroatische Regierung (English)
    { source: "Gov.hr (EN)", url: "https://vlada.gov.hr/rss.aspx?ID=14956" },
    // HRT: wenn verfügbar; ansonsten fällt der Bot nicht um, sondern nutzt andere Feeds
    { source: "HRT Latest (fallback)", url: "https://feed.hrt.hr/vijesti/latest.xml" }
  ]
};

/* =========================
   TOPIC MODEL (Heuristik, aber “geil formatiert”)
========================= */
const TOPICS = [
  { key: "SECURITY_DEFENSE", name: "Sicherheit & Verteidigung", keywords: ["nato", "militär", "armee", "rakete", "angriff", "krieg", "verteidigung", "rüstung", "cyber", "terror"] },
  { key: "POLITICS", name: "Politik", keywords: ["regierung", "parlament", "wahl", "minister", "koalition", "präsident", "kanzler", "gesetz", "abstimmung", "opposition"] },
  { key: "ECONOMY", name: "Wirtschaft", keywords: ["wirtschaft", "inflation", "rezession", "börse", "aktie", "zins", "eur", "haushalt", "konjunktur", "unternehmen"] },
  { key: "MIGRATION", name: "Migration & Gesellschaft", keywords: ["migration", "flüchtling", "asyl", "grenze", "integration", "protest", "streik", "kriminalität"] },
  { key: "ENERGY_CLIMATE", name: "Energie & Klima", keywords: ["energie", "strom", "gas", "klima", "co2", "wetter", "hitze", "flut", "dürre", "erneuerbar"] },
  { key: "TECH_SCIENCE", name: "Tech & Wissenschaft", keywords: ["ki", "ai", "software", "chip", "cyber", "forschung", "impf", "medizin", "raumfahrt", "wissenschaft"] },
  { key: "OTHER", name: "Weitere Themen", keywords: [] }
];

function normalizeText(s) {
  return (s || "")
    .toString()
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pickTopic(item) {
  const hay = normalizeText(`${item.title} ${item.contentSnippet || ""}`);
  for (const t of TOPICS) {
    if (t.key === "OTHER") continue;
    for (const kw of t.keywords) {
      if (hay.includes(kw)) return t.key;
    }
  }
  return "OTHER";
}

function shortSummary(text, maxLen = 220) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Kurzfazit: Noch keine saubere Vorschau im Feed.";
  return clean.length > maxLen ? clean.slice(0, maxLen - 1) + "…" : clean;
}

function whyItMatters(topicKey) {
  // Mini-“Value add” pro Thema (macht’s deutlich “geiler” als nur Headlines)
  switch (topicKey) {
    case "SECURITY_DEFENSE": return "Warum relevant: kann direkte Auswirkungen auf Sicherheitslage, Beschlüsse und Bündnispolitik haben.";
    case "POLITICS": return "Warum relevant: beeinflusst kurzfristig Entscheidungen, Budgets und die innenpolitische Lage.";
    case "ECONOMY": return "Warum relevant: kann Preise, Märkte, Jobs und Investitionsklima direkt bewegen.";
    case "MIGRATION": return "Warum relevant: wirkt auf gesellschaftliche Debatten, Behörden, Kapazitäten und politische Entscheidungen.";
    case "ENERGY_CLIMATE": return "Warum relevant: betrifft Kosten, Versorgungssicherheit und regulatorische Maßnahmen.";
    case "TECH_SCIENCE": return "Warum relevant: beeinflusst Innovation, Wettbewerbsfähigkeit und Regulierung.";
    default: return "Warum relevant: laufende Entwicklung – kann Folgeeffekte in mehreren Bereichen haben.";
  }
}

/* =========================
   STATE (persist dedup)
========================= */
const STATE_FILE = "./state.json";
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { seen: {} }; // seen[region] = { id: timestamp }
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
function makeItemId(item) {
  // stabiler Fingerprint
  return (item.guid || item.id || item.link || item.title || "")
    .toString()
    .trim();
}
function pruneOld(state, hours = 72) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  for (const region of Object.keys(state.seen || {})) {
    for (const id of Object.keys(state.seen[region] || {})) {
      if (state.seen[region][id] < cutoff) delete state.seen[region][id];
    }
  }
}

/* =========================
   RSS PARSER with robust fetch
========================= */
const parser = new Parser({
  customFields: {
    item: ["media:content", "content:encoded", "dc:creator"]
  }
});

// Some feeds are picky (400/403 unless UA/Accept are present)
async function fetchWithHeaders(url) {
  const res = await undiciFetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (NewsBot; +https://discord.com)",
      "accept": "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function parseFeed(url) {
  // rss-parser parseURL uses its own request; we override by pulling ourselves and parseString
  const xml = await fetchWithHeaders(url);
  return await parser.parseString(xml);
}

/* =========================
   DISCORD
========================= */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder()
    .setName("news")
    .setDescription("Poste jetzt die neuesten News (pro Region/Channel).")
    .addStringOption(o =>
      o.setName("region")
        .setDescription("Optional: DE/IT/ES/UK/NATO/GR/HR oder ALL")
        .setRequired(false)
    )
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(CONFIG.token);
  const appId = client.user.id;
  await rest.put(Routes.applicationCommands(appId), { body: commands });
}

function regionColor(region) {
  const map = { DE: 0x1f8b4c, IT: 0x2ecc71, ES: 0xe67e22, UK: 0x3498db, NATO: 0x9b59b6, GR: 0x2980b9, HR: 0xe74c3c };
  return map[region] ?? 0x2f3136;
}

function regionTitle(region) {
  const map = { DE: "Deutschland", IT: "Italien", ES: "Spanien", UK: "England / UK", NATO: "NATO", GR: "Griechenland", HR: "Kroatien" };
  return map[region] ?? region;
}

/* =========================
   CORE: collect -> cluster -> post
========================= */
async function collectRegion(region) {
  const feeds = FEEDS[region] || [];
  const items = [];
  for (const f of feeds) {
    try {
      const data = await parseFeed(f.url);
      for (const it of (data.items || []).slice(0, CONFIG.maxItemsPerRegion)) {
        items.push({
          region,
          source: f.source,
          title: it.title || "(ohne Titel)",
          link: it.link,
          pubDate: it.isoDate ? new Date(it.isoDate).getTime() : (it.pubDate ? new Date(it.pubDate).getTime() : Date.now()),
          contentSnippet: it.contentSnippet || it.content || ""
        });
      }
    } catch (e) {
      console.error(`[${region}] Feed error (${f.source}):`, e.message);
    }
  }
  // Sort newest first
  items.sort((a, b) => b.pubDate - a.pubDate);
  return items;
}

function filterNew(items, state, region) {
  const seen = (state.seen[region] ||= {});
  const cutoff = Date.now() - CONFIG.onlySinceHours * 3600 * 1000;

  const fresh = [];
  for (const it of items) {
    if (!it.link) continue;
    if (it.pubDate < cutoff) continue;

    const id = makeItemId(it);
    if (!id) continue;

    if (!seen[id]) {
      fresh.push(it);
    }
  }
  return fresh;
}

function markSeen(state, region, items) {
  const seen = (state.seen[region] ||= {});
  for (const it of items) {
    const id = makeItemId(it);
    if (id) seen[id] = Date.now();
  }
}

function clusterByTopic(items) {
  const groups = new Map(); // topicKey -> items
  for (const it of items) {
    const tk = pickTopic(it);
    if (!groups.has(tk)) groups.set(tk, []);
    groups.get(tk).push(it);
  }
  // sort inside each topic
  for (const [k, arr] of groups.entries()) {
    arr.sort((a, b) => b.pubDate - a.pubDate);
    groups.set(k, arr);
  }
  return groups;
}

async function postRegion(region, forcedChannelId = null) {
  const channelId = forcedChannelId || CONFIG.channels[region];
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const state = loadState();
  pruneOld(state, 96);

  const collected = await collectRegion(region);
  const fresh = filterNew(collected, state, region);

  if (!fresh.length && !CONFIG.aggressivePosting) return;

  const clusters = clusterByTopic(fresh.length ? fresh : collected.slice(0, 10));
  const topicKeys = Array.from(clusters.keys());

  // Post one embed per topic (only if there is content)
  for (const topicKey of topicKeys) {
    const topic = TOPICS.find(t => t.key === topicKey) || TOPICS.find(t => t.key === "OTHER");
    const arr = clusters.get(topicKey) || [];
    if (!arr.length) continue;

    const top = arr.slice(0, CONFIG.maxHeadlinesPerTopic);

    const lines = top.map((x, idx) => {
      const sum = shortSummary(x.contentSnippet, 160);
      // Markdown “nice”: headline clickable, one-liner summary
      return `**${idx + 1}. [${x.title}](${x.link})**\n${sum}\n_Quelle: ${x.source}_`;
    });

    const newest = new Date(top[0].pubDate).toLocaleString("de-DE", { timeZone: "Europe/Berlin" });

    const embed = new EmbedBuilder()
      .setTitle(`${regionTitle(region)} — ${topic.name}`)
      .setDescription(`${lines.join("\n\n")}\n\n${whyItMatters(topicKey)}`)
      .setColor(regionColor(region))
      .setFooter({ text: `Aktualisiert: ${newest}` })
      .setTimestamp(new Date());

    await channel.send({ embeds: [embed] }).catch(console.error);
  }

  // Mark seen only for truly fresh, so “ALL” doesn’t burn backlog
  if (fresh.length) markSeen(state, region, fresh);
  saveState(state);
}

async function postAllRegions() {
  const regions = Object.keys(CONFIG.channels);
  for (const r of regions) {
    await postRegion(r);
  }
}

/* =========================
   BOOT
========================= */
client.once("ready", async () => {
  console.log(`Online als ${client.user.tag}`);

  // register slash commands
  try {
    await registerCommands();
    console.log("Slash Commands registriert: /news");
  } catch (e) {
    console.error("Command registration failed:", e.message);
  }

  // initial run
  await postAllRegions();

  // schedule
  cron.schedule(CONFIG.schedule, async () => {
    await postAllRegions();
  });
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "news") return;

  const region = (interaction.options.getString("region") || "ALL").toUpperCase();
  await interaction.reply({ content: "Alles klar. Ich poste jetzt die neuesten Embeds.", ephemeral: true });

  if (region === "ALL") {
    await postAllRegions();
    return;
  }

  if (!CONFIG.channels[region]) {
    await interaction.followUp({ content: `Unbekannte Region: ${region}. Nutze DE/IT/ES/UK/NATO/GR/HR oder ALL.`, ephemeral: true });
    return;
  }

  await postRegion(region);
});

client.login(CONFIG.token);
