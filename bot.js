'use strict';

require('dotenv').config();
const path = require('path');

const express = require('express');

// Step images — sent at each stage to guide the patient
const STEP_IMAGES = {
  welcome: path.join(__dirname, 'assets', 'step1-welcome.png'),
  intake: path.join(__dirname, 'assets', 'step2-intake.png'),
  review: path.join(__dirname, 'assets', 'step3-review.png'),
  assessment: path.join(__dirname, 'assets', 'step4-assessment.png'),
  education: path.join(__dirname, 'assets', 'step5-education.png'),
  timeline: path.join(__dirname, 'assets', 'step6-timeline.png'),
  reasoning: path.join(__dirname, 'assets', 'step7-reasoning.png'),
  faq: path.join(__dirname, 'assets', 'step8-faq.png'),
};

// Cache Telegram file_ids after first send to avoid re-uploading
const imageFileIds = {};
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.get('/', (_req, res) => res.send('InstantHPI Bot is running'));
app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const { visionEnabled, describeImage, downloadTelegramFileBase64, mediaTypeFor } = require('./vision');
const { bedrockReasoningEnabled, converseText, REASONING_MODEL_ID } = require('./bedrock');
let trackStart, trackComplete, trackAbandonment, trackLanguageUpdate, getStats, getImpactStats, getImpactHistory, exportCSV;
try {
  const analytics = require('./analytics');
  trackStart = analytics.trackStart;
  trackComplete = analytics.trackComplete;
  trackAbandonment = analytics.trackAbandonment;
  trackLanguageUpdate = analytics.trackLanguageUpdate;
  getStats = analytics.getStats;
  getImpactStats = analytics.getImpactStats;
  getImpactHistory = analytics.getImpactHistory;
  exportCSV = analytics.exportCSV;
} catch (err) {
  console.warn('Analytics module failed to load:', err.message);
  const noop = () => ({});
  trackStart = trackComplete = trackAbandonment = trackLanguageUpdate = noop;
  getStats = getImpactStats = getImpactHistory = () => ({});
  exportCSV = () => '';
}
let generateDocumentsFromAssessment, sendDocuments;
try {
  const pdfGen = require('./pdf-generator');
  generateDocumentsFromAssessment = pdfGen.generateDocumentsFromAssessment;
  sendDocuments = pdfGen.sendDocuments;
} catch (err) {
  console.warn('PDF generator failed to load:', err.message);
  generateDocumentsFromAssessment = async () => [];
  sendDocuments = async () => {};
}

const {
  WELCOME_MESSAGE,
  ABOUT_MESSAGE,
  HELP_MESSAGE,
  RATE_LIMIT_MESSAGE,
  CANCEL_MESSAGE,
  LANGUAGE_PROMPT,
  DEEPSEEK_MODEL,
  DEEPSEEK_BASE_URL,
  HPI_AND_FOLLOWUP_SYSTEM,
  PHOTO_QUESTION_RULE,
  CLINICAL_REASONING_SYSTEM,
  INTAKE_QUESTIONS,
  COMPLETION_MESSAGE,
} = require('./prompts');

// ─────────────────────────────────────────────────────────────
// Config validation
// ─────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.INSTANTHPI_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID ? Number(process.env.ADMIN_USER_ID) : null;
const WEB_API_KEY = process.env.WEB_API_KEY || 'instanthpi-web-2026'; // Protect web endpoints

if (!BOT_TOKEN && process.env.WEB_ONLY !== 'true') {
  console.error('ERROR: INSTANTHPI_BOT_TOKEN is not set in your .env file');
  process.exit(1);
}

