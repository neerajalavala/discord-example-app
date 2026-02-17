import { ChannelType, Client, GatewayIntentBits } from 'discord.js';

// Rule Guardian listens to live chat messages over the Discord Gateway.
// This is separate from the tutorial's /interactions webhook flow.
const DEFAULT_RESTRICTED_TERMS = ['sell'];
const DEFAULT_PRICE_KEYWORDS = ['usd', 'shipped'];
const DEFAULT_RULE_CHANNEL_NAMES = ['chatter'];
const DEFAULT_MOD_LOG_CHANNEL_NAME = 'mod-log';
const DEFAULT_COOLDOWN_SECONDS = 0;

function parseCsvList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

function normalizeSet(values) {
  return new Set(values.map((value) => value.toLowerCase()));
}

function buildConfig() {
  // Runtime behavior is env-driven so you can tune rules without code changes.
  const restrictedTerms = parseCsvList(process.env.RG_RESTRICTED_TERMS);
  const priceKeywords = parseCsvList(process.env.RG_PRICE_KEYWORDS);
  const ruleChannelNames = parseCsvList(process.env.RG_RULE_CHANNEL_NAMES);

  return {
    enabled: parseBoolean(process.env.RG_ENABLED, true),
    guildId: process.env.RG_GUILD_ID || '',
    ruleChannelIds: new Set(parseCsvList(process.env.RG_RULE_CHANNEL_IDS)),
    ruleChannelNames: normalizeSet(
      ruleChannelNames.length ? ruleChannelNames : DEFAULT_RULE_CHANNEL_NAMES,
    ),
    modLogChannelId: process.env.RG_MOD_LOG_CHANNEL_ID || '',
    modLogChannelName: (process.env.RG_MOD_LOG_CHANNEL_NAME || DEFAULT_MOD_LOG_CHANNEL_NAME).toLowerCase(),
    restrictedTerms: restrictedTerms.length ? restrictedTerms : DEFAULT_RESTRICTED_TERMS,
    // Placeholder for future exceptions.
    // Example values: "wholesale", "reseller agreement"
    exceptionPatterns: parseCsvList(process.env.RG_EXCEPTION_PATTERNS),
    enablePricePattern: parseBoolean(process.env.RG_ENABLE_PRICE_PATTERN, true),
    priceKeywords: priceKeywords.length ? priceKeywords : DEFAULT_PRICE_KEYWORDS,
    warningCooldownMs:
      (Number(process.env.RG_WARNING_COOLDOWN_SECONDS) || DEFAULT_COOLDOWN_SECONDS) * 1000,
    logMatchedTerms: parseBoolean(process.env.RG_LOG_MATCHED_TERMS, true),
    rulesUrl: process.env.RG_RULES_URL || '',
  };
}

function buildDetectors(config) {
  // Compile regexes once at startup (faster than rebuilding on every message).
  const restrictedTermChecks = config.restrictedTerms.map((term) => ({
    term,
    regex: new RegExp(`\\b${escapeRegex(term)}\\b`, 'i'),
  }));

  const exceptionChecks = config.exceptionPatterns.map((pattern) => ({
    pattern,
    regex: new RegExp(escapeRegex(pattern), 'i'),
  }));

  const priceKeywordChecks = config.priceKeywords.map((keyword) => ({
    keyword,
    regex: new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'i'),
  }));

  return {
    restrictedTermChecks,
    exceptionChecks,
    priceKeywordChecks,
  };
}

function getUtcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function bumpCount(map, key, delta = 1) {
  map.set(key, (map.get(key) || 0) + delta);
}

function topEntries(map, limit = 3) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isStandardTextChannel(message) {
  return message.channel?.type === ChannelType.GuildText;
}

function shouldProcessMessage(message, config) {
  // Fast exit path: skip anything out of moderation scope.
  if (!message.inGuild()) {
    return false;
  }

  if (!isStandardTextChannel(message)) {
    return false;
  }

  if (config.guildId && message.guildId !== config.guildId) {
    return false;
  }

  if (message.author.bot) {
    return false;
  }

  // TODO(MVP-2): Skip trusted/mod roles with a configurable allowlist.

  // If explicit IDs are configured, ID list is the source of truth.
  if (config.ruleChannelIds.size > 0) {
    return config.ruleChannelIds.has(message.channelId);
  }

  // Name fallback makes local setup easier (ex: #chatter).
  return config.ruleChannelNames.has((message.channel.name || '').toLowerCase());
}

