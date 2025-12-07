import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } from 'discord.js';
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import OpenAI from 'openai';
import { PassThrough } from 'stream';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile } from 'fs/promises';

const REQUIRED_ENV = ['DISCORD_TOKEN', 'OPENAI_API_KEY', 'CLIENT_ID', 'GUILD_ID'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VOICE_NAME = normalizeVoice(process.env.TTS_VOICE);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

const guildAudioState = new Map();
const guildChannelConfig = new Map();
const userVoicePreference = new Map();
const voiceFilePath = join(__dirname, 'voice.txt');

const allowedVoices = [
  'alloy',
  'echo',
  'fable',
  'onyx',
  'nova',
  'shimmer',
  'coral',
  'verse',
  'ballad',
  'ash',
  'sage',
  'marin',
  'cedar',
];

const sanitizeText = (input) => {
  const trimmed = input.trim();
  if (trimmed.startsWith('http')) return '링크를 첨부했어요.';

  const replacements = [
    ['ㄱㅊ', '괜춘'],
    ['ㅇㅎ', '아하'],
    ['ㅅㅂ', '쉬발'],
    ['ㅆㅃ', '씨빨'],
    ['ㅆㅂ', '쒸발'],
    ['ㅈㄹ', '지랄'],
  ];

  const replaced = replacements.reduce(
    (acc, [pat, rep]) => acc.replace(new RegExp(pat, 'g'), rep),
    trimmed
  );

  const expand = (str, ch, rep) =>
    str.replace(new RegExp(`${ch}+`, 'g'), (m) => rep.repeat(m.length));

  const expanded = expand(expand(replaced, 'ㄴ', '노'), 'ㅇ', '응');

  // 동일 문자 연속 입력은 최대 5자까지만 읽음
  return expanded.replace(/(.)\1{4,}/g, (m, ch) => ch.repeat(4));
};

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply(ephemeral('이 명령은 서버에서만 사용할 수 있어요.')).catch(() => void 0);
    return;
  }

  try {
    if (interaction.commandName === 'd') {
      const raw = interaction.options.getString('text', true);
      const text = sanitizeText(raw);
      if (!text.length) {
        await interaction.reply(ephemeral('말할 문장을 입력해 주세요.'));
        return;
      }

      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply(ephemeral('먼저 음성 채널에 참여해 주세요.'));
        return;
      }

      const voice = getOrAssignVoice(interaction.user.id);
      await interaction.reply(ephemeral('음성으로 재생할게요.'));
      await enqueueSpeech(voiceChannel, text, voice, async () => {
        await interaction.followUp(ephemeral('재생에 실패했어요. 잠시 후 다시 시도해 주세요.')).catch(() => void 0);
      });
      return;
    }

    if (interaction.commandName === 'voiceroom') {
      guildChannelConfig.set(guildId, interaction.channelId);
      await interaction.reply(ephemeral('이 채널의 메시지만 읽을게요.'));
      return;
    }

    if (interaction.commandName === 'selectvoice') {
      const selected = normalizeVoice(interaction.options.getString('voice', true));
      userVoicePreference.set(interaction.user.id, selected);
      await persistVoicePrefs();
      await interaction.reply(ephemeral(`당신의 목소리를 '${selected}'로 설정했어요.`));
      return;
    }

    if (interaction.commandName === 'quit') {
      cleanupState(guildId);
      await interaction.reply(ephemeral('음성 채널을 떠났어요.'));
    }
  } catch (error) {
    console.error('Interaction handling failed', error);
    if (interaction.isRepliable()) {
      const responseMethod = interaction.deferred || interaction.replied ? 'followUp' : 'reply';
      await interaction[responseMethod](ephemeral('명령 실행 중 오류가 발생했어요.')).catch(() => void 0);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const raw = message.content;
  const isDirectSpeak = raw.startsWith('/d');
  const text = sanitizeText(isDirectSpeak ? raw.slice(2) : raw);

  if (!text) return;
  if (!isDirectSpeak && raw.startsWith('/')) return;

  const allowedChannelId = guildChannelConfig.get(message.guild.id);
  if (!allowedChannelId || message.channel.id !== allowedChannelId) {
    return;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('먼저 음성 채널에 들어와 주세요.').catch(() => void 0);
    return;
  }

  const voice = getOrAssignVoice(message.author.id);

  if (isDirectSpeak) {
    await message.delete().catch(() => void 0);
  }

  await enqueueSpeech(voiceChannel, text, voice, async () => {
    await message.reply('재생에 실패했어요. 잠시 후 다시 시도해 주세요.').catch(() => void 0);
  });
});

