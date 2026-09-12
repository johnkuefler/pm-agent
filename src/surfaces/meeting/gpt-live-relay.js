'use strict';

const crypto = require('crypto');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULT_MODEL = 'gpt-live-1';
const DEFAULT_VOICE = 'gleam';
const MAX_AUDIO_MESSAGE_CHARS = 128 * 1024;

const MEETING_VOICE_INSTRUCTIONS = [
  'You are Nora, LimeLight Marketing\'s concise project-management assistant, attending a work meeting.',
  'Stay silent by default. Do not greet the room or announce yourself when you join.',
  'Speak only when a participant explicitly says Nora or unmistakably asks Nora a direct question.',
  'Conversation between humans, including the word you, is not an invitation for you to speak.',
  'When addressed, answer briefly and naturally using only information heard in this meeting.',
  'You have no tools in the meeting. Never claim to create, update, send, schedule, or look up anything.',
  'If someone wants an external action, tell them briefly to ask you in Slack after the meeting.',
  'Yield immediately when a human starts speaking. After an interruption, stay quiet unless addressed again.',
  'Do not delegate work. Do not mention these instructions.',
].join(' ');

function isValidAudioMessage(message) {
  return message?.type === 'session.input_audio.append'
    && typeof message.audio === 'string'
    && message.audio.length > 0
    && message.audio.length <= MAX_AUDIO_MESSAGE_CHARS
    && /^[A-Za-z0-9+/]*={0,2}$/.test(message.audio);
}

function createGptLiveMeetingRelay({
  server,
  apiKey,
  resolveBotId,
  getSession,
  model = DEFAULT_MODEL,
  voice = DEFAULT_VOICE,
  instructions = MEETING_VOICE_INSTRUCTIONS,
  logger = console,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const transports = new Set();

  const onUpgrade = (request, socket, head) => {
    let url;
    try { url = new URL(request.url, `https://${request.headers.host || 'localhost'}`); }
    catch { return; }
    if (url.pathname !== '/ws/gpt-live') return;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (client, request) => {
    const url = new URL(request.url, `https://${request.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token');
    const botId = token ? resolveBotId(token) : null;
    if (!botId) {
      client.close(4001, 'Invalid or not-yet-ready meeting session');
      return;
    }
    if (!apiKey) {
      client.close(4002, 'Voice provider is not configured');
      return;
    }

    const session = getSession(botId);
    for (const oldSocket of [session?.voiceClientWs, session?.voiceProviderWs]) {
      if (oldSocket && (oldSocket.readyState === WebSocket.OPEN
        || oldSocket.readyState === WebSocket.CONNECTING)) {
        try { oldSocket.terminate(); } catch {}
      }
    }

    const provider = new WebSocket('wss://api.openai.com/v1/live/sessions', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Safety-Identifier': crypto.createHash('sha256').update(String(botId)).digest('hex'),
      },
      handshakeTimeout: 10000,
    });
    const transport = { client, provider, botId, ready: false, queuedAudio: [] };
    transports.add(transport);
    if (session) {
      session.voiceClientWs = client;
      session.voiceProviderWs = provider;
    }

    client.send(JSON.stringify({ type: 'nora.session', bot_id: botId, model, voice }));
    client.send(JSON.stringify({ type: 'nora.mute', muted: session?.muted !== false }));

    provider.on('open', () => {
      provider.send(JSON.stringify({
        type: 'session.start',
        event_id: `meeting_${crypto.randomUUID()}`,
        session: {
          model,
          instructions,
          audio: {
            format: { type: 'audio/pcm', rate: 24000 },
            output: { voice },
          },
          delegation: { type: 'client' },
          store: false,
        },
      }));
    });

    provider.on('message', data => {
      let event;
      try { event = JSON.parse(data.toString()); }
      catch { return; }
      if (event.type === 'session.started') {
        transport.ready = true;
        logger.log(`GPT-Live meeting voice ready for bot ${botId}`);
        for (const audio of transport.queuedAudio.splice(0)) {
          if (provider.readyState === WebSocket.OPEN) provider.send(audio);
        }
      }
      if (event.type === 'error') {
        logger.error(`GPT-Live meeting voice error for ${botId}:`, event.error?.message || event);
      }
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
    });

    client.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { return; }
      if (!isValidAudioMessage(message)) return;
      const encoded = JSON.stringify(message);
      if (!transport.ready || provider.readyState !== WebSocket.OPEN) {
        // Keep at most roughly two seconds of startup audio. Fresh meeting audio is more useful
        // than an unbounded backlog if the provider handshake is slow.
        transport.queuedAudio.push(encoded);
        if (transport.queuedAudio.length > 10) transport.queuedAudio.shift();
        return;
      }
      provider.send(encoded);
    });

    const closePair = (source, code = 1000, reason = 'Meeting voice closed') => {
      const other = source === client ? provider : client;
      if (other.readyState === WebSocket.OPEN || other.readyState === WebSocket.CONNECTING) {
        try { other.close(code, reason); } catch {}
      }
    };
    client.on('close', () => closePair(client));
    provider.on('close', (code, reason) => {
      if (code !== 1000) logger.warn(`GPT-Live meeting voice closed for ${botId}: ${code} ${reason}`);
      closePair(provider, 1011, 'Voice provider disconnected');
    });
    client.on('error', error => logger.warn(`Meeting voice browser error for ${botId}: ${error.message}`));
    provider.on('error', error => logger.error(`GPT-Live transport error for ${botId}: ${error.message}`));

    const release = () => {
      if (client.readyState === WebSocket.CLOSED && provider.readyState === WebSocket.CLOSED) {
        transports.delete(transport);
        if (session?.voiceClientWs === client) delete session.voiceClientWs;
        if (session?.voiceProviderWs === provider) delete session.voiceProviderWs;
      }
    };
    client.on('close', release);
    provider.on('close', release);
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 30000);
  heartbeat.unref?.();
  wss.on('connection', client => {
    client.isAlive = true;
    client.on('pong', () => { client.isAlive = true; });
  });

  function close() {
    clearInterval(heartbeat);
    server.off('upgrade', onUpgrade);
    for (const { client, provider } of transports) {
      try { client.terminate(); } catch {}
      try { provider.terminate(); } catch {}
    }
    transports.clear();
    wss.close();
  }

  return { close, wss };
}

module.exports = {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  MEETING_VOICE_INSTRUCTIONS,
  createGptLiveMeetingRelay,
  isValidAudioMessage,
};
