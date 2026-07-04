'use strict';

// ─────────────────────────────────────────────────────────────
// bedrock.js — optional AWS Bedrock backend (BAA boundary).
//
// If AWS credentials are configured, the bot can run its AI calls
// inside an AWS account covered by a signed HIPAA Business Associate
// Agreement instead of calling vendors directly:
//
//   • Vision / photo OCR  -> Claude Haiku 4.5 on Bedrock
//       us.anthropic.claude-haiku-4-5-20251001-v1:0
//       Same price as Anthropic direct ($1/$5 per MTok) — the BAA
//       compliance costs nothing extra.
//   • Reasoning (optional) -> DeepSeek V3.2 on Bedrock
//       deepseek.v3.2 ($0.62/$1.85 per MTok). More expensive than
//       DeepSeek direct ($0.14–0.44 in) but the data runs on AWS US
//       infrastructure inside the BAA and never reaches DeepSeek.
//       Enable with BEDROCK_REASONING=1.
//
// Env (any of these ways):
//   BEDROCK_AWS_ACCESS_KEY_ID / BEDROCK_AWS_SECRET_ACCESS_KEY
//   or the standard AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
//   BEDROCK_REGION (default us-east-1)
//   BEDROCK_VISION_MODEL / BEDROCK_REASONING_MODEL to override IDs
// ─────────────────────────────────────────────────────────────

const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const AK = process.env.BEDROCK_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || '';
const SK = process.env.BEDROCK_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || '';

const VISION_MODEL_ID = process.env.BEDROCK_VISION_MODEL || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const REASONING_MODEL_ID = process.env.BEDROCK_REASONING_MODEL || 'deepseek.v3.2';

let client = null;
let sdkMissing = false;
function getClient() {
  if (client || sdkMissing) return client;
  if (!AK || !SK) return null;
  try {
    const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
    client = new BedrockRuntimeClient({ region: REGION, credentials: { accessKeyId: AK, secretAccessKey: SK } });
  } catch (err) {
    sdkMissing = true;
    console.warn('Bedrock disabled — @aws-sdk/client-bedrock-runtime not installed:', err.message);
  }
  return client;
}

const bedrockAvailable = () => !!getClient();
const bedrockReasoningEnabled = () =>
  bedrockAvailable() && ['1', 'true', 'yes'].includes(String(process.env.BEDROCK_REASONING || '').toLowerCase());

// Text-only Converse call (used for BAA reasoning).
async function converseText(modelId, systemPrompt, userText, { maxTokens = 4096, temperature = 0.7 } = {}) {
  const c = getClient();
  if (!c) throw new Error('Bedrock is not configured');
  const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const cmd = new ConverseCommand({
    modelId,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages: [{ role: 'user', content: [{ text: userText }] }],
    inferenceConfig: { maxTokens, temperature },
  });
  const r = await c.send(cmd);
  const text = (r.output && r.output.message && r.output.message.content || [])
    .map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('Bedrock returned empty response');
  return text;
}

// Vision Converse call — image bytes + prompt through Haiku 4.5 in-BAA.
async function converseVision(systemPrompt, imageBase64, imageFormat, userText, { maxTokens = 1024 } = {}) {
  const c = getClient();
  if (!c) throw new Error('Bedrock is not configured');
  const { ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
  const bytes = Buffer.from(imageBase64, 'base64');
  const cmd = new ConverseCommand({
    modelId: VISION_MODEL_ID,
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages: [{
      role: 'user',
      content: [
        { image: { format: imageFormat, source: { bytes } } },
        { text: userText },
      ],
    }],
    inferenceConfig: { maxTokens, temperature: 0.2 },
  });
  const r = await c.send(cmd);
  const text = (r.output && r.output.message && r.output.message.content || [])
    .map((b) => b.text || '').join('').trim();
  if (!text) throw new Error('Bedrock vision returned empty response');
  return text;
}

module.exports = {
  bedrockAvailable,
  bedrockReasoningEnabled,
  converseText,
  converseVision,
  VISION_MODEL_ID,
  REASONING_MODEL_ID,
};
