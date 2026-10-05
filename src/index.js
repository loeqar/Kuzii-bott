const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.send('Bot aktif ve çalışıyor!');
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const SETTINGS_FILE = path.join(__dirname, '../guild_settings.json');
const STATS_FILE = path.join(__dirname, '../mod_stats.json');
const TEMPBANS_FILE = path.join(__dirname, '../tempbans.json');
const WARNINGS_FILE = path.join(__dirname, '../warnings.json');

let guildSettings = {};
let modStats = {};
let activeTempBans = [];
let warningsDB = {};

// Atomic (Güvenli) Dosya Yazma Sistemi (JSON bozulmalarını %100 engeller)
function safeWriteFileSync(filePath, data) {
    try {
        const tempPath = filePath + '.tmp';
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 4), 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (e) {
        console.error(`Dosya yazma hatası (${filePath}):`, e);
    }
}

function loadData() {
    try { if (fs.existsSync(SETTINGS_FILE)) guildSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { guildSettings = {}; }
    try { if (fs.existsSync(STATS_FILE)) modStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { modStats = {}; }
    try { if (fs.existsSync(TEMPBANS_FILE)) activeTempBans = JSON.parse(fs.readFileSync(TEMPBANS_FILE, 'utf8')); } catch (e) { activeTempBans = []; }
    try { if (fs.existsSync(WARNINGS_FILE)) warningsDB = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')); } catch (e) { warningsDB = {}; }
}
loadData();

function saveSettings() { safeWriteFileSync(SETTINGS_FILE, guildSettings); }
function saveStats() { safeWriteFileSync(STATS_FILE, modStats); }
function saveTempBans() { safeWriteFileSync(TEMPBANS_FILE, activeTempBans); }
function saveWarnings() { safeWriteFileSync(WARNINGS_FILE, warningsDB); }

app.listen(port, () => {
    console.log(`Web sunucusu ${port} portunda dinlemede.`);
});

// Bellek sızıntılarını önlemek için Map yerine süresi geçenleri ve boyutu sınırlayan yapı
const userMessageTracker = new Map();

function cleanTracker() {
    const now = Date.now();
    for (const [key, timestamps] of userMessageTracker.entries()) {
        const filtered = timestamps.filter(t => now - t < 60000);
        if (filtered.length === 0) {
            userMessageTracker.delete(key);
        } else {
            userMessageTracker.set(key, filtered);
        }
    }
    // Aşırı büyük Map şişmelerini engellemek için güvenlik sınırı
    if (userMessageTracker.size > 5000) {
        const firstKeys = Array.from(userMessageTracker.keys()).slice(0, 1000);
        firstKeys.forEach(k => userMessageTracker.delete(k));
    }
}
setInterval(cleanTracker, 5 * 60 * 1000);

function addStat(guildId, userId, type) {
    if (!modStats[guildId]) modStats[guildId] = {};
    if (!modStats[guildId][userId]) modStats[guildId][userId] = { ban: 0, tempban: 0, kick: 0, timeout: 0, warn: 0 };
    if (modStats[guildId][userId][type] !== undefined) {
        modStats[guildId][userId][type]++;
        saveStats();
    }
}

function convertMs(duration) {
    if (!duration) return null;
    duration = duration.toLowerCase().trim();
    const match = duration.match(/^(\d+)([a-zğüşıöç]+)$/);
    if (!match) return null;
    
    const value = parseInt(match[1], 10);
    const unit = match[2];

    if (unit === 'sn' || unit === 's') return value * 1000;
    if (unit === 'dk' || unit === 'm') return value * 60 * 1000;
    if (unit === 'sa' || unit === 'h' || unit === 'sà') return value * 60 * 60 * 1000;
    if (unit === 'g' || unit === 'd') return value * 24 * 60 * 60 * 1000;
    return null;
}

function logGonder(guild, settings, embed) {
    const kanalId = settings?.LOG_CHANNEL_ID;
    if (!kanalId || !guild) return;
    const hedefKanal = guild.channels.cache.get(kanalId);
    if (hedefKanal) {
        hedefKanal.send({ embeds: [embed] }).catch(() => {});
    }
}

async function checkTempBans() {
    const now = Date.now();
    const remainingBans = [];

    for (const item of activeTempBans) {
        if (now >= item.unbanTime) {
            try {
                const guild = await client.guilds.fetch(item.guildId);
                if (guild) {
                    await guild.members.unban(item.userId, 'Tempban süresi doldu.');
                }
            } catch (err) {}
        } else {
            remainingBans.push(item);
        }
    }

    if (activeTempBans.length !== remainingBans.length) {
        activeTempBans = remainingBans;
        saveTempBans();
    }
}

client.once('ready', async () => {
    console.log(`Bot Aktif: ${client.user.tag}`);

    checkTempBans();
    setInterval(checkTempBans, 30 * 1000);

    const commands = [
        new SlashCommandBuilder()
            .setName('kanal-ayarla')
            .setDescription('Tüm moderasyon loglarının gönderileceği ana log kanalını belirler.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
            .addChannelOption(option =>
                option.setName('kanal').setDescription('Logların gönderileceği kanal').setRequired(true)),

        new SlashCommandBuilder()
            .setName('yasakla')
            .setDescription('Kullanıcıyı sunucudan kalıcı veya süreli olarak yasaklar.')
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
            .addUserOption(option => 
                option.setName('kullanici').setDescription('Yasaklanacak kullanıcı').setRequired(true))
            .addStringOption(option => 
                option.setName('sebep').setDescription('Yasaklama sebebi').setRequired(true))
            .addStringOption(option => 
                option.setName('sure').setDescription('Süreli ban için süre (Örn: 1sa, 3g)').setRequired(false)),

        new SlashCommandBuilder()
            .setName('at')
            .setDescription('Kullanıcıyı sunucudan atar (Kick).')
            .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
            .addUserOption(option => 
                option.setName('kullanici').setDescription('Atılacak kullanıcı').setRequired(true))
            .addStringOption(option => 
                option.setName('sebep').setDescription('Atılma sebebi').setRequired(true)),

        new SlashCommandBuilder()
            .setName('timeout')
            .setDescription('Kullanıcıyı süreli olarak susturur.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(option => 
                option.setName('kullanici').setDescription('Susturulacak kullanıcı').setRequired(true))
            .addStringOption(option => 
                option.setName('sure').setDescription('Süre (Örn: 10dk, 1sa, 1g)').setRequired(true))
            .addStringOption(option => 
                option.setName('sebep').setDescription('Susturma sebebi').setRequired(true)),

        new SlashCommandBuilder()
            .setName('uyar')
            .setDescription('Sunucu üyesine özel puanlı resmi uyarı verir.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(option => 
                option.setName('kullanici').setDescription('Uyarılacak kullanıcı').setRequired(true))
            .addIntegerOption(option => 
                option.setName('puan').setDescription('Verilecek uyarı puanı miktarı').setRequired(true))
            .addStringOption(option => 
                option.setName('sebep').setDescription('Uyarı sebebi').setRequired(true)),

        new SlashCommandBuilder()
            .setName('uyari-sil')
            .setDescription('Kullanıcının toplam puanından belirtilen miktarda uyarı puanı siler.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(option => 
                option.setName('kullanici').setDescription('Uyarı puanı silinecek kullanıcı').setRequired(true))
            .addIntegerOption(option => 
                option.setName('puan').setDescription('Silinecek uyarı puanı miktarı').setRequired(true))
            .addStringOption(option => 
                option.setName('sebep').setDescription('Silme sebebi').setRequired(true)),

        new SlashCommandBuilder()
            .setName('uyarilari-goster')
            .setDescription('Bir kullanıcının aktif uyarı puanını ve geçmişini gösterir.')
            .addUserOption(option => 
                option.setName('kullanici').setDescription('Uyarılarına bakılacak kullanıcı').setRequired(true)),

        new SlashCommandBuilder()
            .setName('unban')
            .setDescription('Sunucudaki bir kullanıcının banını kaldırır ve uyarılarını sıfırlar.')
            .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
            .addStringOption(option => 
                option.setName('kullanici_id').setDescription('Banı kaldırılacak kullanıcının IDsi').setRequired(true))
            .addStringOption(option => 
                option.setName('sebep').setDescription('Banın kaldırılma sebebi').setRequired(true)),

        new SlashCommandBuilder()
            .setName('yetkili-istatistik')
            .setDescription('Yetkilinin gerçekleştirdiği toplam moderasyon işlemlerini gösterir.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
            .addUserOption(option => option.setName('yetkili').setDescription('İstatistiklerine bakılacak yetkili').setRequired(false)),

        new SlashCommandBuilder()
            .setName('korumalar')
            .setDescription('Sunucu koruma sistemlerini detaylı olarak açar veya kapatır.')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addStringOption(option =>
                option.setName('koruma')
                    .setDescription('Yönetmek istediğiniz koruma türü')
                    .setRequired(true)
                    .addChoices(
                        { name: 'Küfür Koruması (ANTI_BADWORD)', value: 'ANTI_BADWORD' },
                        { name: 'Reklam Koruması (ANTI_AD)', value: 'ANTI_AD' },
                        { name: 'Link Koruması (ANTI_LINK)', value: 'ANTI_LINK' },
                        { name: 'Caps Koruması (ANTI_CAPS)', value: 'ANTI_CAPS' },
                        { name: 'Emoji Koruması (ANTI_EMOJI)', value: 'ANTI_EMOJI' },
                        { name: 'Etiket (Mention) Koruması (ANTI_MENTION)', value: 'ANTI_MENTION' },
                        { name: 'Uzun Metin Koruması (ANTI_LONGTEXT)', value: 'ANTI_LONGTEXT' },
                        { name: 'Fotoğraf Spam Koruması (ANTI_PHOTO)', value: 'ANTI_PHOTO' },
                        { name: 'Flood Koruması (ANTI_FLOOD)', value: 'ANTI_FLOOD' }
                    ))
            .addBooleanOption(option =>
                option.setName('durum')
                    .setDescription('Aç (True) veya Kapat (False)')
                    .setRequired(true)),

        new SlashCommandBuilder()
            .setName('sunucu-bilgi')
            .setDescription('Sunucu hakkında detaylı teknik bilgiler sunar.')
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        console.log('Slash komutları başarıyla güncellendi!');
    } catch (error) {
        console.error(error);
    }
});

// İleri Düzey Leet-Speak ve Karakter Normalizasyonlu Küfür Filtresi
function hasBadWordMatch(text, badWords) {
    const normalized = text.toLowerCase()
        .replace(/1/g, 'i')
        .replace(/3/g, 'e')
        .replace(/0/g, 'o')
        .replace(/4/g, 'a')
        .replace(/5/g, 's')
        .replace(/7/g, 't')
        .replace(/@/g, 'a')
        .replace(/[\s\u200B-\u200D\uFEFF_\-\.]/g, '');
    
    return badWords.some(bw => normalized.includes(bw));
}

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    if (message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

    const guildId = message.guild.id;
    const settings = guildSettings[guildId] || {};
    const content = message.content;

    const isProtected = settings.ANTI_AD || settings.ANTI_BADWORD || settings.ANTI_LINK || settings.ANTI_CAPS || settings.ANTI_EMOJI || settings.ANTI_MENTION || settings.ANTI_LONGTEXT || settings.ANTI_PHOTO || settings.ANTI_FLOOD;

    if (!isProtected) return;

    let ihlalVar = false;
    let ihlalSebebi = '';

    const kufurler = ['aq', 'orospu', 'amk', 'sik', 'piç', 'amq', 'göt', 'kahpe', 'yarak', 'sikik'];
    if (settings.ANTI_BADWORD && hasBadWordMatch(content, kufurler)) {
        ihlalVar = true;
        ihlalSebebi = 'küfür içeren mesaj engellendi!';
    }

    const reklamKontrol = /(discord\.(gg|invite|me|io|com\/invite)|t\.me|whatsapp\.com|invite\.gg)/i;
    const linkKontrol = /(https?:\/\/|www\.)/i;

    if (settings.ANTI_AD && reklamKontrol.test(content)) {
        ihlalVar = true;
        ihlalSebebi = 'izinsiz reklam engellendi!';
    } else if (settings.ANTI_LINK && linkKontrol.test(content)) {
        ihlalVar = true;
        ihlalSebebi = 'link paylaşımı yasaktır!';
    }

    if (settings.ANTI_CAPS && content.length > 8) {
        const uppercaseCount = content.replace(/[^A-ZİĞÜŞÖÇ]/g, '').length;
        if ((uppercaseCount / content.length) >= 0.7) {
            ihlalVar = true;
            ihlalSebebi = 'aşırı büyük harf kullanımı engellendi!';
        }
    }

    if (settings.ANTI_EMOJI) {
        const emojiCount = (content.match(/<a?:.+?:\d+>|[\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{2600}-\u{26FF}]/gu) || []).length;
        if (emojiCount > 6) {
            ihlalVar = true;
            ihlalSebebi = 'aşırı emoji kullanımı engellendi!';
        }
    }

    if (settings.ANTI_MENTION && message.mentions.users.size > 3) {
        ihlalVar = true;
        ihlalSebebi = 'aşırı etiketleme (mention) engellendi!';
    }

    if (settings.ANTI_LONGTEXT && content.split('\n').length > 6) {
        ihlalVar = true;
        ihlalSebebi = 'çok uzun metin / satır sınırı aşıldı!';
    }

    if (settings.ANTI_PHOTO && message.attachments.size > 0) {
        const now = Date.now();
        if (!userMessageTracker.has(message.author.id)) userMessageTracker.set(message.author.id, []);
        let userMsgs = userMessageTracker.get(message.author.id);
        userMsgs = userMsgs.filter(t => now - t < 60000); 
        userMsgs.push(now);
        userMessageTracker.set(message.author.id, userMsgs);

        if (userMsgs.length > 5) {
            ihlalVar = true;
            ihlalSebebi = 'fotoğraf spam sınırı aşıldı!';
        }
    }

    if (settings.ANTI_FLOOD) {
        const now = Date.now();
        const floodKey = message.author.id + '_flood';
        if (!userMessageTracker.has(floodKey)) userMessageTracker.set(floodKey, []);
        let userFloods = userMessageTracker.get(floodKey);
        userFloods = userFloods.filter(t => now - t < 5000); 
        userFloods.push(now);
        userMessageTracker.set(floodKey, userFloods);

        if (userFloods.length > 5) {
            ihlalVar = true;
            ihlalSebebi = 'hızlı mesaj (flood) gönderimi engellendi!';
        }
    }

    if (ihlalVar) {
        try {
            await message.delete();
            const uyariMesaji = await message.channel.send(`⚠️ ${message.author},${ihlalSebebi}`);
            setTimeout(() => uyariMesaji.delete().catch(() => {}), 4000);
        } catch (err) {}
    }
});

function safeTrim(text, limit = 1024) {
    if (!text) return '*(İçerik yok)*';
    return text.length > limit ? text.substring(0, limit - 3) + '...' : text;
}

client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
        if (!newMessage.guild || newMessage.author?.bot) return;
        const settings = guildSettings[newMessage.guild.id] || {};
        const embed = new EmbedBuilder()
            .setColor(0xF39C12)
            .setTitle('✏ Mesaj Güncellendi')
            .addFields(
                { name: '👤 Kullanıcı', value: `${newMessage.author}`, inline: true },
                { name: '💬 Kanal', value: `${newMessage.channel}`, inline: true },
                { name: 'Eski İçerik', value: safeTrim(oldMessage.content), inline: false },
                { name: 'Yeni İçerik', value: safeTrim(newMessage.content), inline: false }
            )
            .setTimestamp();
        logGonder(newMessage.guild, settings, embed);
    } catch (err) {}
});

client.on('messageDelete', async message => {
    try {
        if (!message.guild || message.author?.bot) return;
        const settings = guildSettings[message.guild.id] || {};
        const embed = new EmbedBuilder()
            .setColor(0xE74C3C)
            .setTitle('🗑️ Mesaj Silindi')
            .addFields(
                { name: '👤 Kullanıcı', value: `${message.author || 'Bilinmiyor'}`, inline: true },
                { name: '💬 Kanal', value: `${message.channel}`, inline: true },
                { name: 'İçerik', value: safeTrim(message.content || '*(Medya veya Embed)*') }
            )
            .setTimestamp();
        logGonder(message.guild, settings, embed);
    } catch (err) {}
});

client.on('guildMemberAdd', async member => {
    const settings = guildSettings[member.guild.id] || {};
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle('📥 Üye Katıldı')
        .setDescription(`**${member}** sunucuya katıldı.`)
        .setTimestamp();
    logGonder(member.guild, settings, embed);
});

client.on('guildMemberRemove', async member => {
    const settings = guildSettings[member.guild.id] || {};
    const embed = new EmbedBuilder()
        .setColor(0xE67E22)
        .setTitle('📤 Üye Ayrıldı')
        .setDescription(`**${member.user.tag}** sunucudan ayrıldı.`)
        .setTimestamp();
    logGonder(member.guild, settings, embed);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // Discord API 3 saniye kuralı çakışmalarını önlemek için güvenli defer
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ ephemeral: true }).catch(() => {});
    }

    const guildId = interaction.guild.id;
    const guildName = interaction.guild.name;

    if (!guildSettings[guildId]) {
        guildSettings[guildId] = {};
    }

    const settings = guildSettings[guildId];

    if (interaction.commandName === 'kanal-ayarla') {
        const channel = interaction.options.getChannel('kanal');
        guildSettings[guildId].LOG_CHANNEL_ID = channel.id;
        saveSettings();
        return interaction.editReply({ content: `✅ Başarılı! Yönetim log kanalı ${channel} olarak ayarlandı.` });
    }

    if (interaction.commandName === 'yasakla') {
        const target = interaction.options.getUser('kullanici');
        const reason = interaction.options.getString('sebep');
        const timeStr = interaction.options.getString('sure');
        const cezaId = Math.floor(100 + Math.random() * 900);

        const isTemp = timeStr !== null && timeStr !== undefined;
        let banMs = null;

        if (isTemp) {
            banMs = convertMs(timeStr);
            if (!banMs || banMs <= 0) {
                return interaction.editReply({ content: '⚠️ Geçerli bir süre girmelisiniz (Örn: 1sa, 3g)!' });
            }
        }

        try {
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                return interaction.editReply({ content: '⚠️ İşlem başarısız! Kullanıcı sunucuda bulunmuyor.' });
            }

            const fullReason = isTemp ? `${interaction.user.tag}:${reason} (${timeStr})` : `${interaction.user.tag}:${reason}`;
            
            const dmEmbed = new EmbedBuilder()
                .setColor(isTemp ? 0xE67E22 : 0xFF0000)
                .setTitle(isTemp ? `⏳ ${guildName} | Süreli Olarak Yasaklandınız` : `🚨 ${guildName} | Kalıcı Olarak Yasaklandınız`)
                .setDescription(isTemp ? `**${target}**, **${guildName}** sunucusundan **${timeStr}** süreyle uzaklaştırıldınız.` : `**${target}**, **${guildName}** sunucusundan kalıcı olarak uzaklaştırıldınız.`)
                .addFields(
                    { name: '🛡 İşlem Türü', value: isTemp ? '`TEMPBAN`' : '`BAN`', inline: true },
                    { name: '🆔 İşlem ID', value: `\`#${cezaId}\``, inline: true },
                    ...(isTemp ? [{ name: '⏳ Süre', value: timeStr, inline: true }] : []),
                    { name: '⚠️ Sebep', value: reason, inline: false }
                )
                .setTimestamp();

            try { await target.send({ embeds: [dmEmbed] }); } catch (err) {}
            await member.ban({ reason: fullReason });
            
            addStat(guildId, interaction.user.id, isTemp ? 'tempban' : 'ban');

            const logEmbed = new EmbedBuilder()
                .setColor(isTemp ? 0xE67E22 : 0xFF0000)
                .setTitle(isTemp ? `⏳ ${guildName} | Süreli Ban Bildirimi` : `🚨 ${guildName} | Ceza Sistemi`)
                .addFields(
                    { name: '🛡 İşlem Türü', value: isTemp ? '`TEMPBAN`' : '`BAN`', inline: true },
                    { name: '🆔 Ceza ID', value: `\`#${cezaId}\``, inline: true },
                    { name: '👤 Hedef', value: `${target} (${target.id})`, inline: false },
                    { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
                    ...(isTemp ? [{ name: '⏳ Süre', value: timeStr, inline: true }] : []),
                    { name: '⚠ Sebep', value: reason, inline: false }
                )
                .setTimestamp();

            logGonder(interaction.guild, settings, logEmbed);

            if (isTemp) {
                const unbanTime = Date.now() + banMs;
                activeTempBans.push({ guildId: interaction.guild.id, userId: target.id, unbanTime });
                saveTempBans();
            }
        } catch (e) {
            return interaction.editReply({ content: '⚠️ İşlem başarısız! Botun yetkisi yetersiz veya rolü hedef kişiden altta.' });
        }

        return interaction.editReply({ content: `✅ İşlem başarılı! Ceza ID: #${cezaId}` });
    }

    if (interaction.commandName === 'at') {
        const target = interaction.options.getUser('kullanici');
        const reason = interaction.options.getString('sebep');
        const cezaId = Math.floor(100 + Math.random() * 900);

        try {
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                return interaction.editReply({ content: '⚠️ İşlem başarısız! Kullanıcı sunucuda bulunmuyor.' });
            }

            const dmEmbed = new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle(`⚡ ${guildName} | Sunucudan Uzaklaştırıldınız`)
                .setDescription(`**${guildName}** sunucusundan atıldınız (Kick).`)
                .addFields(
                    { name: '🛡️ İşlem Türü', value: '`KICK`', inline: true },
                    { name: '🆔 İşlem ID', value: `\`#${cezaId}\``, inline: true },
                    { name: '⚠ Sebep', value: reason, inline: false }
                )
                .setTimestamp();

            try { await target.send({ embeds: [dmEmbed] }); } catch (err) {}
            await member.kick(`${interaction.user.tag}:${reason}`);
            addStat(guildId, interaction.user.id, 'kick');

            const logEmbed = new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle(`⚡ ${guildName} | Kick Bildirimi`)
                .addFields(
                    { name: '🛡 İşlem Türü', value: '`KICK`', inline: true },
                    { name: '🆔 Ceza ID', value: `\`#${cezaId}\``, inline: true },
                    { name: '👤 Hedef', value: `${target} (${target.id})`, inline: false },
                    { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
                    { name: '⚠️ Sebep', value: reason, inline: false }
                )
                .setTimestamp();

            logGonder(interaction.guild, settings, logEmbed);
        } catch (e) {
            return interaction.editReply({ content: '⚠️ İşlem başarısız! Botun yetkisi yetersiz.' });
        }

        return interaction.editReply({ content: `✅ İşlem başarılı! Ceza ID: #${cezaId}` });
    }

    if (interaction.commandName === 'timeout') {
        const target = interaction.options.getUser('kullanici');
        const timeStr = interaction.options.getString('sure');
        const reason = interaction.options.getString('sebep');
        const cezaId = Math.floor(100 + Math.random() * 900);

        const timeoutMs = convertMs(timeStr);
        if (!timeoutMs || timeoutMs <= 0) {
            return interaction.editReply({ content: '⚠️ Geçerli bir süre girmelisiniz (Örn: 10dk, 1sa, 1g)!' });
        }

        try {
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (!member) {
                return interaction.editReply({ content: '⚠️ İşlem başarısız! Kullanıcı sunucuda bulunmuyor.' });
            }

            const dmEmbed = new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle(`🔇 ${guildName} | Susturuldunuz`)
                .addFields(
                    { name: '🛡 İşlem Türü', value: '`TIMEOUT`', inline: true },
                    { name: '⏳ Süre', value: timeStr, inline: true },
                    { name: '⚠️ Sebep', value: reason, inline: false }
                )
                .setTimestamp();

            try { await target.send({ embeds: [dmEmbed] }); } catch (err) {}
            await member.timeout(timeoutMs, `${interaction.user.tag}:${reason}`);
            addStat(guildId, interaction.user.id, 'timeout');

            const logEmbed = new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle(`🔇 ${guildName} | Susturma Bildirimi`)
                .addFields(
                    { name: '🛡 İşlem Türü', value: '`TIMEOUT`', inline: true },
                    { name: '🆔 Ceza ID', value: `\`#${cezaId}\``, inline: true },
                    { name: '👤 Hedef', value: `${target} (${target.id})`, inline: false },
                    { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
                    { name: '⏳ Süre', value: timeStr, inline: true },
                    { name: '⚠️ Sebep', value: reason, inline: false }
                )
                .setTimestamp();

            logGonder(interaction.guild, settings, logEmbed);
        } catch (e) {
            return interaction.editReply({ content: '⚠️ İşlem başarısız! Bot yetkisi yetersiz.' });
        }

        return interaction.editReply({ content: `✅ İşlem başarılı! Ceza ID: #${cezaId}` });
    }

    if (interaction.commandName === 'uyar') {
        const target = interaction.options.getUser('kullanici');
        const puan = interaction.options.getInteger('puan');
        const reason = interaction.options.getString('sebep');
        const uyariId = Math.floor(100 + Math.random() * 900);

        if (!warningsDB[target.id]) warningsDB[target.id] = [];
        warningsDB[target.id].push({ id: uyariId, points: puan, reason, moderator: interaction.user.tag, date: new Date().toLocaleDateString('tr-TR') });
        saveWarnings();

        const totalPoints = warningsDB[target.id].reduce((sum, w) => sum + w.points, 0);

        const logEmbed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(`⚠️ ${guildName} | Uyarı Sistemi`)
            .addFields(
                { name: '🛡️️ İşlem Türü', value: '`WARN`', inline: true },
                { name: '🆔 Uyarı ID', value: `\`#${uyariId}\``, inline: true },
                { name: '📈 Puan', value: `\`+${puan}\``, inline: true },
                { name: '📊 Toplam', value: `\`${totalPoints}\``, inline: true },
                { name: '👤 Hedef', value: `${target} (${target.id})`, inline: false },
                { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
                { name: '⚠️ Sebep', value: reason, inline: false }
            )
            .setTimestamp();

        addStat(guildId, interaction.user.id, 'warn');
        logGonder(interaction.guild, settings, logEmbed);

        return interaction.editReply({ content: `✅ Uyarı verildi! Toplam Puan: ${totalPoints}` });
    }

    if (interaction.commandName === 'uyari-sil') {
        const target = interaction.options.getUser('kullanici');
        const silinecekPuan = interaction.options.getInteger('puan');
        const reason = interaction.options.getString('sebep');

        if (!warningsDB[target.id] || warningsDB[target.id].length === 0) {
            return interaction.editReply({ content: '⚠️ Bu kullanıcının uyarı kaydı yok.' });
        }

        const currentTotal = warningsDB[target.id].reduce((sum, w) => sum + w.points, 0);
        if (silinecekPuan > currentTotal) {
            return interaction.editReply({ content: `⚠ Kullanıcının toplam puanı zaten \`${currentTotal}\`.` });
        }

        const dususId = Math.floor(100 + Math.random() * 900);
        warningsDB[target.id].push({ id: dususId, points: -silinecekPuan, reason: `Düşüm: ${reason}`, moderator: interaction.user.tag, date: new Date().toLocaleDateString('tr-TR') });
        saveWarnings();

        const newTotal = warningsDB[target.id].reduce((sum, w) => sum + w.points, 0);

        const logEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`🧹 ${guildName} | Uyarı Puanı Düşme`)
            .addFields(
                { name: '👤 Hedef', value: `${target} (${target.id})`, inline: false },
                { name: '📉 Silinen', value: `\`-${silinecekPuan}\``, inline: true },
                { name: '📊 Kalan', value: `\`${newTotal}\``, inline: true },
                { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
                { name: '⚠️ Sebep', value: reason, inline: false }
            )
            .setTimestamp();

        logGonder(interaction.guild, settings, logEmbed);
        return interaction.editReply({ content: `✅ Puan silindi. Kalan Toplam: ${newTotal}` });
    }

    if (interaction.commandName === 'uyarilari-goster') {
        const target = interaction.options.getUser('kullanici');
        const userWarnings = warningsDB[target.id] || [];
        const totalPoints = userWarnings.reduce((sum, w) => sum + w.points, 0);

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`📋 ${guildName} | Uyarı Geçmişi`)
            .addFields({ name: '📊 Toplam Puan', value: `\`${totalPoints}\``, inline: false });

        if (userWarnings.length > 0) {
            const listText = userWarnings.slice(-5).map(w => `• **#${w.id}** | Puan: \`${w.points}\` | ${w.date}\n  Sebep:${w.reason}`).join('\n\n');
            embed.addFields({ name: 'Son İşlemler', value: safeTrim(listText) });
        }

        return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'unban') {
        const userId = interaction.options.getString('kullanici_id');
        const reason = interaction.options.getString('sebep');

        try {
            await interaction.guild.members.unban(userId, reason);
        } catch (e) {
            return interaction.editReply({ content: '⚠️ Kullanıcı banlı değil veya yetkim yok!' });
        }

        if (warningsDB[userId]) {
            delete warningsDB[userId];
            saveWarnings();
        }

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`🔓 ${guildName} | Ban Affı`)
            .addFields(
                { name: '👤 Kullanıcı ID', value: `\`${userId}\``, inline: true },
                { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
                { name: '⚠️ Sebep', value: reason, inline: false }
            )
            .setTimestamp();

        logGonder(interaction.guild, settings, embed);
        return interaction.editReply({ content: `✅ Ban kaldırıldı.` });
    }

    if (interaction.commandName === 'yetkili-istatistik') {
        const targetMod = interaction.options.getUser('yetkili') || interaction.user;
        const stats = (modStats[guildId] && modStats[guildId][targetMod.id]) || { ban: 0, tempban: 0, kick: 0, timeout: 0, warn: 0 };
        const toplam = stats.ban + stats.tempban + stats.kick + stats.timeout + stats.warn;

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle(`📊 ${guildName} | Yetkili İstatistikleri`)
            .addFields(
                { name: 'Ban', value: `\`${stats.ban}\``, inline: true },
                { name: 'Tempban', value: `\`${stats.tempban}\``, inline: true },
                { name: 'Kick', value: `\`${stats.kick}\``, inline: true },
                { name: 'Timeout', value: `\`${stats.timeout}\``, inline: true },
                { name: 'Uyarı', value: `\`${stats.warn}\``, inline: true },
                { name: 'Toplam', value: `\`${toplam}\``, inline: false }
            )
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }

    if (interaction.commandName === 'korumalar') {
        const korumaTuru = interaction.options.getString('koruma');
        const durum = interaction.options.getBoolean('durum');

        if (!guildSettings[guildId]) guildSettings[guildId] = {};
        guildSettings[guildId][korumaTuru] = durum;
        saveSettings();

        return interaction.editReply({ content: `✅ **${korumaTuru}** koruması başarıyla **${durum ? 'AÇILDI' : 'KAPATILDI'}**!` });
    }

    if (interaction.commandName === 'sunucu-bilgi') {
        const { guild } = interaction;
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`🏢 ${guild.name}`)
            .addFields(
                { name: 'Sahip', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Üye Sayısı', value: `\`${guild.memberCount}\``, inline: true }
            )
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    }
});

client.login(process.env.DISCORD_TOKEN);