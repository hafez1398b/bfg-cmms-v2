'use strict';

const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',
  jwtSecret: process.env.JWT_SECRET || 'bfg_dev_secret_change_me',
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:123@localhost:5432/bfg_cmms',
  nodeEnv: process.env.NODE_ENV || 'production',

  // AI provider configuration (Requirement #7)
  ai: {
    provider: (process.env.AI_PROVIDER || 'openai').toLowerCase(), // openai | anthropic | local | disabled
    endpoint: process.env.AI_ENDPOINT || 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '20000', 10),
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '1200', 10),
    enabled: (process.env.AI_ENABLED || 'true') === 'true',
  },

  // Realtime
  realtime: {
    pingTimeout: 20000,
    pingInterval: 25000,
  },

  // Security
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

function validateConfig() {
  const warnings = [];
  if (!config.jwtSecret || config.jwtSecret === 'your_secret_key_change_me' || config.jwtSecret === 'bfg_dev_secret_change_me') {
    warnings.push('JWT_SECRET is default — change it in production');
  }
  if (!config.ai.apiKey && config.ai.enabled && config.ai.provider !== 'disabled' && config.ai.provider !== 'local') {
    warnings.push(`AI provider "${config.ai.provider}" has no API key — AI will run in local-heuristic fallback mode`);
  }
  return warnings;
}

module.exports = { config, validateConfig };
