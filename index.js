function normalizeVoice(input) {
  if (!input) return 'alloy';
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
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
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

const REQUIRED_ENV = ['DISCORD_TOKEN', 'OPENAI_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const VOICE_NAME = process.env.TTS_VOICE ?? 'echo';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const guildAudioState = new Map();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const text = message.content.trim();
  if (!text) return;

  if (text.toLowerCase() === '/quit') {
    const state = guildAudioState.get(message.guild.id);
    if (!state) {
      await message.reply('현재 음성 채널에 연결되어 있지 않아요.').catch(() => void 0);
      return;
    }

    cleanupState(message.guild.id);
    await message.reply('음성 채널에서 나갈게요.').catch(() => void 0);
    return;
  }

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    await message.reply('음성 채널에 먼저 들어와 주세요.').catch(() => void 0);
    return;
  }

  try {
    const state = await ensureConnection(voiceChannel);
    state.queue = state.queue
      .then(() => playText(state, text))
      .catch(async (error) => {
        console.error('Playback error', error);
        await message
          .reply('음성 재생에 실패했어요. 잠시 후 다시 시도해 주세요.')
          .catch(() => void 0);
      });
  } catch (error) {
    console.error('Voice connection error', error);
    await message.reply('음성 채널 연결에 실패했어요. 잠시 후 다시 시도해 주세요.').catch(() => void 0);
  }
});

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

async function playText(state, text) {
  const resource = await synthesizeToResource(text);
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

(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start bot', error);
    process.exit(1);
  }
})();

