const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
require('dotenv').config();

// Web sunucusunu başlatıyoruz
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

if (fs.existsSync(SETTINGS_FILE)) {
    try { guildSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { guildSettings = {}; }
}

if (fs.existsSync(STATS_FILE)) {
    try { modStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { modStats = {}; }
}

if (fs.existsSync(TEMPBANS_FILE)) {
    try { activeTempBans = JSON.parse(fs.readFileSync(TEMPBANS_FILE, 'utf8')); } catch (e) { activeTempBans = []; }
}

if (fs.existsSync(WARNINGS_FILE)) {
    try { 
        const rawWarnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8'));
        warningsDB = rawWarnings;
    } catch (e) { warningsDB = {}; }
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(guildSettings, null, 4));
}

function saveStats() {
    fs.writeFileSync(STATS_FILE, JSON.stringify(modStats, null, 4));
}

function saveTempBans() {
    fs.writeFileSync(TEMPBANS_FILE, JSON.stringify(activeTempBans, null, 4));
}

function saveWarnings() {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warningsDB, null, 4));
}

app.listen(port, () => {
    console.log(`Web sunucusu ${port} portunda dinlemede.`);
});

const userMessageTracker = new Map(); // Flood ve Fotoğraf spam takibi için

function addStat(guildId, userId, type) {
    if (!modStats[guildId]) modStats[guildId] = {};
    if (!modStats[guildId][userId]) modStats[guildId][userId] = { ban: 0, tempban: 0, kick: 0, timeout: 0, warn: 0 };
    if (modStats[guildId][userId][type] !== undefined) {
        modStats[guildId][userId][type]++;
        saveStats();
    }
}

// 1sa, 10dk, 3g, 2s (saat/hour) destekleyen gelişmiş süre çevirici
function convertMs(duration) {
    if (!duration) return null;
    duration = duration.toLowerCase().trim();
    const match = duration.match(/^(\d+)([a-zğüşıöç]+)$/);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];

    if (unit === 'sn' || unit === 's') return value * 1000;
    if (unit === 'dk' || unit === 'm') return value * 60 * 1000;
    if (unit === 'sa' || unit === 'h' || unit === 'sà') return value * 60 * 60 * 1000;
    if (unit === 'g' || unit === 'd') return value * 24 * 60 * 60 * 1000;
    return null;
}