if (!DEEPSEEK_API_KEY) {
  console.error('ERROR: DEEPSEEK_API_KEY is not set in your .env file');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Session states
// language    → waiting for language selection
// idle        → waiting for /start
// intake      → going through the 18 OPQRST questions
// confirming  → showing HPI summary, waiting for yes/no
// followup    → asking 10 AI-generated follow-up questions
// processing  → generating clinical reasoning
// complete    → session done, waiting for /start
// ─────────────────────────────────────────────────────────────

// In-memory session store — keyed by Telegram user ID (number)
// Resets when bot restarts (by design — no data persistence)
const sessions = new Map();
const sessionLastActivity = new Map(); // userId → timestamp of last message

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle = abandoned

// Check for idle sessions every 2 minutes — warn at 25 min, expire at 30
const sessionWarned = new Set(); // track who got a warning
setInterval(() => {
  if (!bot) return;
  const now = Date.now();
  for (const [userId, lastActivity] of sessionLastActivity.entries()) {
    const idle = now - lastActivity;
    // Warn at 25 minutes
    if (idle > 25 * 60 * 1000 && !sessionWarned.has(userId)) {
      const session = sessions.get(userId);
      if (session && session.state !== 'complete') {
        sessionWarned.add(userId);
        bot.sendMessage(userId,
          'Your session will expire in 5 minutes. Send any message to keep it active, or type /questions to see your current questions.'
        ).catch(() => {});
      }
    }
    // Expire at 30 minutes
    if (idle > SESSION_TIMEOUT_MS) {
      const session = sessions.get(userId);
      if (session && session.state !== 'complete') {
        trackAbandonment(userId, session.state).catch(() => {});
        bot.sendMessage(userId, 'Your session expired. Send /start to begin a new one.').catch(() => {});
      }
      sessions.delete(userId);
      sessionLastActivity.delete(userId);
      sessionWarned.delete(userId);
    }
  }
}, 2 * 60 * 1000);

// Rate limiting — per user: 3 consultations per day, 10 min cooldown between
const lastConsultation = new Map();
const dailyCount = new Map();       // userId → { count, date }
const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 min cooldown between consultations
const MAX_PER_DAY = 3;              // 3 consultations per user per day

// Global abuse protection — no daily cap
let globalConsultationsToday = 0;
let globalDate = new Date().toDateString();
const GLOBAL_DAILY_CAP = Infinity;  // no global daily cap

// ─────────────────────────────────────────────────────────────
// Session factory
// ─────────────────────────────────────────────────────────────
function createSession() {
  return {
    state: 'language',
    language: 'en',
    currentQuestion: 0,          // index into INTAKE_QUESTIONS
    intakeAnswers: [],            // array of { question, answer } objects
    hpiSummary: '',               // the AI-generated HPI paragraph
    followupQuestions: [],        // array of 10 question strings
    currentFollowup: 0,           // index into followupQuestions
    followupAnswers: [],          // array of { question, answer } objects
    examFindings: [],             // array of vision-derived finding strings from uploaded photos
  };
}

// ─────────────────────────────────────────────────────────────
// Bot UI messages in multiple languages
// ─────────────────────────────────────────────────────────────
const UI_STRINGS = {
  generating_hpi: {
    en: 'Generating a summary of your history — one moment...',
    fr: 'Génération de votre résumé — un instant...',
    es: 'Generando un resumen de su historia — un momento...',
    pt: 'Gerando um resumo do seu histórico — um momento...',
    hi: 'आपका सारांश तैयार हो रहा है — एक पल...',
    ar: '...جاري إنشاء ملخص — لحظة واحدة',
  },
  confirm_or_correct: {
    en: 'If this summary is correct, answer all 10 questions below in ONE message.\nIf something is wrong, describe the correction instead.',
    fr: 'Si ce résumé est correct, répondez aux 10 questions ci-dessous en UN SEUL message.\nSi quelque chose est incorrect, décrivez la correction.',
    es: 'Si este resumen es correcto, responda las 10 preguntas a continuación en UN solo mensaje.\nSi algo está mal, describa la corrección.',
    pt: 'Se este resumo estiver correto, responda as 10 perguntas abaixo em UMA só mensagem.\nSe algo estiver errado, descreva a correção.',
    hi: 'अगर यह सारांश सही है, तो नीचे दिए 10 सवालों का जवाब एक ही संदेश में दें।\nअगर कुछ गलत है, तो सुधार बताएं।',
    ar: 'إذا كان هذا الملخص صحيحاً، أجب عن الأسئلة العشرة أدناه في رسالة واحدة.\nإذا كان هناك خطأ، صف التصحيح.',
  },
  updating_summary: {
    en: 'Updating your summary with corrections — one moment...',
    fr: 'Mise à jour de votre résumé — un instant...',
    es: 'Actualizando su resumen con correcciones — un momento...',
    pt: 'Atualizando seu resumo com correções — um momento...',
    hi: 'सुधार के साथ सारांश अपडेट हो रहा है — एक पल...',
    ar: '...جاري تحديث الملخص — لحظة',
  },
  confirm_updated: {
    en: 'If this updated summary is correct, answer all 10 questions below in ONE message.\nIf still wrong, describe the correction.',
    fr: 'Si ce résumé mis à jour est correct, répondez aux 10 questions ci-dessous en UN SEUL message.\nSi toujours incorrect, décrivez la correction.',
    es: 'Si este resumen actualizado es correcto, responda las 10 preguntas a continuación en UN solo mensaje.\nSi aún está mal, describa la corrección.',
    pt: 'Se este resumo atualizado estiver correto, responda as 10 perguntas em UMA só mensagem.\nSe ainda estiver errado, descreva a correção.',
    hi: 'अगर यह अपडेटेड सारांश सही है, तो 10 सवालों का जवाब एक संदेश में दें।',
    ar: 'إذا كان الملخص المحدث صحيحاً، أجب عن الأسئلة العشرة في رسالة واحدة.',
  },
  summary_confirmed: {
    en: 'Summary confirmed. Now answer the 10 follow-up questions above in one message.',
    fr: 'Résumé confirmé. Répondez maintenant aux 10 questions ci-dessus en un seul message.',
    es: 'Resumen confirmado. Ahora responda las 10 preguntas anteriores en un solo mensaje.',
    pt: 'Resumo confirmado. Agora responda as 10 perguntas acima em uma só mensagem.',
    hi: 'सारांश की पुष्टि हुई। अब ऊपर दिए 10 सवालों का जवाब एक संदेश में दें।',
    ar: '.تم تأكيد الملخص. أجب الآن عن الأسئلة العشرة أعلاه في رسالة واحدة',
  },
  generating_assessment: {
    en: 'All answers received. Generating your clinical assessment and documents — this may take up to 5 minutes...',
    fr: 'Toutes les réponses reçues. Génération de votre évaluation clinique et documents — cela peut prendre jusqu\'à 5 minutes...',
    es: 'Todas las respuestas recibidas. Generando su evaluación clínica y documentos — esto puede tomar hasta 5 minutos...',
    pt: 'Todas as respostas recebidas. Gerando sua avaliação clínica e documentos — pode levar até 5 minutos...',
    hi: 'सभी जवाब मिले। आपका क्लिनिकल मूल्यांकन तैयार हो रहा है — 5 मिनट तक लग सकते हैं...',
    ar: '...تم استلام جميع الإجابات. جاري إنشاء التقييم السريري — قد يستغرق 5 دقائق',
  },
  ai_error: {
    en: "I'm having trouble connecting to the AI service. Please try again.",
    fr: "J'ai du mal à me connecter au service IA. Veuillez réessayer.",
    es: 'Tengo problemas para conectar con el servicio de IA. Por favor, intente de nuevo.',
    pt: 'Estou com problemas para conectar ao serviço de IA. Por favor, tente novamente.',
    hi: 'AI सेवा से कनेक्ट करने में समस्या हो रही है। कृपया पुनः प्रयास करें।',
    ar: '.أواجه مشكلة في الاتصال بخدمة الذكاء الاصطناعي. يرجى المحاولة مرة أخرى',
  },
  reshow_followup: {
    en: 'Here are the 10 follow-up questions — answer them all in ONE message:',
    fr: 'Voici les 10 questions de suivi — répondez à toutes en UN SEUL message :',
    es: 'Aquí están las 10 preguntas de seguimiento — responda todas en UN solo mensaje:',
    pt: 'Aqui estão as 10 perguntas de acompanhamento — responda todas em UMA só mensagem:',
    hi: 'यहाँ 10 फॉलो-अप सवाल हैं — सभी का जवाब एक संदेश में दें:',
    ar: ':إليك الأسئلة العشرة — أجب عنها جميعاً في رسالة واحدة',
  },
};

// Get translated UI string based on session language
function ui(key, lang) {
  const l = (lang || 'en').toLowerCase();
  const entry = UI_STRINGS[key];
  if (!entry) return key;
  // Match by prefix: français/french → fr, español/spanish → es, etc.
  if (l.startsWith('fr') || l === 'français' || l === 'francais') return entry.fr || entry.en;
  if (l.startsWith('es') || l === 'español' || l === 'espanol') return entry.es || entry.en;
  if (l.startsWith('pt') || l === 'português' || l === 'portugues') return entry.pt || entry.en;
  if (l.startsWith('hi') || l === 'हिंदी') return entry.hi || entry.en;
  if (l.startsWith('ar') || l === 'العربية') return entry.ar || entry.en;
  return entry.en;
}

function getLangForHeaders(lang) {
  const l = (lang || 'en').toLowerCase();
  if (l.startsWith('fr') || l === 'français' || l === 'francais') return 'fr';
  if (l.startsWith('es') || l === 'español' || l === 'espanol') return 'es';
  if (l.startsWith('pt') || l === 'português' || l === 'portugues') return 'pt';
  if (l.startsWith('hi') || l === 'हिंदी') return 'hi';
  if (l.startsWith('ar') || l === 'العربية') return 'ar';
  return 'en';
}

// Send a step image — caches file_id after first upload for speed
async function sendStepImage(bot, chatId, stepName) {
  try {
    if (imageFileIds[stepName]) {
      await bot.sendPhoto(chatId, imageFileIds[stepName]);
    } else {
      const filePath = STEP_IMAGES[stepName];
      if (!filePath) return;
      const fs = require('fs');
      if (!fs.existsSync(filePath)) return;
      const result = await bot.sendPhoto(chatId, filePath);
      // Cache the file_id so we don't re-upload every time
      if (result?.photo?.length > 0) {
        imageFileIds[stepName] = result.photo[result.photo.length - 1].file_id;
      }
    }
  } catch (err) {
    // Image send failed — not critical, continue without it
    console.warn('Step image send failed:', stepName, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// DeepSeek API call (OpenAI-compatible format) with retry logic
// ─────────────────────────────────────────────────────────────
async function callDeepSeekOnce(systemPrompt, userContent, temperature = 0.7) {
  const body = JSON.stringify({
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature,
    max_tokens: 4096,
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/chat/completions', DEEPSEEK_BASE_URL);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`DeepSeek API error: ${parsed.error.message}`));
            return;
          }
          const content = parsed.choices?.[0]?.message?.content;
          if (!content) {
            reject(new Error('DeepSeek returned empty response'));
            return;
          }
          resolve(content.trim());
        } catch (err) {
          reject(new Error(`Failed to parse DeepSeek response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Network error calling DeepSeek: ${err.message}`));
    });

    req.setTimeout(300000, () => {
      req.destroy();
      reject(new Error('DeepSeek request timed out after 5 minutes'));
    });

    req.write(body);
    req.end();
  });
}

// Retry wrapper — 3 attempts with exponential backoff.
// When BEDROCK_REASONING=1 and AWS credentials are set, reasoning runs on
// DeepSeek V3.2 INSIDE the AWS BAA boundary (deepseek.v3.2, $0.62/$1.85 per
// MTok — data stays on AWS US infra) instead of DeepSeek's own API
// (cheaper: V4 Flash $0.14/$0.28, V4 Pro $0.435/$0.87 — but no BAA).
async function callDeepSeek(systemPrompt, userContent, temperature = 0.7) {
  if (bedrockReasoningEnabled()) {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await converseText(REASONING_MODEL_ID, systemPrompt, userContent, { maxTokens: 4096, temperature });
      } catch (err) {
        console.warn(`Bedrock reasoning attempt ${attempt} failed:`, err.message);
        if (attempt === MAX_RETRIES) throw err;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callDeepSeekOnce(systemPrompt, userContent, temperature);
    } catch (err) {
      console.error(`DeepSeek attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Sanitize text for Telegram Markdown — strip broken formatting
// AI-generated text often has unmatched * or _ that crash sendMessage
// ─────────────────────────────────────────────────────────────
function sanitizeForTelegram(text) {
  if (!text) return '';
  // Count asterisks — if odd, remove all markdown bold
  const asteriskCount = (text.match(/\*/g) || []).length;
  if (asteriskCount % 2 !== 0) {
    text = text.replace(/\*/g, '');
  }
  // Count underscores — if odd, remove all markdown italic
  const underscoreCount = (text.match(/_/g) || []).length;
  if (underscoreCount % 2 !== 0) {
    text = text.replace(/_/g, '');
  }
  return text;
}

// ─────────────────────────────────────────────────────────────
// Maps a language code to its full name for AI system prompts
// ─────────────────────────────────────────────────────────────
function getLanguageName(lang) {
  // Language is now stored as the user typed it — pass through directly
  return lang || 'English';
}

// ─────────────────────────────────────────────────────────────
// Format all intake Q&A into a single string for the AI
// ─────────────────────────────────────────────────────────────
function formatIntakeForAI(session) {
  return session.intakeAnswers
    .map((item, i) => `Q${i + 1}: ${item.question}\nA: ${item.answer}`)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────
// Format all follow-up Q&A into a string for the AI
// ─────────────────────────────────────────────────────────────
function formatFollowupForAI(session) {
  return session.followupAnswers
    .map((item, i) => `Follow-up Q${i + 1}: ${item.question}\nA: ${item.answer}`)
    .join('\n\n');
}

// ─────────────────────────────────────────────────────────────
// Split a long string into Telegram-safe chunks (max 4096 chars)
// ─────────────────────────────────────────────────────────────
function splitMessage(text, maxLength = 4096) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a double newline near the limit
    let splitAt = remaining.lastIndexOf('\n\n', maxLength);
    if (splitAt < maxLength * 0.5) {
      // No good double-newline — split at single newline
      splitAt = remaining.lastIndexOf('\n', maxLength);
    }
    if (splitAt < maxLength * 0.3) {
      // No good newline either — hard cut
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

// ─────────────────────────────────────────────────────────────
// Send a long message split into Telegram-safe chunks
// ─────────────────────────────────────────────────────────────
async function sendLongMessage(bot, chatId, text, options = {}) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    const sanitized = sanitizeForTelegram(chunk);
    try {
      await bot.sendMessage(chatId, sanitized, {
        parse_mode: 'Markdown',
        ...options,
      });
    } catch (mdErr) {
      // Markdown parsing failed — send as plain text
      await bot.sendMessage(chatId, sanitized.replace(/[*_`\[\]]/g, ''));
    }
  }
}

