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
import { Readable } from 'stream';

const REQUIRED_ENV = ['DISCORD_TOKEN', 'OPENAI_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const VOICE_NAME = process.env.TTS_VOICE ?? 'alloy';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let playbackQueue = Promise.resolve();

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', (message) => {
  if (!message.guild || message.author.bot) return;

  const text = message.content.trim();
  if (!text) return;

  const voiceChannel = message.member?.voice?.channel;
  if (!voiceChannel) {
    message.reply('음성 채널에 먼저 들어와 주세요.').catch(() => void 0);
    return;
  }

  playbackQueue = playbackQueue
    .then(() => speakInVoiceChannel(voiceChannel, text))
    .catch(async (error) => {
      console.error('Playback error', error);
      await message.reply('음성 재생에 실패했어요. 잠시 후 다시 시도해 주세요.').catch(() => void 0);
    });
});

async function speakInVoiceChannel(voiceChannel, text) {
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: voiceChannel.guild.id,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    selfDeaf: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
  } catch (error) {
    connection.destroy();
    throw new Error('Voice connection timeout');
  }

  try {
    const audioResource = await synthesizeToResource(text);
    const player = createAudioPlayer();
    const subscription = connection.subscribe(player);

    player.play(audioResource);

    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    const playbackTimeout = Math.min(120_000, Math.max(10_000, text.length * 600));
    await entersState(player, AudioPlayerStatus.Idle, playbackTimeout);

    subscription?.unsubscribe();
    connection.destroy();
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

async function synthesizeToResource(text) {
  const response = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: VOICE_NAME,
    input: text,
    format: 'opus',
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const stream = Readable.from(buffer);
  const { stream: demuxedStream, type } = await demuxProbe(stream);
  return createAudioResource(demuxedStream, { inputType: type });
}

(async () => {
  try {
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Failed to start bot', error);
    process.exit(1);
  }
})();
