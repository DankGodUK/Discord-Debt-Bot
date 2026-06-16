require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, MessageFlags } = require('discord.js');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'debts.db');

let db;

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS debts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      owes_id       TEXT NOT NULL,
      owes_name     TEXT NOT NULL,
      isowed_id     TEXT NOT NULL,
      isowed_name   TEXT NOT NULL,
      amount        REAL NOT NULL,
      note          TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      guild_id      TEXT NOT NULL
    );
  `);

  saveDb();
}

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params = []) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
  const row = dbGet('SELECT last_insert_rowid() as id');
  return { lastInsertRowid: row ? row.id : null };
}

function formatSilver(n) {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n.toLocaleString()}`;
}

// Returns "X days/hours/mins ago" from a sqlite datetime string
function timeAgo(createdAt) {
  if (!createdAt) return '';
  const created = new Date(createdAt + 'Z'); // treat as UTC
  const diffMs = Date.now() - created.getTime();
  const mins  = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days  = Math.floor(diffMs / 86_400_000);
  if (days > 0)  return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0)  return `${mins}m ago`;
  return 'just now';
}

// Fetch guild display name (nickname) for a user, fall back to global display name then username
async function getDisplayName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.displayName; // nickname ?? globalName ?? username
  } catch {
    return null; // user left the guild or fetch failed
  }
}

const ALBION_GOLD  = '#C8A84B';
const ALBION_GREEN = '#27AE60';
const ALBION_RED   = '#C0392B';

// ── Amount helper: values < 1000 treated as millions ────────────────────────
function parseAmount(n) {
  if (n > 0 && n < 1000) return n * 1_000_000;
  return n;
}

// ── Slash command definitions ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('owe')
    .setDescription('Record that someone owes silver to someone else')
    .addUserOption(o => o.setName('owes').setDescription('Who owes the silver?').setRequired(true))
    .addUserOption(o => o.setName('isowed').setDescription('Who are they owed to?').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount in silver (e.g. 1.5 = 1.5m)').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Optional note')),

  new SlashCommandBuilder()
    .setName('iowe')
    .setDescription('Record that YOU owe someone silver')
    .addUserOption(o => o.setName('user').setDescription('Who do you owe?').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount in silver (e.g. 1.5 = 1.5m)').setRequired(true))
    .addStringOption(o => o.setName('note').setDescription('Optional note')),

  new SlashCommandBuilder()
    .setName('paid')
    .setDescription('Mark a debt as fully or partially paid')
    .addUserOption(o => o.setName('owes').setDescription('Who is paying?').setRequired(true))
    .addUserOption(o => o.setName('isowed').setDescription('Who are they paying?').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount paid (omit to clear entire debt)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('ipaid')
    .setDescription('Record that YOU paid someone')
    .addUserOption(o => o.setName('user').setDescription('Who did you pay?').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('Amount paid (omit to clear entire debt)').setRequired(false)),

  new SlashCommandBuilder()
    .setName('debts')
    .setDescription('Show all outstanding debts privately, or filter by player')
    .addUserOption(o => o.setName('player').setDescription('Filter by player').setRequired(false)),

  new SlashCommandBuilder()
    .setName('mydebt')
    .setDescription('Privately show all debts you owe and are owed'),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show net balance for a player')
    .addUserOption(o => o.setName('player').setDescription('Player').setRequired(true)),

  new SlashCommandBuilder()
    .setName('editdebt')
    .setDescription('Edit the amount or note on an existing debt')
    .addIntegerOption(o => o.setName('id').setDescription('Debt ID (shown in /debts)').setRequired(true))
    .addNumberOption(o => o.setName('amount').setDescription('New amount in silver (e.g. 1.5 = 1.5m)').setRequired(false))
    .addStringOption(o => o.setName('note').setDescription('New note').setRequired(false)),

  new SlashCommandBuilder()
    .setName('cleardebt')
    .setDescription('Remove a specific debt entry by ID')
    .addIntegerOption(o => o.setName('id').setDescription('Debt ID (shown in /debts)').setRequired(true)),
].map(c => c.toJSON());

// ── Discord client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// ── Shared ledger builder ─────────────────────────────────────────────────────
// Takes an array of debt rows and the guild, resolves live display names, returns an embed
async function buildLedgerEmbed(rows, guild, title) {
  const total = rows.reduce((s, r) => s + r.amount, 0);

  // Resolve all unique user IDs to display names in parallel
  const uniqueIds = [...new Set(rows.flatMap(r => [r.owes_id, r.isowed_id]))];
  const nameMap = {};
  await Promise.all(uniqueIds.map(async id => {
    const live = await getDisplayName(guild, id);
    nameMap[id] = live; // null if not resolvable
  }));

  const lines = rows.map(r => {
    const owesName   = nameMap[r.owes_id]   ?? r.owes_name;
    const isOwedName = nameMap[r.isowed_id] ?? r.isowed_name;
    const note = r.note ? ` *(${r.note})*` : '';
    const age  = r.created_at ? ` · ${timeAgo(r.created_at)}` : '';
    return `\`#${r.id}\` **${owesName}** owes **${isOwedName}** — **${formatSilver(r.amount)}**${note} \`${age.trim()}\``;
  }).join('\n');

  return new EmbedBuilder()
    .setColor(ALBION_GOLD)
    .setTitle(title)
    .setDescription(lines.slice(0, 4000))
    .setFooter({ text: `${rows.length} debt(s) · Total silver: ${formatSilver(total)}` })
    .setTimestamp();
}

// ── !debts prefix command (public) ───────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.toLowerCase().startsWith('!debts')) return;

  const guildId = message.guild.id;
  const debts = dbAll(`SELECT * FROM debts WHERE guild_id=? ORDER BY amount DESC`, [guildId]);

  if (debts.length === 0) {
    return message.channel.send('🎉 No outstanding debts! The guild is square.');
  }

  const embed = await buildLedgerEmbed(debts, message.guild, '🛡️ Guild Debt Ledger');
  message.channel.send({ embeds: [embed] });
});