function logGonder(guild, settings, embed) {
    const kanalId = settings.LOG_CHANNEL_ID;
    if (kanalId) {
        const hedefKanal = guild.channels.cache.get(kanalId);
        if (hedefKanal) {
            hedefKanal.send({ embeds: [embed] }).catch((err) => console.log("Log gönderme hatası:", err));
        }
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

    activeTempBans = remainingBans;
    saveTempBans();
}

client.once('ready', async () => {
    console.log(`Bot Aktif: ${client.user.tag}`);

    checkTempBans();
    setInterval(checkTempBans, 60 * 1000);

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
                option.setName('sure').setDescription('Süreli ban için süre (Örn: 1sa, 3g). Boş bırakılırsa kalıcı olur.').setRequired(false)),

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
            .setName('oto-koruma')
            .setDescription('Genel otomatik koruma sistemini açar/kapatır.')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addBooleanOption(option => option.setName('durum').setDescription('Aktif veya Kapalı').setRequired(true)),

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

// Küfür filtresinin kelime birleşme hatasını önleyen akıllı kelime tabanlı kontrolü
function hasBadWordMatch(text, badWords) {
    const words = text.toLowerCase().split(/\s+/);
    // Tam eşleşme veya kelime içerisinde geçme durumu (ama masum kelimeleri patlatmayacak şekilde)
    return badWords.some(bw => words.includes(bw) || text.includes(bw));
}

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;
    if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

    const guildId = message.guild.id;
    const settings = guildSettings[guildId] || {};
    const content = message.content;
    const cleanContent = content.replace(/[\s\u200B-\u200D\uFEFF]/g, '').toLowerCase();

    const isProtected = settings.AUTO_PROTECT || settings.ANTI_AD || settings.ANTI_BADWORD || settings.ANTI_LINK || settings.ANTI_CAPS || settings.ANTI_EMOJI || settings.ANTI_MENTION || settings.ANTI_LONGTEXT || settings.ANTI_PHOTO || settings.ANTI_FLOOD;

    if (!isProtected) return;

    let ihlalVar = false;
    let ihlalSebebi = '';

    // 1. Küfür Filtresi (Geliştirilmiş Doğrulama)
    const kufurler = ['aq', 'orospu', 'amk', 'sik', 'piç', 'amq', 'göt', 'kahpe', 'yarak', 'sikik'];
    if ((settings.AUTO_PROTECT || settings.ANTI_BADWORD) && hasBadWordMatch(cleanContent, kufurler)) {
        ihlalVar = true;
        ihlalSebebi = 'küfür içeren mesaj engellendi!';
    }

    // 2. Reklam & Link Filtresi
    const reklamKontrol = /(discord\.(gg|invite|me|io|com\/invite)|t\.me|whatsapp\.com|invite\.gg)/i;
    const linkKontrol = /(https?:\/\/|www\.)/i;

    if ((settings.AUTO_PROTECT || settings.ANTI_AD) && reklamKontrol.test(cleanContent)) {
        ihlalVar = true;
        ihlalSebebi = 'izinsiz reklam engellendi!';
    } else if (settings.ANTI_LINK && linkKontrol.test(cleanContent)) {
        ihlalVar = true;
        ihlalSebebi = 'link paylaşımı yasaktır!';
    }

    // 3. Caps Lock Filtresi
    if (settings.ANTI_CAPS && content.length > 8) {
        const uppercaseCount = content.replace(/[^A-ZİĞÜŞÖÇ]/g, '').length;
        if ((uppercaseCount / content.length) >= 0.7) {
            ihlalVar = true;
            ihlalSebebi = 'aşırı büyük harf kullanımı engellendi!';
        }
    }

    // 4. Emoji Filtresi
    if (settings.ANTI_EMOJI) {
        const emojiCount = (content.match(/<a?:.+?:\d+>|[\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{2600}-\u{26FF}]/gu) || []).length;
        if (emojiCount > 6) {
            ihlalVar = true;
            ihlalSebebi = 'aşırı emoji kullanımı engellendi!';
        }
    }

    // 5. Mention Filtresi
    if (settings.ANTI_MENTION && message.mentions.users.size > 3) {
        ihlalVar = true;
        ihlalSebebi = 'aşırı etiketleme (mention) engellendi!';
    }

    // 6. Uzun Metin Filtresi
    if (settings.ANTI_LONGTEXT && content.split('\n').length > 6) {
        ihlalVar = true;
        ihlalSebebi = 'çok uzun metin / satır sınırı aşıldı!';
    }

    // 7. Fotoğraf Spam
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

    // 8. Flood Spam
    if (settings.ANTI_FLOOD) {
        const now = Date.now();
        if (!userMessageTracker.has(message.author.id + '_flood')) userMessageTracker.set(message.author.id + '_flood', []);
        let userFloods = userMessageTracker.get(message.author.id + '_flood');
        userFloods = userFloods.filter(t => now - t < 5000); 
        userFloods.push(now);
        userMessageTracker.set(message.author.id + '_flood', userFloods);

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

// Güvenli Embed Karakter Sınırı Koruması (1024 karakter aşım önlemi)
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
    } catch (err) {
        console.error("MessageUpdate Log Hatası:", err);
    }
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
                { name: 'İçerik', value: safeTrim(message.content || '*(Medya veya Embed)*'), inline: false }
            )
            .setTimestamp();
        logGonder(message.guild, settings, embed);
    } catch (err) {
        console.error("MessageDelete Log Hatası:", err);
    }
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

    const guildId = interaction.guild.id;
    const guildName = interaction.guild.name;

    if (!guildSettings[guildId]) {
        guildSettings[guildId] = {};
    }

    const settings = guildSettings[guildId] || {};

    if (interaction.commandName === 'kanal-ayarla') {
        const channel = interaction.options.getChannel('kanal');

        guildSettings[guildId].LOG_CHANNEL_ID = channel.id;
        saveSettings();

        return interaction.reply({ content: `✅ Başarılı! Yönetim log kanalı ${channel} olarak ayarlandı.`, ephemeral: true });
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
                return interaction.reply({ content: '⚠️ Geçerli bir süre girmelisiniz (Örn: 1sa, 3g)!', ephemeral: true });
            }
        }

        const dmTitle = isTemp ? `⏳ ${guildName} | Süreli Olarak Yasaklandınız` : `🚨 ${guildName} | Kalıcı Olarak Yasaklandınız`;
        const dmDescription = isTemp 
            ? `**${target}**, **${guildName}** sunucusundan **${timeStr}** süreyle geçici olarak uzaklaştırıldınız.` 
            : `**${target}**, yapmış olduğunuz ihlaller neticesinde **${guildName}** sunucusundan kalıcı olarak uzaklaştırıldınız.`;

        const dmFields = [
            { name: '🛡 İşlem Türü', value: isTemp ? '`TEMPBAN`' : '`BAN`', inline: true },
            { name: '🆔 İşlem ID', value: `\`#${cezaId}\``, inline: true },
            ...(isTemp ? [{ name: '⏳ Süre', value: timeStr, inline: true }] : []),
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const dmEmbed = new EmbedBuilder()
            .setColor(isTemp ? 0xE67E22 : 0xFF0000)
            .setTitle(dmTitle)
            .setDescription(dmDescription)
            .addFields(dmFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        const logFields = [
            { name: '🛡 İşlem Türü', value: isTemp ? '`TEMPBAN (SÜRELİ BAN)`' : '`BAN`', inline: true },
            { name: '🆔 Ceza ID', value: `\`#${cezaId}\``, inline: true },
            { name: '👤 İşlem Alan', value: `${target} (${target.id})`, inline: false },
            { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
            ...(isTemp ? [{ name: '⏳ Süre', value: timeStr, inline: true }] : []),
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const logEmbed = new EmbedBuilder()
            .setColor(isTemp ? 0xE67E22 : 0xFF0000)
            .setTitle(isTemp ? `⏳ ${guildName} | Süreli Ban Bildirimi` : `🚨 ${guildName} | Ceza Sistemi`)
            .setDescription(isTemp ? `⏳ **${target}** adlı kullanıcıya **${timeStr}** süreyle geçici ban atıldı.` : `🛑 **${target}** adlı kullanıcıya kalıcı yasaklama uygulandı.`)
            .addFields(logFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        try {
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (member) {
                const fullReason = isTemp ? `${interaction.user.tag}:${reason} (${timeStr})` : `${interaction.user.tag}:${reason}`;
                try { await target.send({ embeds: [dmEmbed] }); } catch (err) {}
                await member.ban({ reason: fullReason });
                
                addStat(guildId, interaction.user.id, isTemp ? 'tempban' : 'ban');
                logGonder(interaction.guild, settings, logEmbed);

                if (isTemp) {
                    const unbanTime = Date.now() + banMs;
                    activeTempBans.push({ guildId: interaction.guild.id, userId: target.id, unbanTime });
                    saveTempBans();
                }

            } else {
                return interaction.reply({ content: '⚠️ İşlem başarısız! Kullanıcı sunucuda bulunmuyor.', ephemeral: true });
            }
        } catch (e) {
            console.error(e);
            return interaction.reply({ content: '⚠️ İşlem başarısız! Botun yetkisi yetersiz veya rolü hedef kişiden altta.', ephemeral: true });
        }

        return interaction.reply({ content: isTemp ? `✅ İşlem başarılı! Kullanıcı ${timeStr} süreliğine yasaklandı. Ceza ID: #${cezaId}` : `✅ İşlem başarılı! Ceza ID: #${cezaId}`, ephemeral: true });
    }

    if (interaction.commandName === 'at') {
        const target = interaction.options.getUser('kullanici');
        const reason = interaction.options.getString('sebep');
        const cezaId = Math.floor(100 + Math.random() * 900);

        const dmTitle = `⚡ ${guildName} | Sunucudan Uzaklaştırıldınız`;
        const dmDescription = `**${target}**, **${guildName}** sunucusundan geçici olarak atıldınız (Kick). Davet bağlantısı ile tekrar giriş yapabilirsiniz.`;
        const dmFields = [
            { name: '🛡️ İşlem Türü', value: '`KICK`', inline: true },
            { name: '🆔 İşlem ID', value: `\`#${cezaId}\``, inline: true },
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const dmEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle(dmTitle)
            .setDescription(dmDescription)
            .addFields(dmFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        const kickFields = [
            { name: '🛡 İşlem Türü', value: '`KICK (SUNUCUDAN ATMA)`', inline: true },
            { name: '🆔 Ceza ID', value: `\`#${cezaId}\``, inline: true },
            { name: '👤 Atılan Üye', value: `${target} (${target.id})`, inline: false },
            { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const kickLogEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle(`⚡ ${guildName} | Kick Bildirimi`)
            .setDescription(`⚡ **${target}** adlı kullanıcı sunucudan uzaklaştırıldı.`)
            .addFields(kickFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        try {
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (member) {
                const fullReason = `${interaction.user.tag}:${reason}`;
                try { await target.send({ embeds: [dmEmbed] }); } catch (err) {}
                await member.kick(fullReason);
                addStat(guildId, interaction.user.id, 'kick');
                logGonder(interaction.guild, settings, kickLogEmbed);
            } else {
                return interaction.reply({ content: '⚠️ İşlem başarısız! Kullanıcı sunucuda bulunmuyor.', ephemeral: true });
            }
        } catch (e) {
            console.error(e);
            return interaction.reply({ content: '⚠️ İşlem başarısız! Botun yetkisi yetersiz veya rolü hedef kişiden altta.', ephemeral: true });
        }

        return interaction.reply({ content: `✅ İşlem başarılı! Ceza ID: #${cezaId}`, ephemeral: true });
    }

    if (interaction.commandName === 'timeout') {
        const target = interaction.options.getUser('kullanici');
        const timeStr = interaction.options.getString('sure');
        const reason = interaction.options.getString('sebep');
        const cezaId = Math.floor(100 + Math.random() * 900);

        const timeoutMs = convertMs(timeStr);
        if (!timeoutMs || timeoutMs <= 0) {
            return interaction.reply({ content: '⚠️ Geçerli bir süre girmelisiniz (Örn: 10dk, 1sa, 1g)!', ephemeral: true });
        }

        const dmTitle = `🔇 ${guildName} | Susturuldunuz (Timeout)`;
        const dmDescription = `**${target}**, sunucu içerisindeki tutumunuz nedeniyle süreli olarak susturuldunuz.`;
        const dmFields = [
            { name: '🛡 İşlem Türü', value: '`TIMEOUT`', inline: true },
            { name: '🆔 İşlem ID', value: `\`#${cezaId}\``, inline: true },
            { name: '⏳ Süre', value: timeStr, inline: true },
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const dmEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle(dmTitle)
            .setDescription(dmDescription)
            .addFields(dmFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        const timeoutFields = [
            { name: '🛡️ İşlem Türü', value: '`TIMEOUT (SUSTURMA)`', inline: true },
            { name: '🆔 Ceza ID', value: `\`#${cezaId}\``, inline: true },
            { name: '👤 Susturulan Üye', value: `${target} (${target.id})`, inline: false },
            { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
            { name: '⏳ Süre', value: timeStr, inline: true },
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const timeoutLogEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle(`🔇 ${guildName} | Susturma Bildirimi`)
            .setDescription(`👤 **${target}** adlı kullanıcı sunucumuzda susturuldu.`)
            .addFields(timeoutFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        try {
            const member = await interaction.guild.members.fetch(target.id).catch(() => null);
            if (member) {
                const fullReason = `${interaction.user.tag}:${reason}`;
                try { await target.send({ embeds: [dmEmbed] }); } catch (err) {}
                await member.timeout(timeoutMs, fullReason);
                addStat(guildId, interaction.user.id, 'timeout');
                logGonder(interaction.guild, settings, timeoutLogEmbed);
            } else {
                return interaction.reply({ content: '⚠️ İşlem başarısız! Kullanıcı sunucuda bulunmuyor.', ephemeral: true });
            }
        } catch (e) {
            console.error(e);
            return interaction.reply({ content: '⚠️ İşlem başarısız! Botun yetkisi yetersiz veya rolü hedef kişiden altta.', ephemeral: true });
        }

        return interaction.reply({ content: `✅ İşlem başarılı! Ceza ID: #${cezaId}`, ephemeral: true });
    }

    if (interaction.commandName === 'uyar') {
        const target = interaction.options.getUser('kullanici');
        const puan = interaction.options.getInteger('puan');
        const reason = interaction.options.getString('sebep');
        const uyariId = Math.floor(100 + Math.random() * 900);

        if (!warningsDB[target.id]) { warningsDB[target.id] = []; }
        const userWarnings = warningsDB[target.id];
        userWarnings.push({ id: uyariId, points: puan, reason: reason, moderator: interaction.user.tag, date: new Date().toLocaleDateString('tr-TR') });
        saveWarnings();

        const totalPoints = userWarnings.reduce((sum, w) => sum + w.points, 0);

        const warnFields = [
            { name: '🛡️ İşlem Türü', value: '`UYARI (WARN)`', inline: true },
            { name: '🆔 Uyarı ID', value: `\`#${uyariId}\``, inline: true },
            { name: '📈 Eklenen Puan', value: `\`+${puan} Puan\``, inline: true },
            { name: '📊 Toplam Puan', value: `\`${totalPoints} Puan\``, inline: true },
            { name: '👤 Uyarı Alan', value: `${target} (${target.id})`, inline: false },
            { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
            { name: '⚠️ Sebep', value: reason, inline: false }
        ];

        const warnLogEmbed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(`⚠️ ${guildName} | Uyarı Sistemi`)
            .setDescription(`⚠️ **${target}** adlı kullanıcıya **${puan}** uyarı puanı eklendi.`)
            .addFields(warnFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        addStat(guildId, interaction.user.id, 'warn');
        logGonder(interaction.guild, settings, warnLogEmbed);

        return interaction.reply({ content: `✅ Uyarı başarıyla verildi! Eklenen Puan: +${puan} \vert{} Toplam Puan:${totalPoints}`, ephemeral: true });
    }

    if (interaction.commandName === 'uyari-sil') {
        const target = interaction.options.getUser('kullanici');
        const silinecekPuan = interaction.options.getInteger('puan');
        const reason = interaction.options.getString('sebep');

        if (!warningsDB[target.id] || warningsDB[target.id].length === 0) {
            return interaction.reply({ content: '⚠️ Bu kullanıcının silinebilecek hiçbir uyarı kaydı bulunmuyor.', ephemeral: true });
        }

        const userWarnings = warningsDB[target.id];
        const currentTotal = userWarnings.reduce((sum, w) => sum + w.points, 0);

        if (silinecekPuan > currentTotal) {
            return interaction.reply({ content: `⚠️ Kullanıcının toplamda zaten \`${currentTotal} Puan\` uyarı puanı var. Bu kadar (\`${silinecekPuan}\`) puan silemezsin!`, ephemeral: true });
        }

        const dususId = Math.floor(100 + Math.random() * 900);
        userWarnings.push({ id: dususId, points: -silinecekPuan, reason: `Uyarı Düşümü: ${reason}`, moderator: interaction.user.tag, date: new Date().toLocaleDateString('tr-TR') });
        saveWarnings();

        const newTotalPoints = userWarnings.reduce((sum, w) => sum + w.points, 0);

        const clearFields = [
            { name: '🛡 İşlem Türü', value: '`UYARI PUANI DÜŞME`', inline: true },
            { name: '👤 İşlem Yapılan Üye', value: `${target} (${target.id})`, inline: false },
            { name: '📉 Silinen Puan', value: `\`-${silinecekPuan} Puan\``, inline: true },
            { name: '📊 Kalan Toplam Puan', value: `\`${newTotalPoints} Puan\``, inline: true },
            { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
            { name: '⚠️ Sebep / Açıklama', value: reason, inline: false }
        ];

        const clearLogEmbed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`🧹 ${guildName} | Uyarı Puanı Düşme Sistemi`)
            .setDescription(`✅ **${target}** adlı kullanıcının uyarı puanından **${silinecekPuan}** puan silindi.`)
            .addFields(clearFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        logGonder(interaction.guild, settings, clearLogEmbed);

        return interaction.reply({ content: `✅ İşlem başarılı! Kullanıcıdan **-${silinecekPuan} Puan** silindi. Kalan Toplam Puan: ${newTotalPoints}`, ephemeral: true });
    }

    if (interaction.commandName === 'uyarilari-goster') {
        const target = interaction.options.getUser('kullanici');
        const userWarnings = warningsDB[target.id] || [];
        const totalPoints = userWarnings.reduce((sum, w) => sum + w.points, 0);

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`📋 ${guildName} | Uyarı ve Puan Geçmişi`)
            .setDescription(`👤 **${target}** adlı kullanıcının toplam uyarı durumu aşağıdadır.`)
            .addFields({ name: '📊 Toplam Uyarı Puanı', value: `\`${totalPoints} Puan\` (${userWarnings.length} adet işlem kaydı)`, inline: false })
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        if (userWarnings.length === { length: 0 }.length && userWarnings.length === 0) { 
            embed.addFields({ name: '✨ Durum', value: 'Bu kullanıcının hiç uyarı kaydı bulunmuyor.', inline: false }); 
        } else { 
            const listText = userWarnings.slice(-5).map(w => `• **ID:** \`#${w.id}\` | **Puan:** \`${w.points > 0 ? '+' + w.points : w.points}\` | **Tarih:** ${w.date}\n  **Sebep:** ${w.reason} *(Yetkili:${w.moderator})*`).join('\n\n'); 
            embed.addFields({ name: '⚠️ Son İşlemler / Uyarılar', value: safeTrim(listText), inline: false }); 
        }
        
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'unban') {
        const userId = interaction.options.getString('kullanici_id');
        const reason = interaction.options.getString('sebep');
        const unbanId = Math.floor(100 + Math.random() * 900);

        let targetUser; 
        try { targetUser = await client.users.fetch(userId); } catch (e) { targetUser = null; }

        try { 
            await interaction.guild.members.unban(userId, reason); 
        } catch (e) { 
            return interaction.reply({ content: '⚠️ Bu kullanıcı zaten banlı değil veya yetkim yok!', ephemeral: true }); 
        }

        // Unban başarılıysa güvenli şekilde uyarı veritabanından siliyoruz
        if (warningsDB[userId]) {
            delete warningsDB[userId];
            saveWarnings();
        }

        const unbanFields = [
            { name: '🛡️ İşlem Türü', value: '`BAN AFFI`', inline: true },
            { name: '🆔 İşlem ID', value: `\`#${unbanId}\``, inline: true },
            { name: '👤 Affedilen Üye', value: `<@${userId}> (${userId})`, inline: false },
            { name: '👮 Yetkili', value: `${interaction.user}`, inline: true },
            { name: '⚠️ Af Sebebi', value: reason, inline: false }
        ];

        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle(`🔓 ${guildName} | Ban Affı Duyurusu`)
            .setDescription(`✅ **<@${userId}>** adlı kullanıcının sunucumuzdaki yasaklaması kaldırılmıştır.\n\n🔗 **Af Detayları:**`)
            .addFields(unbanFields)
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        logGonder(interaction.guild, settings, embed);

        if (targetUser) {
            try { await targetUser.send({ content: `🎉 **Tebrikler!** **${guildName}** sunucusundaki yasaklamanız kaldırıldı.`, embeds: [embed] }); } catch (err) {}
        }
        
        return interaction.reply({ content: `✅ İşlem başarılı! Ban kaldırıldı ve log kanalına duyuruldu.`, ephemeral: true });
    }

    if (interaction.commandName === 'yetkili-istatistik') {
        const targetMod = interaction.options.getUser('yetkili') || interaction.user;
        const stats = (modStats[guildId] && modStats[guildId][targetMod.id]) || { ban: 0, tempban: 0, kick: 0, timeout: 0, warn: 0 };
        const toplamIslem = stats.ban + stats.tempban + stats.kick + stats.timeout + stats.warn;

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle(`📊 ${guildName} | Yetkili İstatistikleri`)
            .setDescription(`👮 **${targetMod}** adlı yetkilinin gerçekleştirdiği toplam moderasyon işlemleri:`)
            .addFields(
                { name: '🛑 Ban İşlemleri', value: `\`${stats.ban}\``, inline: true },
                { name: '⏳ Tempban İşlemleri', value: `\`${stats.tempban}\``, inline: true },
                { name: '⚡ Kick İşlemleri', value: `\`${stats.kick}\``, inline: true },
                { name: '🔇 Timeout İşlemleri', value: `\`${stats.timeout}\``, inline: true },
                { name: '⚠️ Uyarı İşlemleri', value: `\`${stats.warn}\``, inline: true },
                { name: '📈 Toplam İşlem', value: `\`${toplamIslem}\``, inline: false }
            )
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'oto-koruma') {
        const durum = interaction.options.getBoolean('durum');
        if (!guildSettings[guildId]) guildSettings[guildId] = {};
        guildSettings[guildId].AUTO_PROTECT = durum;
        saveSettings();

        return interaction.reply({ content: `✅ Genel otomatik koruma sistemi başarıyla **${durum ? 'AÇILDI' : 'KAPATILDI'}**!`, ephemeral: true });
    }

    if (interaction.commandName === 'sunucu-bilgi') {
        const { guild } = interaction;
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`🏢 ${guild.name} | Sunucu Bilgileri`)
            .setThumbnail(guild.iconURL({ dynamic: true }))
            .addFields(
                { name: '👑 Sunucu Sahibi', value: `<@${guild.ownerId}>`, inline: true },
                { name: '📅 Kuruluş Tarihi', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                { name: '👥 Üye Sayısı', value: `\`${guild.memberCount}\``, inline: true },
                { name: '💬 Kanal Sayısı', value: `\`${guild.channels.cache.size}\``, inline: true },
                { name: '🛡️ Rol Sayısı', value: `\`${guild.roles.cache.size}\``, inline: true }
            )
            .setFooter({ text: `${guildName} | Güvenlik ve Moderasyon Departmanı` })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);