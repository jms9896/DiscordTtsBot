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

const REQUIRED_ENV = ['DISCORD_TOKEN', 'OPENAI_API_KEY', 'CLIENT_ID', 'GUILD_ID'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

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
    if (interaction.commandName === 'tts') {
      const text = interaction.options.getString('text', true).trim();
      if (!text.length) {
        await interaction.reply(ephemeral('말할 문장을 입력해 주세요.'));
        return;
      }

      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply(ephemeral('먼저 음성 채널에 참여해 주세요.'));
        return;
      }

      await interaction.reply(ephemeral(`재생 대기열에 추가: ${text}`));
      await enqueueSpeech(voiceChannel, text, async () => {
        await interaction.followUp(ephemeral('재생에 실패했어요. 잠시 후 다시 시도해 주세요.')).catch(() => void 0);
      });
      return;
    }

    if (interaction.commandName === 'voiceroom') {
      guildChannelConfig.set(guildId, interaction.channelId);
      await interaction.reply(ephemeral('이 채널의 메시지만 읽을게요.'));
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

  const text = message.content.trim();
  if (!text || text.startsWith('/')) return;

  const allowedChannelId = guildChannelConfig.get(message.guild.id);
  if (!allowedChannelId || message.channel.id !== allowedChannelId) {
    return;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('먼저 음성 채널에 들어와 주세요.').catch(() => void 0);
    return;
  }

  await enqueueSpeech(voiceChannel, text, async () => {
    await message.reply('재생에 실패했어요. 잠시 후 다시 시도해 주세요.').catch(() => void 0);
  });
});

async function enqueueSpeech(voiceChannel, text, onError) {
  try {
    const state = await ensureConnection(voiceChannel);
    const preparedSpeech = synthesizeToResource(text).catch((error) => {
      throw error;
    });
    state.queue = state.queue
      .then(() => playText(state, text, preparedSpeech))
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

async function playText(state, text, preparedResourcePromise) {
  const resourcePromise = preparedResourcePromise ?? synthesizeToResource(text);
  const resource = await resourcePromise;
  state.player.play(resource);

  await entersState(state.player, AudioPlayerStatus.Playing, 5_000);
  const playbackTimeout = Math.min(120_000, Math.max(10_000, text.length * 600));
  await entersState(state.player, AudioPlayerStatus.Idle, playbackTimeout);
}

async function synthesizeToResource(text) {
  const response = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: VOICE_NAME,
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
  const allowed = new Map([
    ['alloy', 'alloy'],
    ['echo', 'echo'],
    ['fable', 'fable'],
    ['onyx', 'onyx'],
    ['nova', 'nova'],
    ['shimmer', 'shimmer'],
    ['coral', 'coral'],
    ['verse', 'verse'],
    ['ballad', 'ballad'],
    ['ash', 'ash'],
    ['sage', 'sage'],
    ['marin', 'marin'],
    ['cedar', 'cedar'],
  ]);

  return allowed.get(normalized) ?? 'echo';
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('tts')
      .setDescription('Play a piece of text through the voice channel.')
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('Sentence for text-to-speech')
          .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('voiceroom')
      .setDescription('Set this text channel as the one to read aloud.'),
    new SlashCommandBuilder()
      .setName('quit')
      .setDescription('Disconnect the bot from the voice channel.'),
  ].map((command) => command.toJSON());

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );

  console.log('Slash commands registered');
}

(async () => {
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start bot', error);
    process.exit(1);
  }
})();








