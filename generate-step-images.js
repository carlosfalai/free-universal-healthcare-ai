#!/usr/bin/env node
'use strict';

// Generate 5 step images for InstantHPI bot using Gemini (Nano Banana 2)
const https = require('https');
const fs = require('fs');
const path = require('path');

const GEMINI_KEY = process.env.GEMINI_API_KEY; // set your own key
const OUT_DIR = path.join(__dirname, 'assets');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const STEPS = [
  {
    name: 'step1-welcome',
    prompt: 'A warm, professional medical education illustration. A friendly AI medical assistant hologram greeting a patient through a phone screen. Soft teal and white color palette. Clean modern healthcare design. The scene shows a welcoming hand gesture from the AI. Text area at bottom for "Welcome". Flat illustration style, no text in the image, medical education theme. 16:9 aspect ratio banner.'
  },
  {
    name: 'step2-intake',
    prompt: 'A clean medical illustration showing a digital clipboard with numbered questions on a phone screen. A patient thoughtfully answering health questions. Soft teal and cyan colors with white background elements. Medical intake questionnaire concept. Stethoscope icon subtle in corner. Professional healthcare education style. Flat modern illustration, no text, 16:9 banner format.'
  },
  {
    name: 'step3-review',
    prompt: 'A medical education illustration showing an AI analyzing patient data on a holographic display. Clinical summary being reviewed with a checkmark. Doctor AI assistant presenting a summary for confirmation. Teal, cyan and white color scheme. Clean modern healthcare design. Shows the concept of reviewing and confirming medical history. Flat illustration, no text, 16:9 banner.'
  },
  {
    name: 'step4-assessment',
    prompt: 'A professional medical illustration showing an AI doctor presenting clinical assessment results. Multiple documents and PDF icons floating around. Prescription pad, referral letter, medical report icons. The concept of receiving a complete medical educational assessment. Teal and white healthcare palette. Modern flat illustration, no text, 16:9 banner format.'
  },
  {
    name: 'step5-education',
    prompt: 'A medical education illustration showing a patient learning from visual aids. Timeline chart, decision tree diagram, and FAQ bubbles displayed on screen. The concept of understanding your health condition through education. Books and learning icons. Teal, cyan and white medical theme. Modern flat illustration, no text, 16:9 banner format.'
  }
];

function generateImage(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE', 'TEXT'],
        temperature: 0.8,
      }
    });

    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          // Find image part in response
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
              return resolve(Buffer.from(part.inlineData.data, 'base64'));
            }
          }
          reject(new Error('No image in response'));
        } catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Generating 5 step images for InstantHPI bot...\n');

  for (const step of STEPS) {
    console.log(`Generating: ${step.name}...`);
    try {
      const imgBuffer = await generateImage(step.prompt);
      const outPath = path.join(OUT_DIR, `${step.name}.png`);
      fs.writeFileSync(outPath, imgBuffer);
      console.log(`  OK: ${outPath} (${(imgBuffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
    }
  }

  console.log('\nDone. Images saved to assets/');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