// ── Slash command handler ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  try {
    const ephemeralCmds = new Set(['debts', 'mydebt', 'balance']);
    const isEphemeral = ephemeralCmds.has(interaction.commandName);
    await interaction.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });
    const guildId = interaction.guildId;
    const cmd = interaction.commandName;

    // ── /owe ──────────────────────────────────────────────────────────────
    if (cmd === 'owe') {
      const owesUser   = interaction.options.getUser('owes');
      const isOwedUser = interaction.options.getUser('isowed');
      const amount     = parseAmount(interaction.options.getNumber('amount'));
      const note       = interaction.options.getString('note') ?? null;

      if (owesUser.id === isOwedUser.id) {
        return interaction.editReply('❗ A player cannot owe themselves.');
      }

      // Use live display names at time of recording
      const owesName   = await getDisplayName(interaction.guild, owesUser.id)   ?? owesUser.username;
      const isOwedName = await getDisplayName(interaction.guild, isOwedUser.id) ?? isOwedUser.username;

      const existing = dbGet(
        `SELECT id, amount FROM debts WHERE owes_id=? AND isowed_id=? AND guild_id=?`,
        [owesUser.id, isOwedUser.id, guildId]
      );

      if (existing) {
        dbRun(`UPDATE debts SET amount=amount+?, owes_name=?, isowed_name=?, note=COALESCE(?,note) WHERE id=?`,
          [amount, owesName, isOwedName, note, existing.id]);
        const newTotal = existing.amount + amount;
        return interaction.editReply(
          `💸 **Debt updated:** <@${owesUser.id}> owes <@${isOwedUser.id}> — now **${formatSilver(newTotal)}** total`
        );
      }

      const result = dbRun(
        `INSERT INTO debts (owes_id, owes_name, isowed_id, isowed_name, amount, note, guild_id) VALUES (?,?,?,?,?,?,?)`,
        [owesUser.id, owesName, isOwedUser.id, isOwedName, amount, note, guildId]
      );

      const embed = new EmbedBuilder()
        .setColor(ALBION_GOLD)
        .setTitle('💰 Debt Recorded')
        .addFields(
          { name: 'Owes',   value: `<@${owesUser.id}>`,   inline: true },
          { name: 'To',     value: `<@${isOwedUser.id}>`, inline: true },
          { name: 'Amount', value: formatSilver(amount),  inline: true },
        )
        .setFooter({ text: `Debt ID: ${result.lastInsertRowid}${note ? ` · ${note}` : ''}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /iowe ─────────────────────────────────────────────────────────────
    if (cmd === 'iowe') {
      const me     = interaction.user;
      const toUser = interaction.options.getUser('user');
      const amount = parseAmount(interaction.options.getNumber('amount'));
      const note   = interaction.options.getString('note') ?? null;

      if (me.id === toUser.id) {
        return interaction.editReply('❗ You cannot owe yourself.');
      }

      const meName     = await getDisplayName(interaction.guild, me.id)     ?? me.username;
      const toUserName = await getDisplayName(interaction.guild, toUser.id) ?? toUser.username;

      const existing = dbGet(
        `SELECT id, amount FROM debts WHERE owes_id=? AND isowed_id=? AND guild_id=?`,
        [me.id, toUser.id, guildId]
      );

      if (existing) {
        dbRun(`UPDATE debts SET amount=amount+?, owes_name=?, isowed_name=?, note=COALESCE(?,note) WHERE id=?`,
          [amount, meName, toUserName, note, existing.id]);
        const newTotal = existing.amount + amount;
        return interaction.editReply(
          `💸 **Updated:** You owe <@${toUser.id}> — now **${formatSilver(newTotal)}** total`
        );
      }

      const result = dbRun(
        `INSERT INTO debts (owes_id, owes_name, isowed_id, isowed_name, amount, note, guild_id) VALUES (?,?,?,?,?,?,?)`,
        [me.id, meName, toUser.id, toUserName, amount, note, guildId]
      );

      return interaction.editReply(
        `💰 **Recorded:** You (<@${me.id}>) owe <@${toUser.id}> **${formatSilver(amount)}** *(ID: ${result.lastInsertRowid})*`
      );
    }

    // ── /paid ─────────────────────────────────────────────────────────────
    if (cmd === 'paid') {
      const owesUser   = interaction.options.getUser('owes');
      const isOwedUser = interaction.options.getUser('isowed');
      const rawAmount  = interaction.options.getNumber('amount');
      const amount     = rawAmount ? parseAmount(rawAmount) : null;

      const debts = dbAll(
        `SELECT * FROM debts WHERE owes_id=? AND isowed_id=? AND guild_id=? ORDER BY id ASC`,
        [owesUser.id, isOwedUser.id, guildId]
      );

      if (debts.length === 0) {
        return interaction.editReply(`❌ No debt found from <@${owesUser.id}> to <@${isOwedUser.id}>.`);
      }

      const totalOwed = debts.reduce((s, d) => s + d.amount, 0);

      if (!amount || amount >= totalOwed) {
        dbRun(
          `DELETE FROM debts WHERE owes_id=? AND isowed_id=? AND guild_id=?`,
          [owesUser.id, isOwedUser.id, guildId]
        );
        return interaction.editReply(
          `✅ **All clear!** <@${owesUser.id}> has fully paid <@${isOwedUser.id}> (**${formatSilver(totalOwed)}**).`
        );
      }

      let remaining = amount;
      for (const debt of debts) {
        if (remaining <= 0) break;
        if (debt.amount <= remaining) {
          remaining -= debt.amount;
          dbRun(`DELETE FROM debts WHERE id=?`, [debt.id]);
        } else {
          dbRun(`UPDATE debts SET amount=? WHERE id=?`, [debt.amount - remaining, debt.id]);
          remaining = 0;
        }
      }

      const newTotal = totalOwed - amount;
      return interaction.editReply(
        `💸 **Partial payment:** <@${owesUser.id}> paid <@${isOwedUser.id}> **${formatSilver(amount)}** — **${formatSilver(newTotal)}** still owed.`
      );
    }

    // ── /ipaid ────────────────────────────────────────────────────────────
    if (cmd === 'ipaid') {
      const me        = interaction.user;
      const toUser    = interaction.options.getUser('user');
      const rawAmount = interaction.options.getNumber('amount');
      const amount    = rawAmount ? parseAmount(rawAmount) : null;

      const debts = dbAll(
        `SELECT * FROM debts WHERE owes_id=? AND isowed_id=? AND guild_id=? ORDER BY id ASC`,
        [me.id, toUser.id, guildId]
      );

      if (debts.length === 0) {
        return interaction.editReply(`❌ No debt found from you to <@${toUser.id}>.`);
      }

      const totalOwed = debts.reduce((s, d) => s + d.amount, 0);

      if (!amount || amount >= totalOwed) {
        dbRun(
          `DELETE FROM debts WHERE owes_id=? AND isowed_id=? AND guild_id=?`,
          [me.id, toUser.id, guildId]
        );
        return interaction.editReply(
          `✅ **All clear!** You have fully paid <@${toUser.id}> (**${formatSilver(totalOwed)}**).`
        );
      }

      let remaining = amount;
      for (const debt of debts) {
        if (remaining <= 0) break;
        if (debt.amount <= remaining) {
          remaining -= debt.amount;
          dbRun(`DELETE FROM debts WHERE id=?`, [debt.id]);
        } else {
          dbRun(`UPDATE debts SET amount=? WHERE id=?`, [debt.amount - remaining, debt.id]);
          remaining = 0;
        }
      }

      const newTotal = totalOwed - amount;
      return interaction.editReply(
        `💸 **Paid:** You paid <@${toUser.id}> **${formatSilver(amount)}** — **${formatSilver(newTotal)}** still owed.`
      );
    }

    // ── /debts (private) ──────────────────────────────────────────────────
    if (cmd === 'debts') {
      const filterUser = interaction.options.getUser('player');

      let rows;
      if (filterUser) {
        rows = dbAll(
          `SELECT * FROM debts WHERE guild_id=? AND (owes_id=? OR isowed_id=?) ORDER BY amount DESC`,
          [guildId, filterUser.id, filterUser.id]
        );
      } else {
        rows = dbAll(`SELECT * FROM debts WHERE guild_id=? ORDER BY amount DESC`, [guildId]);
      }

      if (rows.length === 0) {
        return interaction.editReply(
          filterUser ? `No debts found for **${filterUser.displayName ?? filterUser.username}**.` : '🎉 No outstanding debts! The guild is square.'
        );
      }

      const title = filterUser
        ? `⚔️ Debts for ${filterUser.displayName ?? filterUser.username}`
        : '⚔️ Guild Debt Ledger';

      const embed = await buildLedgerEmbed(rows, interaction.guild, title);
      return interaction.editReply({ embeds: [embed] });
    }

    // ── /mydebt (private, self) ───────────────────────────────────────────
    if (cmd === 'mydebt') {
      const me = interaction.user;

      const owing = dbAll(
        `SELECT * FROM debts WHERE owes_id=? AND guild_id=? ORDER BY amount DESC`,
        [me.id, guildId]
      );
      const owed = dbAll(
        `SELECT * FROM debts WHERE isowed_id=? AND guild_id=? ORDER BY amount DESC`,
        [me.id, guildId]
      );

      if (owing.length === 0 && owed.length === 0) {
        return interaction.editReply('✅ You have no outstanding debts!');
      }

      // Resolve display names for all involved users
      const allRows = [...owing, ...owed];
      const uniqueIds = [...new Set(allRows.flatMap(r => [r.owes_id, r.isowed_id]))];
      const nameMap = {};
      await Promise.all(uniqueIds.map(async id => {
        nameMap[id] = await getDisplayName(interaction.guild, id);
      }));

      const formatRow = r => {
        const owesName   = nameMap[r.owes_id]   ?? r.owes_name;
        const isOwedName = nameMap[r.isowed_id] ?? r.isowed_name;
        const note = r.note ? ` *(${r.note})*` : '';
        const age  = r.created_at ? ` · ${timeAgo(r.created_at)}` : '';
        return `\`#${r.id}\` **${owesName}** owes **${isOwedName}** — **${formatSilver(r.amount)}**${note} \`${age.trim()}\``;
      };

      const embed = new EmbedBuilder()
        .setColor(ALBION_GOLD)
        .setTitle(`⚖️ Your Debts`)
        .setTimestamp();

      if (owing.length > 0) {
        const totalOwing = owing.reduce((s, r) => s + r.amount, 0);
        embed.addFields({
          name: `📤 You owe (${formatSilver(totalOwing)} total)`,
          value: owing.map(formatRow).join('\n').slice(0, 1000),
        });
      }

      if (owed.length > 0) {
        const totalOwed = owed.reduce((s, r) => s + r.amount, 0);
        embed.addFields({
          name: `📥 You are owed (${formatSilver(totalOwed)} total)`,
          value: owed.map(formatRow).join('\n').slice(0, 1000),
        });
      }

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /balance ──────────────────────────────────────────────────────────
    if (cmd === 'balance') {
      const user = interaction.options.getUser('player');
      const displayName = await getDisplayName(interaction.guild, user.id) ?? user.username;

      const owesRow = dbGet(
        `SELECT COALESCE(SUM(amount),0) as total FROM debts WHERE owes_id=? AND guild_id=?`,
        [user.id, guildId]
      );
      const owedRow = dbGet(
        `SELECT COALESCE(SUM(amount),0) as total FROM debts WHERE isowed_id=? AND guild_id=?`,
        [user.id, guildId]
      );

      const totalOwes = owesRow?.total ?? 0;
      const totalOwed = owedRow?.total ?? 0;
      const net = totalOwed - totalOwes;

      const embed = new EmbedBuilder()
        .setColor(net >= 0 ? ALBION_GREEN : ALBION_RED)
        .setTitle(`⚖️ Balance: ${displayName}`)
        .addFields(
          { name: '📤 Owes',  value: formatSilver(totalOwes), inline: true },
          { name: '📥 Owed',  value: formatSilver(totalOwed), inline: true },
          { name: net >= 0 ? '✅ Net credit' : '❌ Net debt', value: formatSilver(Math.abs(net)), inline: true },
        )
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /editdebt ─────────────────────────────────────────────────────────
    if (cmd === 'editdebt') {
      const id        = interaction.options.getInteger('id');
      const rawAmount = interaction.options.getNumber('amount');
      const newNote   = interaction.options.getString('note');

      if (!rawAmount && !newNote) {
        return interaction.editReply('❗ Provide at least a new **amount** or **note** to update.');
      }

      const debt = dbGet(`SELECT * FROM debts WHERE id=? AND guild_id=?`, [id, guildId]);

      if (!debt) {
        return interaction.editReply(`❌ No debt with ID **#${id}** found.`);
      }

      const newAmount = rawAmount ? parseAmount(rawAmount) : null;

      if (newAmount) {
        dbRun(`UPDATE debts SET amount=? WHERE id=?`, [newAmount, id]);
      }
      if (newNote) {
        dbRun(`UPDATE debts SET note=? WHERE id=?`, [newNote, id]);
      }

      const updated = dbGet(`SELECT * FROM debts WHERE id=?`, [id]);
      const owesName   = await getDisplayName(interaction.guild, updated.owes_id)   ?? updated.owes_name;
      const isOwedName = await getDisplayName(interaction.guild, updated.isowed_id) ?? updated.isowed_name;

      const embed = new EmbedBuilder()
        .setColor(ALBION_GOLD)
        .setTitle('✏️ Debt Updated')
        .addFields(
          { name: 'Owes',   value: owesName,                    inline: true },
          { name: 'To',     value: isOwedName,                  inline: true },
          { name: 'Amount', value: formatSilver(updated.amount), inline: true },
        )
        .setFooter({ text: `Debt #${id}${updated.note ? ` · ${updated.note}` : ''}` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── /cleardebt ────────────────────────────────────────────────────────
    if (cmd === 'cleardebt') {
      const id = interaction.options.getInteger('id');
      const debt = dbGet(`SELECT * FROM debts WHERE id=? AND guild_id=?`, [id, guildId]);

      if (!debt) {
        return interaction.editReply(`❌ No debt with ID **#${id}** found.`);
      }

      dbRun(`DELETE FROM debts WHERE id=?`, [id]);

      return interaction.editReply(
        `🗑️ Removed debt #${id}: **${debt.owes_name}** owed **${debt.isowed_name}** **${formatSilver(debt.amount)}**`
      );
    }

    await interaction.editReply(`⚠️ Unknown command.`);

  } catch (err) {
    console.error('Interaction error:', err);
    const reply = { content: '⚠️ An error occurred. Check the bot console.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await initDb();

  const token    = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;

  if (!token || !clientId) {
    console.error('❌  Missing DISCORD_TOKEN or CLIENT_ID in .env');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);
  console.log('🔄  Registering slash commands...');
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log('✅  Slash commands registered.');

  await client.login(token);
}

main().catch(console.error);