// Safe send for AI-generated content — tries Markdown, falls back to plain
async function safeSend(bot, chatId, text) {
  if (!text || !text.trim()) return;
  const sanitized = sanitizeForTelegram(text);
  try {
    await bot.sendMessage(chatId, sanitized, { parse_mode: 'Markdown' });
  } catch (_) {
    await bot.sendMessage(chatId, sanitized.replace(/[*_`\[\]]/g, ''));
  }
}

// ─────────────────────────────────────────────────────────────
// Parse the 10 follow-up questions from the AI response
// Returns an array of 10 strings
// ─────────────────────────────────────────────────────────────
function parseFollowupQuestions(aiResponse) {
  const lines = aiResponse.split('\n').filter((line) => line.trim());
  const questions = [];

  for (const line of lines) {
    // Match lines like "1. Question text" or "1) Question text"
    const match = line.match(/^\d+[\.\)]\s*(.+)/);
    if (match) {
      questions.push(match[1].trim());
    } else if (questions.length < 10 && line.trim().length > 10) {
      // Fallback: accept any non-empty line if we haven't got 10 yet
      questions.push(line.trim());
    }
    if (questions.length === 10) break;
  }

  // Safety: if AI returned fewer than 10, pad with generic questions
  const fallbacks = [
    'Do you have any fever or chills?',
    'Have you had any recent infections or illnesses?',
    'Do you have a family history of similar conditions?',
    'What is your occupation?',
    'Have you traveled recently?',
    'Do you smoke or use tobacco products?',
    'How much alcohol do you consume per week?',
    'Are you currently taking any prescription medications?',
    'Have you ever been hospitalized for anything similar?',
    'How is this affecting your daily activities?',
  ];

  while (questions.length < 10) {
    questions.push(fallbacks[questions.length]);
  }

  return questions.slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// Rate limit check
// ─────────────────────────────────────────────────────────────
function isRateLimited(userId) {
  // Check cooldown
  const last = lastConsultation.get(userId);
  if (last && Date.now() - last < RATE_LIMIT_MS) return 'cooldown';

  // Check daily per-user cap
  const today = new Date().toDateString();
  const userDaily = dailyCount.get(userId);
  if (userDaily && userDaily.date === today && userDaily.count >= MAX_PER_DAY) return 'daily';

  // Check global daily cap
  if (globalDate !== today) {
    globalDate = today;
    globalConsultationsToday = 0;
  }
  if (globalConsultationsToday >= GLOBAL_DAILY_CAP) return 'global';

  return false;
}

function getRateLimitRemaining(userId) {
  const last = lastConsultation.get(userId);
  if (!last) return 0;
  const elapsed = Date.now() - last;
  const remaining = Math.ceil((RATE_LIMIT_MS - elapsed) / 60000);
  return Math.max(0, remaining);
}

function recordConsultation(userId) {
  lastConsultation.set(userId, Date.now());
  const today = new Date().toDateString();
  const userDaily = dailyCount.get(userId);
  if (userDaily && userDaily.date === today) {
    userDaily.count++;
  } else {
    dailyCount.set(userId, { count: 1, date: today });
  }
  if (globalDate !== today) {
    globalDate = today;
    globalConsultationsToday = 0;
  }
  globalConsultationsToday++;
}

// ─────────────────────────────────────────────────────────────
// Start the bot (skip Telegram polling if WEB_ONLY mode)
// ─────────────────────────────────────────────────────────────
const WEB_ONLY = process.env.WEB_ONLY === 'true';
const bot = WEB_ONLY ? null : new TelegramBot(BOT_TOKEN, {
  polling: {
    interval: 300,        // wait 300ms between polls (prevents hammering)
    autoStart: true,
    params: { timeout: 30 } // long-poll: wait up to 30s for new messages
  }
});

if (WEB_ONLY) {
  console.log('WEB_ONLY mode — Telegram polling disabled, API-only.');
} else {
  console.log('InstantHPI Bot starting...');
  console.log('Polling mode active. Press Ctrl+C to stop.');
}

// ─────────────────────────────────────────────────────────────
// Telegram bot handlers (only if not WEB_ONLY mode)
// ─────────────────────────────────────────────────────────────
if (bot) {

// /start — begin new consultation
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Check rate limits
  const limitType = isRateLimited(userId);
  if (limitType === 'cooldown') {
    const mins = getRateLimitRemaining(userId);
    await bot.sendMessage(chatId,
      `Please wait ${mins} minute${mins !== 1 ? 's' : ''} before starting a new session.`
    );
    return;
  }
  if (limitType === 'daily') {
    await bot.sendMessage(chatId,
      `You have reached the maximum of ${MAX_PER_DAY} sessions per day. Please come back tomorrow.`
    );
    return;
  }
  if (limitType === 'global') {
    await bot.sendMessage(chatId,
      'The service is at capacity for today. Please try again tomorrow. This keeps the service free for everyone.'
    );
    return;
  }

  // Create a fresh session — start with language selection
  sessions.set(userId, createSession());
  sessionLastActivity.set(userId, Date.now());

  // Track session start (language filled in after language selection)
  trackStart(userId, null).catch(() => {});

  await sendStepImage(bot, chatId, 'welcome');
  await bot.sendMessage(chatId, LANGUAGE_PROMPT);
});

// ─────────────────────────────────────────────────────────────
// /stop and /cancel — cancel consultation
// ─────────────────────────────────────────────────────────────
bot.onText(/\/(stop|cancel)/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const session = sessions.get(userId);
  if (session && session.state !== 'complete') {
    trackAbandonment(userId, session.state).catch(() => {});
  }

  sessions.delete(userId);
  sessionLastActivity.delete(userId);
  await bot.sendMessage(chatId, CANCEL_MESSAGE, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────
// /about
// ─────────────────────────────────────────────────────────────
bot.onText(/\/about/, async (msg) => {
  await bot.sendMessage(msg.chat.id, ABOUT_MESSAGE, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────
// /help
// ─────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, HELP_MESSAGE, { parse_mode: 'Markdown' });
});

// ─────────────────────────────────────────────────────────────
// /questions — re-show whatever questions are active right now
// ─────────────────────────────────────────────────────────────
bot.onText(/\/questions/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = sessions.get(userId);
  if (!session) {
    await bot.sendMessage(chatId, 'No active session. Send /start to begin.');
    return;
  }
  if (session.state === 'intake') {
    const questions = INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await bot.sendMessage(chatId, `Answer these 18 questions in ONE message:\n\n${questions}`);
  } else if (session.state === 'followup') {
    const questions = session.followupQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await bot.sendMessage(chatId, `Answer these 10 follow-up questions in ONE message:\n\n${questions}`);
  } else if (session.state === 'confirming') {
    await bot.sendMessage(chatId, 'Waiting for you to confirm the summary above. Reply yes to continue, or describe corrections.');
  } else if (session.state === 'processing') {
    await bot.sendMessage(chatId, 'Still generating your assessment. Please wait...');
  } else {
    await bot.sendMessage(chatId, 'Session complete. Send /start for a new one.');
  }
});

// ─────────────────────────────────────────────────────────────
// /language — reset to language selection at any point
// ─────────────────────────────────────────────────────────────
bot.onText(/\/language/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = sessions.get(userId);
  if (session) {
    session.state = 'language';
    session.language = 'en';
    sessionLastActivity.set(userId, Date.now());
    await bot.sendMessage(chatId, LANGUAGE_PROMPT);
  } else {
    await bot.sendMessage(chatId, 'Send /start to begin a new session, then choose your language.');
  }
});

// ─────────────────────────────────────────────────────────────
// /stats — admin only
// ─────────────────────────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (ADMIN_USER_ID && userId !== ADMIN_USER_ID) {
    await bot.sendMessage(chatId, 'Not authorized.');
    return;
  }

  try {
    const s = await getStats();
    const langs = Object.entries(s.languages)
      .map(([l, c]) => `  ${l}: ${c}`)
      .join('\n') || '  none yet';

    const text = [
      '*InstantHPI Bot Stats*',
      '',
      `Total consultations: ${s.total}`,
      `Completed: ${s.completed} (${s.completion_rate})`,
      `Unique users: ${s.unique_users}`,
      '',
      `Today: ${s.today}`,
      `This month: ${s.monthly}`,
      `This year: ${s.yearly}`,
      '',
      '*Languages:*',
      langs,
    ].join('\n');

    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(chatId, 'Error fetching stats.');
  }
});

// ─────────────────────────────────────────────────────────────
// HANDLER: photo / image-document upload
// Vision model reads the picture, returns objective exam findings,
// and we store them on the session so the clinical reasoning sees
// what the patient LOOKS like, not only what they typed.
// ─────────────────────────────────────────────────────────────
async function handlePhoto(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = sessions.get(userId);

  if (!session) {
    await bot.sendMessage(chatId, 'Send /start to begin a free medical education session, then you can add a photo of the affected area.');
    return;
  }
  sessionLastActivity.set(userId, Date.now());
  sessionWarned.delete(userId);

  if (!visionEnabled()) {
    await bot.sendMessage(chatId, 'Photo analysis is not enabled on this bot. Please describe what you see in words and continue with the questions.');
    return;
  }

  // Resolve the best file: largest photo size, or the image document.
  let fileId, mimeHint = 'image/jpeg';
  if (msg.photo && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // highest resolution
  } else if (msg.document) {
    fileId = msg.document.file_id;
    mimeHint = msg.document.mime_type || 'image/jpeg';
  }

  await bot.sendChatAction(chatId, 'typing');
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
  try {
    const file = await bot.getFile(fileId);
    const b64 = await downloadTelegramFileBase64(BOT_TOKEN, file.file_path);
    const mediaType = mediaTypeFor(file.file_path || mimeHint);
    const result = await describeImage(b64, mediaType, msg.caption || '');

    if (!result.ok && result.notMedical) {
      await bot.sendMessage(chatId, 'That photo doesn\'t look like a medical image (a body part, injury, or medical document). If you meant to show the affected area, please try again with a clear, well-lit photo.');
      return;
    }
    if (!result.ok || !result.findings) {
      await bot.sendMessage(chatId, 'I couldn\'t read that photo. Please continue with the questions; you can try another photo any time.');
      return;
    }

    session.examFindings = session.examFindings || [];
    session.examFindings.push(result.findings);

    const preface = /^DOCUMENT/i.test(result.findings)
      ? 'I read your document. This will be included in your assessment:'
      : 'I noted these visible findings from your photo. They will be included in your assessment:';
    await bot.sendMessage(chatId, `─────────────────────────────\n${preface}\n\n${result.findings}\n─────────────────────────────\nThis is an educational description, not a diagnosis. Please continue answering the questions — you can add more photos any time.`);
  } catch (err) {
    console.error('Photo handling failed:', err.message);
    await bot.sendMessage(chatId, 'I had trouble reading that photo. Please continue with the questions; you can try another photo any time.');
  } finally {
    clearInterval(typingInterval);
    sessionLastActivity.set(userId, Date.now());
  }
}

// ─────────────────────────────────────────────────────────────
// Main message handler — routes based on session state
// ─────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  // Ignore commands — they are handled by onText above
  if (msg.text && msg.text.startsWith('/')) return;

  // PHOTO UPLOAD — a patient sent a picture of the affected area (rash,
  // swelling, wound, deformity, an eye) or a document (lab/prescription).
  // Run it through the vision model to get objective exam findings and
  // fold them into the clinical reasoning. Telegram already delivers the
  // photo; we just read it. Documents sent as files also carry msg.document.
  if (msg.photo || (msg.document && /^image\//.test(msg.document.mime_type || ''))) {
    await handlePhoto(bot, msg);
    return;
  }

  // Ignore other non-text messages (stickers, voice, etc.)
  if (!msg.text) {
    await bot.sendMessage(msg.chat.id,
      'Please send a text message, or a photo of the affected area (rash, swelling, wound) or a document (lab result, prescription).'
    );
    return;
  }

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const userText = msg.text.trim();

  // Update last activity timestamp for timeout tracking
  sessionLastActivity.set(userId, Date.now());
  sessionWarned.delete(userId); // Clear timeout warning since user is active

  let session = sessions.get(userId);

  // No active session — prompt to start
  if (!session) {
    await bot.sendMessage(chatId,
      'Send /start to begin a free medical education session.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Route by state
  switch (session.state) {
    case 'language':
      await handleLanguage(bot, chatId, userId, session, userText);
      break;

    case 'intake':
      await handleIntake(bot, chatId, userId, session, userText);
      break;

    case 'confirming':
      await handleConfirmation(bot, chatId, userId, session, userText);
      break;

    case 'followup':
      await handleFollowup(bot, chatId, userId, session, userText);
      break;

    case 'processing':
      // Ignore messages while processing
      await bot.sendMessage(chatId,
        'Please wait — I\'m generating your clinical assessment...'
      );
      break;

    case 'complete':
      await bot.sendMessage(chatId,
        'Your session is complete. Send /start to begin a new one.',
        { parse_mode: 'Markdown' }
      );
      break;

    default:
      // Unknown state — reset
      sessions.delete(userId);
      await bot.sendMessage(chatId,
        'Something went wrong. Send /start to begin again.'
      );
  }
});

// ─────────────────────────────────────────────────────────────
// HANDLER: language state
// User picks their preferred language before the intake begins
// ─────────────────────────────────────────────────────────────
async function handleLanguage(bot, chatId, userId, session, answer) {
  const t = answer.trim();

  // Accept ANY language — just store what they typed
  if (t.length < 2) {
    await bot.sendMessage(chatId,
      'Please type the name of your language (e.g., English, Français, Kiswahili, Tagalog, বাংলা, Yoruba...)'
    );
    return;
  }

  // Store the language exactly as they typed it — DeepSeek will use it
  session.language = t;
  session.state = 'intake';

  trackLanguageUpdate(userId, t).catch(() => {});

  await sendStepImage(bot, chatId, 'intake');

  // Check if the language is a known non-English language — translate the questions
  const knownLangs = {
    'français': true, 'french': true, 'francais': true,
    'español': true, 'spanish': true, 'espanol': true,
    'português': true, 'portuguese': true, 'portugues': true,
    'hindi': true, 'हिंदी': true,
    'arabic': true, 'العربية': true,
    'kiswahili': true, 'tagalog': true, 'yoruba': true,
    'chinese': true, '中文': true, 'japanese': true, '日本語': true,
    'german': true, 'deutsch': true, 'italian': true, 'italiano': true,
    'russian': true, 'русский': true, 'korean': true, '한국어': true,
    'turkish': true, 'bengali': true, 'বাংলা': true,
  };

  // Detect English in all common forms — skip translation for English
  const englishForms = ['english', 'eng', 'en', 'inglés', 'ingles', 'anglais', 'inglese', 'inglês'];
  const isEnglish = englishForms.includes(t.toLowerCase());

  if (!isEnglish && (knownLangs[t.toLowerCase()] || true)) {
    // Translate questions using DeepSeek
    await bot.sendChatAction(chatId, 'typing');
    try {
      const translatePrompt = `Translate the following medical intake instructions and 18 questions into ${t}. Keep the numbered format. Output ONLY the translated text, nothing else.

This is a free medical education tool (not a doctor). Answer all 18 questions in one message — numbered, commas, or paragraph:

1. Gender?
2. Age?
3. What brings you here today?
4. When did this problem start?
5. Was there a specific trigger?
6. Where is the symptom located?
7. How would you describe it? (sharp, dull, burning, pressure, etc.)
8. What makes it worse?
9. What relieves it?
10. Severity 0-10?
11. How has it evolved over time?
12. Any other symptoms alongside this?
13. Treatments or remedies tried?
14. Were they effective? (N/A if none tried)
15. Chronic conditions? (None if none)
16. Medication allergies? (None if none)
17. Pregnant or breastfeeding? (N/A if not applicable)
18. Anything else we should know? (None if nothing)`;
      const translated = await callDeepSeek(translatePrompt, '', 0.3);
      await bot.sendMessage(chatId, translated);
    } catch (err) {
      // Translation failed — fall back to English
      console.error('Translation failed:', err.message);
      await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: 'Markdown' });
    }
  } else {
    await bot.sendMessage(chatId, WELCOME_MESSAGE, { parse_mode: 'Markdown' });
  }
}

// ─────────────────────────────────────────────────────────────
// HANDLER: intake state
// Patient sends ALL 18 answers in one message
// ─────────────────────────────────────────────────────────────
async function handleIntake(bot, chatId, userId, session, answer) {
  const lower = answer.toLowerCase().trim();

  // Detect language change attempt — common languages typed as short words
  const langNames = ['english', 'french', 'francais', 'français', 'spanish', 'español', 'portuguese', 'português', 'hindi', 'arabic', 'kiswahili', 'tagalog', 'yoruba', 'chinese', 'japanese', 'german', 'italian', 'russian', 'korean', 'turkish', 'dutch', 'polish', 'swedish', 'bengali'];
  if (langNames.includes(lower)) {
    session.language = answer.trim();
    session.state = 'intake';
    await bot.sendMessage(chatId, `Language set to ${answer.trim()}. Now answer the 18 questions below in ONE message.`);
    const questions = INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await bot.sendMessage(chatId, questions);
    return;
  }

  // Detect confused users — re-show questions
  const confusedPhrases = ['what question', 'what do i', 'what should', 'how do i', 'help', 'huh', '?', 'i dont understand', "i don't understand", 'confused', 'start over', 'restart', 'what', 'que', 'quoi', 'comment', 'hi', 'hello', 'hey', 'bonjour', 'hola'];
  const isConfused = confusedPhrases.some(p => lower === p || lower.startsWith(p));

  if (isConfused || answer.length < 20) {
    const questions = INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await bot.sendMessage(chatId,
      `Answer these 18 questions in ONE message (numbered, commas, or paragraph):\n\n${questions}`
    );
    return;
  }

  // Store the raw text — AI will parse it
  session.rawIntake = answer;

  // Build Q&A context for the AI using the raw text
  const questionsFormatted = INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
  session.intakeForAI = `Here are the 18 intake questions:\n${questionsFormatted}\n\nPatient's answers (may be in any format — comma-separated, paragraph, numbered, etc.):\n${answer}`;

  // Generate HPI summary
  session.state = 'processing';
  await bot.sendChatAction(chatId, 'typing');
  await bot.sendMessage(chatId,
    ui('generating_hpi', session.language)
  );

  try {
    const langInstruction = `\n\nIMPORTANT: Respond entirely in ${getLanguageName(session.language)}. The patient speaks this language.`;
    // Keep sending typing indicator during long AI calls
    const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
    const intakeWithExam = (session.examFindings && session.examFindings.length)
      ? session.intakeForAI + '\n\n=== EXAM FINDINGS FROM PATIENT PHOTOS (objective) ===\n' +
        session.examFindings.map((f, i) => `Photo ${i + 1}:\n${f}`).join('\n\n') +
        '\nUse these visible findings to ask sharper, more targeted follow-up questions.'
      : session.intakeForAI;
    let combined;
    try {
      combined = await callDeepSeek(HPI_AND_FOLLOWUP_SYSTEM + (visionEnabled() ? PHOTO_QUESTION_RULE : '') + langInstruction, intakeWithExam, 0.6);
    } finally {
      clearInterval(typingInterval);
      sessionLastActivity.set(userId, Date.now()); // Refresh timer after long AI call
    }

    // Robust marker parsing — check if marker exists, fallback if missing
    let hpiPart, followupPart;
    if (combined.includes('---FOLLOWUP---')) {
      const parts = combined.split('---FOLLOWUP---');
      hpiPart = (parts[0] || '').trim();
      followupPart = (parts[1] || '').trim();
    } else {
      // Fallback: look for numbered questions pattern
      const questionMatch = combined.match(/\n\s*1[\.\)]\s+.+/);
      if (questionMatch) {
        const idx = combined.indexOf(questionMatch[0]);
        hpiPart = combined.substring(0, idx).trim();
        followupPart = combined.substring(idx).trim();
      } else {
        // Last resort: use entire response as HPI, generate generic follow-ups
        hpiPart = combined.trim();
        followupPart = '';
        console.warn('WARNING: DeepSeek response missing ---FOLLOWUP--- marker');
      }
    }

    session.hpiSummary = hpiPart;
    session.followupQuestions = parseFollowupQuestions(followupPart);
    session.currentFollowup = 0;
    session.state = 'confirming';

    // Send HPI summary first, then clear instructions
    await sendStepImage(bot, chatId, 'review');
    await safeSend(bot, chatId, hpiPart);

    const questionList = session.followupQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await bot.sendMessage(chatId,
      `─────────────────────────────\n` +
      ui('confirm_or_correct', session.language) + `\n` +
      `─────────────────────────────\n\n` +
      `${questionList}`
    );
  } catch (err) {
    console.error('HPI generation error:', err.message);
    session.state = 'intake';
    await bot.sendMessage(chatId, ui('ai_error', session.language));
  }
}

// ─────────────────────────────────────────────────────────────
// HANDLER: confirming state
// User reviews the HPI summary and confirms or corrects
// ─────────────────────────────────────────────────────────────
async function handleConfirmation(bot, chatId, userId, session, answer) {
  const lowerAnswer = answer.toLowerCase().trim();
  const isConfirmed = lowerAnswer === 'yes'
    || lowerAnswer === 'y'
    || lowerAnswer === 'correct'
    || lowerAnswer === 'ok'
    || lowerAnswer === 'okay'
    || lowerAnswer === 'oui'
    || lowerAnswer === 'yes, that\'s correct'
    || lowerAnswer.startsWith('yes,')
    || lowerAnswer.startsWith('yes.');

  // If the message is long (100+ chars), the patient is answering the follow-up questions
  // directly — treat as confirmed + skip straight to follow-up handler
  if (!isConfirmed && answer.length >= 100) {
    session.state = 'followup';
    return await handleFollowup(bot, chatId, userId, session, answer);
  }

  if (!isConfirmed) {
    // Patient wants corrections — regenerate
    session.state = 'processing';
    await bot.sendChatAction(chatId, 'typing');
    await bot.sendMessage(chatId, ui('updating_summary', session.language));

    try {
      const langInstruction = `\n\nIMPORTANT: Respond entirely in ${getLanguageName(session.language)}. The patient speaks this language.`;
      const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
      let combined;
      try {
        combined = await callDeepSeek(HPI_AND_FOLLOWUP_SYSTEM + (visionEnabled() ? PHOTO_QUESTION_RULE : '') + langInstruction,
          session.intakeForAI + `\n\nPatient correction: ${answer}`, 0.6);
      } finally {
        clearInterval(typingInterval);
        sessionLastActivity.set(userId, Date.now()); // Refresh timer after long AI call
      }

      // Robust marker parsing
      let hpiPart, followupPart;
      if (combined.includes('---FOLLOWUP---')) {
        const parts = combined.split('---FOLLOWUP---');
        hpiPart = (parts[0] || '').trim();
        followupPart = (parts[1] || '').trim();
      } else {
        const questionMatch = combined.match(/\n\s*1[\.\)]\s+.+/);
        if (questionMatch) {
          const idx = combined.indexOf(questionMatch[0]);
          hpiPart = combined.substring(0, idx).trim();
          followupPart = combined.substring(idx).trim();
        } else {
          hpiPart = combined.trim();
          followupPart = '';
        }
      }

      session.hpiSummary = hpiPart;
      session.followupQuestions = parseFollowupQuestions(followupPart);
      session.state = 'confirming';

      await safeSend(bot, chatId, session.hpiSummary);
      const questionList = session.followupQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
      await bot.sendMessage(chatId,
        `─────────────────────────────\n` +
        ui('confirm_updated', session.language) + `\n` +
        `─────────────────────────────\n\n` +
        `${questionList}`
      );
    } catch (err) {
      console.error('HPI regeneration error:', err.message);
      session.state = 'confirming';
      await bot.sendMessage(chatId,
        ui('ai_error', session.language)
      );
    }
    return;
  }

  // Confirmed — check if the answers are included in the same message
  // Patient might send "yes; answer1, answer2..." or "yes\nanswer1\nanswer2..."
  session.state = 'followup';

  // Strip the "yes" / "y" / "ok" prefix and check if there's substantial content after it
  const stripped = answer.replace(/^(yes[,;.\s]*|y[,;.\s]+|ok[,;.\s]+|okay[,;.\s]+|oui[,;.\s]+|correct[,;.\s]+)/i, '').trim();

  if (stripped.length >= 50) {
    // Answers are in the same message — process them directly
    return await handleFollowup(bot, chatId, userId, session, stripped);
  }

  // Just a simple "yes" — wait for answers in next message
  await bot.sendMessage(chatId,
    ui('summary_confirmed', session.language)
  );
}

// ─────────────────────────────────────────────────────────────
// HANDLER: followup state
// Collect answers to the 10 AI-generated follow-up questions
// ─────────────────────────────────────────────────────────────
async function handleFollowup(bot, chatId, userId, session, answer) {
  // If short or confused — RE-SHOW the 10 follow-up questions
  if (answer.length < 15) {
    const questionList = session.followupQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await bot.sendMessage(chatId,
      ui('reshow_followup', session.language) + `\n\n${questionList}`
    );
    return;
  }

  // Store raw follow-up answers for the AI
  session.rawFollowup = answer;
  const followupContext = session.followupQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  session.followupForAI = `Follow-up questions:\n${followupContext}\n\nPatient's answers:\n${answer}`;

  // Generate clinical reasoning
  session.state = 'processing';
  await bot.sendChatAction(chatId, 'typing');
  await bot.sendMessage(chatId,
    ui('generating_assessment', session.language)
  );

  let assessment = '';
  try {
    // Build the full context for the AI
    const examBlock = (session.examFindings && session.examFindings.length)
      ? ['', '=== PHYSICAL EXAM FINDINGS FROM PATIENT PHOTOS (objective, vision-derived) ===',
         'The patient uploaded photo(s). A vision model described the visible findings below. Treat these as OBJECTIVE EXAM data — weigh them together with the history to sharpen your differential and diagnosis approximation (e.g. rash morphology/spread, edema, trauma, deformity, wound signs, or transcribed document/lab values). Do not over-rely on a single image; reconcile it with the story.',
         session.examFindings.map((f, i) => `Photo ${i + 1}:\n${f}`).join('\n\n')].join('\n')
      : '';

    const fullContext = [
      '=== INTAKE HISTORY ===',
      session.intakeForAI || formatIntakeForAI(session),
      '',
      '=== HPI SUMMARY ===',
      session.hpiSummary,
      '',
      '=== FOLLOW-UP QUESTIONS & ANSWERS ===',
      session.followupForAI || formatFollowupForAI(session),
      examBlock,
    ].join('\n');

    const langInstruction = `\n\nIMPORTANT: Respond entirely in ${getLanguageName(session.language)}. The patient speaks this language.`;
    // Keep typing indicator alive during long AI call
    const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
    try {
      assessment = await callDeepSeek(CLINICAL_REASONING_SYSTEM + langInstruction, fullContext, 0.4);
    } finally {
      clearInterval(typingInterval);
      sessionLastActivity.set(userId, Date.now()); // Refresh timer after long AI call
    }
  } catch (err) {
    console.error('DeepSeek call failed:', err.message);
    session.state = 'followup'; // Reset to followup so user can retry
    await bot.sendMessage(chatId,
      ui('ai_error', session.language)
    );
    return;
  }

  // Parse sections — all with safe fallbacks
  try {
    const timelineMatch = assessment.split('---TIMELINE---')[1]?.split('---SUMMARY---')[0]?.trim() || '';
    const summaryMatch = assessment.split('---SUMMARY---')[1]?.split('---REASONING---')[0]?.trim() || '';
    const reasoningMatch = assessment.split('---REASONING---')[1]?.split('---SEVEN---')[0]?.trim() || '';
    const sevenRaw = assessment.split('---SEVEN---')[1] || '';
    const sevenMatch = sevenRaw.split('---DOCS---')[0]?.trim() || sevenRaw.split('---FAQ---')[0]?.trim() || '';
    const docsRaw = assessment.split('---DOCS---')[1] || '';
    const documentsMatch = docsRaw.split('---FAQ---')[0]?.trim() || '';
    const faqMatch = assessment.split('---FAQ---')[1]?.trim() || '';

    // If parsing totally failed (no markers found), send the raw response
    const parseFailed = !timelineMatch && !sevenMatch && !faqMatch;
    if (parseFailed) {
      console.warn('WARNING: Assessment missing all markers — sending raw');
      await sendLongMessage(bot, chatId, assessment);
    } else {
      // ── 1. #7 Patient message FIRST — with header ──
      await sendStepImage(bot, chatId, 'assessment');
      if (sevenMatch) {
        const lc = getLangForHeaders(session.language);
        const sevenHeaders = {
          en: 'Based on the information provided, this is what a doctor would tell you:',
          es: 'Según la información proporcionada, esto es lo que un médico le diría:',
          fr: 'Selon les informations fournies, voici ce qu\'un médecin vous dirait :',
          pt: 'Com base nas informações fornecidas, isto é o que um médico lhe diria:',
          hi: 'दी गई जानकारी के आधार पर, एक डॉक्टर आपको यह बताएगा:',
          ar: ':بناءً على المعلومات المقدمة، هذا ما سيخبرك به الطبيب',
        };
        await bot.sendMessage(chatId, `─────────────────────────────\n${sevenHeaders[lc] || sevenHeaders.en}`);
        await sendLongMessage(bot, chatId, sevenMatch);
      }

      // ── 2. PDF documents right after ──
      if (documentsMatch) {
        try {
          const pdfFiles = await generateDocumentsFromAssessment(sevenMatch, summaryMatch, session.hpiSummary, documentsMatch, session.language);
          if (pdfFiles.length > 0) {
            await sendDocuments(bot, chatId, pdfFiles, session.language);
          }
        } catch (pdfErr) {
          console.error('PDF generation error:', pdfErr.message);
        }
      }

      // ── 3. Educational section: summary → timeline → reasoning ──
      await sendStepImage(bot, chatId, 'education');
      if (summaryMatch || timelineMatch || reasoningMatch) {
        const lc = getLangForHeaders(session.language);
        const eduHeaders = {
          en: 'Educational summary of this case:',
          es: 'Resumen educativo de este caso:',
          fr: 'Résumé éducatif de ce cas :',
          pt: 'Resumo educativo deste caso:',
          hi: 'इस मामले का शैक्षिक सारांश:',
          ar: ':ملخص تعليمي لهذه الحالة',
        };
        await bot.sendMessage(chatId, `─────────────────────────────\n${eduHeaders[lc] || eduHeaders.en}`);
        if (summaryMatch) { await safeSend(bot, chatId, summaryMatch); }
        if (timelineMatch) {
          const tlHeaders = { en: 'Chronological Timeline:', es: 'Línea Cronológica:', fr: 'Chronologie :', pt: 'Linha do Tempo:', hi: 'कालानुक्रमिक समयरेखा:', ar: ':الجدول الزمني' };
          await sendStepImage(bot, chatId, 'timeline');
          await bot.sendMessage(chatId, tlHeaders[lc] || tlHeaders.en);
          await safeSend(bot, chatId, timelineMatch);
        }
        if (reasoningMatch) {
          const rrHeaders = { en: 'Clinical Reasoning:', es: 'Razonamiento Clínico:', fr: 'Raisonnement Clinique :', pt: 'Raciocínio Clínico:', hi: 'नैदानिक तर्क:', ar: ':التفكير السريري' };
          await sendStepImage(bot, chatId, 'reasoning');
          await bot.sendMessage(chatId, rrHeaders[lc] || rrHeaders.en);
          await safeSend(bot, chatId, reasoningMatch);
        }
      }

      // ── 4. FAQ last ──
      if (faqMatch) {
        await sendStepImage(bot, chatId, 'faq');
        await sendLongMessage(bot, chatId, faqMatch);
      }
    }

    // Send the completion footer — use safeSend for Markdown
    await safeSend(bot, chatId, COMPLETION_MESSAGE);

    // Mark session complete and record for rate limiting
    session.state = 'complete';
    recordConsultation(userId);
    await trackComplete(userId).catch(() => {});
  } catch (err) {
    console.error('Assessment output error:', err.message);
    // ALWAYS mark complete so user isn't stuck in processing forever
    session.state = 'complete';
    recordConsultation(userId);
    await bot.sendMessage(chatId,
      "There was an issue sending part of your assessment. Send /start to try a new session."
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────
// Global polling error handler (prevents process crash on
// Telegram network hiccups)
// ─────────────────────────────────────────────────────────────
bot.on('polling_error', (err) => {
  const msg = err.message || '';
  // Respect Telegram 429 rate limits — pause polling, then resume
  if (msg.includes('429')) {
    const match = msg.match(/retry after (\d+)/i);
    const wait = match ? parseInt(match[1], 10) * 1000 : 10000;
    console.error(`Polling 429 — pausing ${wait / 1000}s before retry`);
    bot.stopPolling().then(() => {
      setTimeout(() => bot.startPolling(), wait);
    }).catch(() => {
      setTimeout(() => bot.startPolling(), wait);
    });
    return;
  }
  // EFATAL / ECONNRESET — network hiccup, wait 5s then resume
  if (msg.includes('EFATAL') || msg.includes('ECONNRESET')) {
    console.error('Polling network error — resuming in 5s');
    bot.stopPolling().then(() => {
      setTimeout(() => bot.startPolling(), 5000);
    }).catch(() => {
      setTimeout(() => bot.startPolling(), 5000);
    });
    return;
  }
  console.error('Polling error:', msg);
});

bot.on('error', (err) => {
  console.error('Bot error:', err.message);
});

} // end if (bot) — Telegram handlers

// Catch unhandled rejections so the process doesn't crash
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message || err);
});

// ─────────────────────────────────────────────────────────────
// Additional HTTP routes (app already started at top of file)
// ─────────────────────────────────────────────────────────────
const startTime = Date.now();

app.get('/stats', (_req, res) => {
  try {
    res.json(getStats());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─────────────────────────────────────────────────────────────
// Web Chat API — stateless endpoints for the web version
// Protected by WEB_API_KEY to prevent abuse
// ─────────────────────────────────────────────────────────────
function checkWebApiKey(req, res) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== WEB_API_KEY) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return false;
  }
  return true;
}

// Simple per-IP rate limiter for web API (10 requests/min)
const webRateLimits = new Map();
function checkWebRateLimit(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const now = Date.now();
  const entry = webRateLimits.get(ip);
  if (entry && now - entry.start < 60000 && entry.count >= 10) {
    res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    return false;
  }
  if (!entry || now - entry.start >= 60000) {
    webRateLimits.set(ip, { start: now, count: 1 });
  } else {
    entry.count++;
  }
  return true;
}

app.post('/api/hpi', async (req, res) => {
  if (!checkWebApiKey(req, res)) return;
  if (!checkWebRateLimit(req, res)) return;
  try {
    const { intake, language } = req.body;
    if (!intake || intake.length < 20) return res.status(400).json({ error: 'Intake too short' });
    const lang = language || 'English';
    const questionsFormatted = INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
    const intakeForAI = `Here are the 18 intake questions:\n${questionsFormatted}\n\nPatient's answers:\n${intake}`;
    const langInstruction = `\n\nIMPORTANT: Respond entirely in ${lang}. The patient speaks this language.`;
    const combined = await callDeepSeek(HPI_AND_FOLLOWUP_SYSTEM + langInstruction, intakeForAI, 0.6);
    const parts = combined.split('---FOLLOWUP---');
    const hpiSummary = (parts[0] || '').trim();
    const followupQuestions = parseFollowupQuestions((parts[1] || '').trim());
    res.json({ hpiSummary, followupQuestions });
  } catch (err) {
    console.error('Web HPI error:', err.message);
    res.status(500).json({ error: 'AI service error. Please try again.' });
  }
});

app.post('/api/assess', async (req, res) => {
  if (!checkWebApiKey(req, res)) return;
  if (!checkWebRateLimit(req, res)) return;
  try {
    const { intake, hpiSummary, followupAnswers, language } = req.body;
    if (!intake || !hpiSummary || !followupAnswers) return res.status(400).json({ error: 'Missing data' });
    const lang = language || 'English';
    const questionsFormatted = INTAKE_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n');
    const fullContext = [
      '=== INTAKE HISTORY ===',
      `Here are the 18 intake questions:\n${questionsFormatted}\n\nPatient's answers:\n${intake}`,
      '',
      '=== HPI SUMMARY ===',
      hpiSummary,
      '',
      '=== FOLLOW-UP QUESTIONS & ANSWERS ===',
      followupAnswers,
    ].join('\n');
    const langInstruction = `\n\nIMPORTANT: Respond entirely in ${lang}. The patient speaks this language.`;
    const assessment = await callDeepSeek(CLINICAL_REASONING_SYSTEM + langInstruction, fullContext, 0.4);

    // Parse sections
    const timeline = assessment.split('---TIMELINE---')[1]?.split('---SUMMARY---')[0]?.trim() || '';
    const summary = assessment.split('---SUMMARY---')[1]?.split('---REASONING---')[0]?.trim() || '';
    const reasoning = assessment.split('---REASONING---')[1]?.split('---SEVEN---')[0]?.trim() || '';
    const sevenRaw = assessment.split('---SEVEN---')[1] || '';
    const patientMessage = sevenRaw.split('---DOCS---')[0]?.trim() || '';
    const docsRaw = assessment.split('---DOCS---')[1] || '';
    const documents = docsRaw.split('---FAQ---')[0]?.trim() || '';
    const faq = assessment.split('---FAQ---')[1]?.trim() || '';

    // Generate PDFs and return as base64
    const { generateDocumentsFromAssessment } = require('./pdf-generator');
    let pdfFiles = [];
    try {
      pdfFiles = await generateDocumentsFromAssessment(patientMessage, summary, hpiSummary, documents);
      // Convert files to base64 for web download
      const pdfs = pdfFiles.map(f => {
        const data = require('fs').readFileSync(f.path);
        const b64 = data.toString('base64');
        try { require('fs').unlinkSync(f.path); } catch(_) {}
        return { title: f.title, base64: b64 };
      });
      res.json({ timeline, summary, reasoning, patientMessage, faq, pdfs });
    } catch (pdfErr) {
      console.error('Web PDF error:', pdfErr.message);
      res.json({ timeline, summary, reasoning, patientMessage, faq, pdfs: [] });
    }
  } catch (err) {
    console.error('Web assess error:', err.message);
    res.status(500).json({ error: 'AI service error. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /impact — public impact stats (CORS enabled, 5-min cache)
// ─────────────────────────────────────────────────────────────
app.get('/impact', async (_req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    const stats = await getImpactStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch impact stats' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /impact/history?days=30 — daily chart data
// ─────────────────────────────────────────────────────────────
app.get('/impact/history', async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const history = await getImpactHistory(days);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch impact history' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /impact/export?format=csv&start=YYYY-MM-DD&end=YYYY-MM-DD
// Protected by admin key
// ─────────────────────────────────────────────────────────────
app.get('/impact/export', async (req, res) => {
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
  if (ADMIN_API_KEY && req.query.key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { format, start, end } = req.query;
    if (format === 'csv') {
      const csv = await exportCSV(start || null, end || null);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="instanthpi-impact.csv"');
      return res.send(csv);
    }
    const history = await getImpactHistory(365);
    res.json({ period: { start: start || null, end: end || null }, data: history });
  } catch (err) {
    res.status(500).json({ error: 'Export failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nShutting down InstantHPI Bot...');
  if (bot) bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down InstantHPI Bot...');
  if (bot) bot.stopPolling();
  process.exit(0);
});

console.log('Bot is running. Waiting for messages...');