async function enqueueSpeech(voiceChannel, text, voice, onError) {
  try {
    const state = await ensureConnection(voiceChannel);
    const preparedSpeech = synthesizeToResource(text, voice).catch((error) => {
      throw error;
    });
    state.queue = state.queue
      .then(() => playText(state, text, voice, preparedSpeech))
      .catch(async (error) => {
        console.error('Playback error', error);
        if (onError) await onError();
      });
  } catch (error) {
    console.error('Voice connection error', error);
    if (onError) await onError();
  }
}

async function ensureConnection(voiceChannel) {
  let state = guildAudioState.get(voiceChannel.guild.id);

  if (state && state.connection.joinConfig.channelId !== voiceChannel.id) {
    cleanupState(voiceChannel.guild.id);
    state = undefined;
  }

  if (!state) {
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    const player = createAudioPlayer();
    connection.subscribe(player);

    state = {
      connection,
      player,
      queue: Promise.resolve(),
    };

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        cleanupState(voiceChannel.guild.id);
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      cleanupState(voiceChannel.guild.id);
    });

    guildAudioState.set(voiceChannel.guild.id, state);
  }

  await entersState(state.connection, VoiceConnectionStatus.Ready, 10_000);
  return state;
}

async function playText(state, text, voice, preparedResourcePromise) {
  const resourcePromise = preparedResourcePromise ?? synthesizeToResource(text, voice);
  const resource = await resourcePromise;
  state.player.play(resource);

  await entersState(state.player, AudioPlayerStatus.Playing, 5_000);
  const playbackTimeout = Math.min(120_000, Math.max(10_000, text.length * 600));
  await entersState(state.player, AudioPlayerStatus.Idle, playbackTimeout);
}

async function synthesizeToResource(text, voice) {
  const response = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: voice ?? VOICE_NAME,
    input: text,
    format: 'opus',
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const stream = new PassThrough();
  stream.end(buffer);
  const { stream: demuxedStream, type } = await demuxProbe(stream);
  return createAudioResource(demuxedStream, { inputType: type });
}

function cleanupState(guildId) {
  const state = guildAudioState.get(guildId);
  if (!state) return;

  try {
    state.player.stop(true);
  } catch {
    // ignore
  }

  try {
    if (state.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      state.connection.destroy();
    }
  } catch {
    // ignore
  }

  guildAudioState.delete(guildId);
}

function normalizeVoice(input) {
  if (!input) return 'echo';
  const normalized = input.trim().toLowerCase();
  return allowedVoices.includes(normalized) ? normalized : 'echo';
}

function getOrAssignVoice(userId) {
  const existing = userVoicePreference.get(userId);
  if (existing) return existing;
  const voice = pickLeastUsedVoice();
  userVoicePreference.set(userId, voice);
  persistVoicePrefs().catch(() => void 0);
  return voice;
}

function pickLeastUsedVoice() {
  const counts = new Map(allowedVoices.map((v) => [v, 0]));
  for (const voice of userVoicePreference.values()) {
    counts.set(voice, (counts.get(voice) ?? 0) + 1);
  }
  const min = Math.min(...counts.values());
  const candidates = allowedVoices.filter((v) => counts.get(v) === min);
  return candidates[Math.floor(Math.random() * candidates.length)] || 'echo';
}

async function loadVoicePrefs() {
  try {
    const data = await readFile(voiceFilePath, 'utf8');
    data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .forEach((line) => {
        const [id, voice] = line.split(':');
        const normalized = normalizeVoice(voice);
        if (id && normalized) userVoicePreference.set(id, normalized);
      });
  } catch {
    // 파일이 없거나 읽을 수 없는 경우 무시
  }
}

async function persistVoicePrefs() {
  const lines = [];
  for (const [id, voice] of userVoicePreference.entries()) {
    lines.push(`${id}:${voice}`);
  }
  await writeFile(voiceFilePath, lines.join('\n'), 'utf8');
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('voiceroom')
      .setDescription('이 채널을 보이스룸으로 설정합니다. 이 채널의 글만 읽습니다.'),
    new SlashCommandBuilder()
      .setName('d')
      .setDescription('채팅기록 안 남기고 목소리만 내기')
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('Sentence for direct speech')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('selectvoice')
      .setDescription('TTS voice를 선택해주세요.')
      .addStringOption((opt) => {
        opt.setName('voice').setDescription('Choose a voice').setRequired(true);
        allowedVoices.forEach((v) => opt.addChoices({ name: v, value: v }));
        return opt;
      }),
    new SlashCommandBuilder()
      .setName('quit')
      .setDescription('채널에서 정공봇을 내보냅니다.'),
  ].map((command) => command.toJSON());

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );

  console.log('Slash commands registered');
}

(async () => {
  try {
    await loadVoicePrefs();
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start bot', error);
    process.exit(1);
  }
})();




