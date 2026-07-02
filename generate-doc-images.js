#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const GEMINI_KEY = process.env.GEMINI_API_KEY; // set your own key
const OUT_DIR = path.join(__dirname, 'assets');

const DOCS = [
  {
    name: 'doc-case-summary',
    prompt: 'A clean medical illustration of a patient handing a document folder to a doctor across a desk. The doctor is reviewing papers. Professional healthcare setting with soft teal and white colors. The concept of bringing medical information to discuss with your physician. Modern flat illustration style, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  },
  {
    name: 'doc-soap',
    prompt: 'A clean medical illustration of a clinical chart with three sections visible on a clipboard. A stethoscope next to it. Professional medical documentation concept. Soft teal and white healthcare palette. A doctor writing structured clinical notes. Modern flat illustration, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  },
  {
    name: 'doc-referral',
    prompt: 'A clean medical illustration showing a telemedicine screen connecting to a physical clinic. An arrow or pathway from a laptop screen to a hospital building. The concept of being referred from virtual consultation to in-person examination. Soft teal and white colors. Modern flat illustration, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  },
  {
    name: 'doc-prescription',
    prompt: 'A clean medical illustration of a prescription pad with pill bottles and medication tablets arranged around it. A pharmacist or doctor reviewing medications. Professional healthcare setting. Soft teal and white colors. The concept of medication information. Modern flat illustration, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  },
  {
    name: 'doc-imaging',
    prompt: 'A clean medical illustration of medical imaging equipment — an X-ray machine or CT scanner with a radiograph image displayed on a screen. A healthcare professional reviewing scan results. Soft teal and white colors. Modern flat illustration, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  },
  {
    name: 'doc-labs',
    prompt: 'A clean medical illustration of laboratory test tubes, blood vials, and a microscope on a lab bench. A lab technician analyzing samples. Professional medical laboratory setting. Soft teal and white colors. Modern flat illustration, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  },
  {
    name: 'doc-workleave',
    prompt: 'A clean medical illustration of a calendar with days marked off and a medical certificate document next to it. A person resting at home recovering. The concept of medical leave from work for recovery. Soft teal and white colors. Modern flat illustration, absolutely no text anywhere in the image, no words, no letters, no labels. 16:9 banner.'
  }
];

function generateImage(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.8 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message));
          const parts = p.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('image/')) {
              return resolve(Buffer.from(part.inlineData.data, 'base64'));
            }
          }
          reject(new Error('No image'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

async function main() {
  console.log('Generating 7 document images...\n');
  for (const doc of DOCS) {
    console.log(`${doc.name}...`);
    try {
      const buf = await generateImage(doc.prompt);
      fs.writeFileSync(path.join(OUT_DIR, `${doc.name}.png`), buf);
      console.log(`  OK (${(buf.length/1024).toFixed(0)} KB)`);
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
  }
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