function detectContent(content, detectors, config) {
  // We collect all matches first, then issue one consolidated decision.
  const matchedTerms = [];
  const matchedPriceSignals = [];

  for (const termCheck of detectors.restrictedTermChecks) {
    if (termCheck.regex.test(content)) {
      matchedTerms.push(termCheck.term);
    }
  }

  if (config.enablePricePattern) {
    // Detect prices written like "$400", "£ 90", "€20.50".
    const symbolAmountMatches = content.match(/[$£€]\s?\d+(?:[.,]\d{1,2})?/gi) || [];
    matchedPriceSignals.push(...symbolAmountMatches);

    // Also detect symbol-only usage (ex: "it is $400" can still include raw "$").
    const rawSymbolMatches = content.match(/[$£€]/g) || [];
    matchedPriceSignals.push(...rawSymbolMatches);

    for (const keywordCheck of detectors.priceKeywordChecks) {
      if (keywordCheck.regex.test(content)) {
        matchedPriceSignals.push(keywordCheck.keyword);
      }
    }
  }

  const exceptionMatches = [];
  for (const exceptionCheck of detectors.exceptionChecks) {
    if (exceptionCheck.regex.test(content)) {
      exceptionMatches.push(exceptionCheck.pattern);
    }
  }

  // Exception patterns override positive matches (if configured).
  if (exceptionMatches.length > 0) {
    return {
      triggered: false,
      matchedTerms: [],
      matchedPriceSignals: [],
      triggerTypes: [],
    };
  }

  const uniqueTerms = [...new Set(matchedTerms)];
  const uniquePriceSignals = [...new Set(matchedPriceSignals)];
  const triggerTypes = [];

  if (uniqueTerms.length > 0) {
    triggerTypes.push('word match');
  }
  if (uniquePriceSignals.length > 0) {
    triggerTypes.push('price pattern');
  }

  return {
    triggered: triggerTypes.length > 0,
    matchedTerms: uniqueTerms,
    matchedPriceSignals: uniquePriceSignals,
    triggerTypes,
  };
}

function isCoolingDown(state, message, config, now) {
  // Cooldown key is per-user, per-channel to avoid repeated bot warnings.
  const cooldownKey = `${message.author.id}:${message.channelId}`;
  const lastWarningAt = state.cooldowns.get(cooldownKey);

  if (lastWarningAt && now - lastWarningAt < config.warningCooldownMs) {
    return true;
  }

  state.cooldowns.set(cooldownKey, now);
  return false;
}

function bumpMetrics(state, message, detection) {
  // In-memory daily counters reset at UTC day boundary.
  const currentDay = getUtcDay();
  if (state.metrics.day !== currentDay) {
    state.metrics.day = currentDay;
    state.metrics.triggersToday = 0;
    state.metrics.byChannel.clear();
    state.metrics.byRule.clear();
  }

  state.metrics.triggersToday += 1;
  bumpCount(state.metrics.byChannel, message.channelId);
  for (const term of detection.matchedTerms) {
    bumpCount(state.metrics.byRule, `term:${term.toLowerCase()}`);
  }
  for (const signal of detection.matchedPriceSignals) {
    bumpCount(state.metrics.byRule, `price:${signal.toLowerCase()}`);
  }
}

function buildWarningMessage(config, detection, message) {
  // Build user guidance from the specific trigger(s), not a generic warning.
  const lines = [];
  const matchedTermSet = new Set(detection.matchedTerms.map((term) => term.toLowerCase()));
  const hasWordMatch = detection.triggerTypes.includes('word match');
  const hasPriceMatch = detection.triggerTypes.includes('price pattern');
  const channelLabel = message.channel?.name ? `#${message.channel.name}` : `<#${message.channelId}>`;

  if (matchedTermSet.has('sell')) {
    lines.push('Please use the word "rehome" instead.');
  } else if (hasWordMatch) {
    lines.push('Restricted terms are not allowed here. Please edit your message to remove them.');
  }

  if (hasPriceMatch) {
    lines.push(
      `Please refrain from using prices in ${channelLabel} and send prices only in DMs.`,
    );
  }

  if (lines.length === 0) {
    lines.push('Restricted terms/prices are not allowed here.');
    lines.push('Please edit your message to remove them.');
  }

  if (config.rulesUrl) {
    lines.push(`Rules: ${config.rulesUrl}`);
  }

  return lines.join('\n');
}

async function resolveModLogChannel(message, config, state) {
  // Lookup order:
  // 1) in-memory cache, 2) explicit channel ID, 3) channel-name fallback
  const cacheKey = message.guildId;
  const cachedChannelId = state.modLogChannelIds.get(cacheKey);
  if (cachedChannelId) {
    const cachedChannel = message.guild.channels.cache.get(cachedChannelId);
    if (cachedChannel && cachedChannel.type === ChannelType.GuildText) {
      return cachedChannel;
    }
  }

  if (config.modLogChannelId) {
    const channel = await message.guild.channels.fetch(config.modLogChannelId).catch(() => null);
    if (channel && channel.type === ChannelType.GuildText) {
      state.modLogChannelIds.set(cacheKey, channel.id);
      return channel;
    }
  }

  const allChannels = await message.guild.channels.fetch();
  const byName = allChannels.find(
    (channel) =>
      channel &&
      channel.type === ChannelType.GuildText &&
      channel.name.toLowerCase() === config.modLogChannelName,
  );

  if (byName) {
    state.modLogChannelIds.set(cacheKey, byName.id);
  }

  return byName || null;
}

