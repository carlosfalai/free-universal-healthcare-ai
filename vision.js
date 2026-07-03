'use strict';

// ─────────────────────────────────────────────────────────────
// vision.js — photo-based physical-exam findings for the free bot.
//
// Telegram already lets patients send photos. When a patient uploads
// one during a session (a rash, swelling, wound, deformity, an eye,
// a document / lab result), we run it through a vision model to get an
// OBJECTIVE DESCRIPTION of the visible findings — the way a clinician
// would chart an exam. That description is folded into the same
// multi-AI clinical reasoning as the text history, so the assessment
// reasons over what was SEEN plus what was SAID.
//
// Model: Claude Haiku 4.5 (vision, cheap, fast) via the Anthropic
// Messages API. Reference implementation — any vision model works;
// bring your own key (ANTHROPIC_API_KEY). If no key is set, the bot
// still runs text-only and simply tells the patient photos are off.
//
// COST (Haiku 4.5, $1 / $5 per MTok in/out, as of 2026-07):
//   Image tokens ≈ (width_px × height_px) / 750, capped ~1.15k–1.6k
//   tokens for a typical phone photo (long edge auto-capped 1568px on
//   Haiku). One exam photo + prompt + finding ≈ 1.6k in + 0.4k out
//   ≈ $0.0016 + $0.0020 ≈ well under half a cent per photo. Free-tier
//   friendly. (Opus/Sonnet high-res 2576px costs ~3× the image tokens;
//   Haiku stays at the 1568px tier — right tradeoff for OCR/triage.)
//
// SAFETY: describes findings, never diagnoses from the image alone;
// the diagnosis approximation is the council's job, over the WHOLE
// picture. No image is stored — bytes are held in memory for the one
// call and discarded. Nudity/graphic-wound photos are described
// clinically and neutrally; anything outside a medical context is
// declined by the model and we relay a plain message.
// ─────────────────────────────────────────────────────────────

const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const VISION_MODEL = process.env.VISION_MODEL || 'claude-haiku-4-5';
const visionEnabled = () => !!ANTHROPIC_API_KEY;

// System prompt: chart the exam, don't diagnose from the pixel alone.
const VISION_SYSTEM = `You are a clinical documentation assistant for a free medical-education tool. A patient has uploaded a photo during an educational health-history session. Your ONLY job is to describe, in neutral clinical language, what is objectively visible — the way a clinician charts a physical exam or reads a document. This is an EDUCATIONAL description, not a diagnosis.

If the image shows a body part / lesion / injury (rash, redness, swelling/edema, wound, bruise, deformity, asymmetry, discoloration, an eye, a nail, a bite, etc.), describe:
- location and extent (which area, how large relative to visible landmarks, unilateral vs bilateral if judgeable)
- morphology (macule/papule/plaque/vesicle/pustule/nodule/ulcer/crust/scale; flat vs raised; border definition)
- color and any color change (erythema, pallor, cyanosis, jaundice, hyperpigmentation, ecchymosis)
- swelling / deformity / asymmetry, and obvious signs of trauma (laceration, abrasion, obvious fracture angulation, missing tissue)
- distribution and pattern (linear, clustered, dermatomal, spreading border, target-like)
- any RED-FLAG appearance you can see (spreading erythema with a sharp advancing border, dusky/black tissue suggesting necrosis, pus/streaking suggesting infection, severe deformity, heavy active bleeding)

If the image is a DOCUMENT (lab result, prescription, imaging report, medication box), transcribe the clinically relevant text verbatim — values with units, drug names and doses, dates, reference ranges, and any flagged/abnormal markers.

Rules:
- Describe only what is visible. Do NOT state a diagnosis, do NOT name a disease as the cause, do NOT recommend treatment. The reasoning happens elsewhere over the full history.
- Be concise and factual — a chart entry, not prose.
- If the image is too blurry, dark, or cropped to assess, say exactly that and what a better photo would show.
- If the image is not medical (not a body part, injury, or medical document), respond with only: NOT_MEDICAL
- Never include the patient's identity even if a document shows a name — skip names, addresses, and ID numbers when transcribing.

Output plain text. Start with "VISIBLE FINDINGS:" for a body/injury photo, or "DOCUMENT CONTENTS:" for a document.`;

// Map a Telegram photo mime/extension to an Anthropic media_type.
function mediaTypeFor(pathOrMime) {
  const s = String(pathOrMime || '').toLowerCase();
  if (s.includes('png')) return 'image/png';
  if (s.includes('webp')) return 'image/webp';
  if (s.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}

// One vision call. imageBase64 = raw base64 (no data: prefix).
// Returns { ok, findings, notMedical, error }.
function describeImageOnce(imageBase64, mediaType, caption) {
  const userBlocks = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
  ];
  const captionText = caption && caption.trim()
    ? `The patient added this note with the photo: "${caption.trim()}". Use it only to orient which area to describe; still describe only what you see.`
    : 'Describe the clinically relevant visible findings.';
  userBlocks.push({ type: 'text', text: captionText });

  const body = JSON.stringify({
    model: VISION_MODEL,
    max_tokens: 1024,
    system: VISION_SYSTEM,
    messages: [{ role: 'user', content: userBlocks }],
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`Vision API error: ${parsed.error.message}`));
          if (parsed.stop_reason === 'refusal') return resolve({ ok: false, notMedical: true });
          const text = (parsed.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
          if (!text) return reject(new Error('Vision returned empty response'));
          if (/^NOT_MEDICAL/i.test(text)) return resolve({ ok: false, notMedical: true });
          resolve({ ok: true, findings: text });
        } catch (err) {
          reject(new Error(`Failed to parse vision response: ${err.message}`));
        }
      });
    });
    req.on('error', (err) => reject(new Error(`Network error calling vision: ${err.message}`)));
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Vision request timed out')); });
    req.write(body);
    req.end();
  });
}

// Retry wrapper — 2 attempts.
async function describeImage(imageBase64, mediaType, caption) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await describeImageOnce(imageBase64, mediaType, caption);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr;
}

// Download a Telegram file to a base64 string (in memory, never to disk).
function downloadTelegramFileBase64(botToken, filePath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Telegram file download failed: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

module.exports = { visionEnabled, describeImage, downloadTelegramFileBase64, mediaTypeFor, VISION_MODEL };
