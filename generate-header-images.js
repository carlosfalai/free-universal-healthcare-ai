#!/usr/bin/env node
'use strict';

// Generate 3 new header images for InstantHPI bot (steps 6-8)
const https = require('https');
const fs = require('fs');
const path = require('path');

const GEMINI_KEY = process.env.GEMINI_API_KEY; // set your own key
const OUT_DIR = path.join(__dirname, 'assets');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const STEPS = [
  {
    name: 'step6-timeline',
    prompt: 'A clean medical education illustration showing a horizontal chronological timeline. Medical events marked along the timeline with calendar icons, symptom progression dots, and small clinical milestone markers. A smooth curve showing health trajectory over time. Teal and cyan color palette with white background elements. Doctor reviewing timeline on a holographic display. Professional healthcare education style. Flat modern illustration, no text, 16:9 banner format.'
  },
  {
    name: 'step7-reasoning',
    prompt: 'A professional medical education illustration showing clinical diagnostic reasoning. A glowing brain with interconnected logical pathways and decision nodes. A flowchart branching from symptoms to diagnosis with checkpoints. Medical icons: stethoscope, magnifying glass, clipboard. Clean teal and cyan color scheme with white background. The concept of AI-assisted clinical decision making. Modern flat illustration, no text, 16:9 banner format.'
  },
  {
    name: 'step8-faq',
    prompt: 'A warm medical education illustration showing a question and answer concept. Speech bubbles with question marks and light bulb answer icons floating in a clean layout. A friendly AI medical assistant figure gesturing helpfully. A patient and doctor silhouette in dialogue. Soft teal, cyan and white color palette. Professional healthcare education style. FAQ and helpful guidance theme. Flat modern illustration, no text, 16:9 banner format.'
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
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
              return resolve(Buffer.from(part.inlineData.data, 'base64'));
            }
          }
          reject(new Error('No image in response. Full response: ' + data.slice(0, 500)));
        } catch(e) { reject(new Error('Parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Generating 3 new header images for InstantHPI bot...\n');

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