function buildModLogMessage(message, detection, config, warningStatus, warningError, state) {
  // Keep log payload text-only and compact for quick moderator scanning.
  const topChannels = topEntries(state.metrics.byChannel)
    .map(([channelId, count]) => `<#${channelId}> (${count})`)
    .join(', ');
  const topRules = topEntries(state.metrics.byRule)
    .map(([rule, count]) => `${rule} (${count})`)
    .join(', ');

  const lines = [
    '**Rule Guardian Trigger**',
    `User: <@${message.author.id}> (\`${message.author.tag}\`)`,
    `Channel: <#${message.channelId}>`,
    `Timestamp: <t:${Math.floor(message.createdTimestamp / 1000)}:F>`,
    `Trigger type(s): ${detection.triggerTypes.join(', ')}`,
    `Jump link: ${message.url}`,
    `Warning status: ${warningStatus}`,
    `Daily trigger count: ${state.metrics.triggersToday}`,
    `Top channels today: ${topChannels || 'none'}`,
    `Top rules today: ${topRules || 'none'}`,
  ];

  if (config.logMatchedTerms) {
    const matchedEntries = [];
    if (detection.matchedTerms.length > 0) {
      matchedEntries.push(`terms=[${detection.matchedTerms.join(', ')}]`);
    }
    if (detection.matchedPriceSignals.length > 0) {
      matchedEntries.push(`price_signals=[${detection.matchedPriceSignals.join(', ')}]`);
    }

    if (matchedEntries.length > 0) {
      lines.push(`Matched: ${matchedEntries.join(' | ')}`);
    }
  }

  if (warningError) {
    lines.push(`Warning error: ${warningError}`);
  }

  return lines.join('\n');
}

async function sendModLog(message, detection, config, state, warningStatus, warningError) {
  // We still attempt mod logging even if user reply fails.
  try {
    const modLogChannel = await resolveModLogChannel(message, config, state);
    if (!modLogChannel) {
      console.error('Rule Guardian: mod-log channel not found. Configure RG_MOD_LOG_CHANNEL_ID or RG_MOD_LOG_CHANNEL_NAME.');
      return;
    }

    const content = buildModLogMessage(
      message,
      detection,
      config,
      warningStatus,
      warningError,
      state,
    );

    await modLogChannel.send({
      content,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error('Rule Guardian: failed to send mod-log message:', formatError(error));
  }
}

async function handleTriggeredMessage(message, detection, config, state) {
  // Reply can be suppressed by cooldown, but the event is still logged.
  const now = Date.now();
  const shouldSuppressWarning = isCoolingDown(state, message, config, now);
  let warningStatus = shouldSuppressWarning ? 'cooldown_suppressed' : 'sent';
  let warningError = '';

  if (!shouldSuppressWarning) {
    try {
      await message.reply({
        content: buildWarningMessage(config, detection, message),
        allowedMentions: { repliedUser: true },
      });
    } catch (error) {
      warningStatus = 'failed';
      warningError = formatError(error);
    }
  }

  await sendModLog(message, detection, config, state, warningStatus, warningError);
}

async function onMessageCreate(message, config, detectors, state) {
  // Main moderation pipeline for each live message event.
  if (!shouldProcessMessage(message, config)) {
    return;
  }

  const detection = detectContent(message.content || '', detectors, config);
  if (!detection.triggered) {
    return;
  }

  bumpMetrics(state, message, detection);
  await handleTriggeredMessage(message, detection, config, state);
}

export function startRuleGuardian() {
  // Bootstraps the live-message client used for moderation.
  const config = buildConfig();
  if (!config.enabled) {
    console.log('Rule Guardian is disabled. Set RG_ENABLED=true to enable it.');
    return null;
  }

  if (!process.env.DISCORD_TOKEN) {
    console.error('Rule Guardian not started: DISCORD_TOKEN is missing.');
    return null;
  }

  const detectors = buildDetectors(config);
  const state = {
    // In-memory storage for MVP-1 (resets on process restart).
    cooldowns: new Map(),
    modLogChannelIds: new Map(),
    metrics: {
      day: getUtcDay(),
      triggersToday: 0,
      byChannel: new Map(),
      byRule: new Map(),
    },
  };

  const client = new Client({
    intents: [
      // Required for server/channel metadata and message events.
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Required to read message.content; must be enabled in Developer Portal.
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    if (!client.user) {
      return;
    }

    console.log(`Rule Guardian connected as ${client.user.tag}`);
    console.log('Rule Guardian channel scope:', {
      ids: [...config.ruleChannelIds],
      names: [...config.ruleChannelNames],
      guildId: config.guildId || '(not set)',
    });
  });

  client.on('messageCreate', (message) => {
    // This is the live chat hook: every new guild message passes through here.
    void onMessageCreate(message, config, detectors, state);
  });

  client.on('error', (error) => {
    console.error('Rule Guardian client error:', formatError(error));
  });

  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('Rule Guardian login failed:', formatError(error));
  });

  return client;
}
