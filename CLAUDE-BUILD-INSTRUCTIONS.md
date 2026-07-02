# MASTER FILE — Build the Free Medical Healthcare Education Bot with Claude Code

This is the master instruction file. Give this whole repository to
[Claude Code](https://claude.com/claude-code) (or any capable coding agent) and
tell it: **"Follow CLAUDE-BUILD-INSTRUCTIONS.md and build my bot."** It will
recreate, exactly, the free medical healthcare education bot we run on
Telegram (@InstantHPIBot / @freehealtheducationbot) — including the images
that appear in the chat.

No programming knowledge is required from you. You supply two accounts and
paste two keys. The agent does the rest.

---

## What you need before starting (10 minutes, both free to create)

1. **A Telegram bot token.** In Telegram, message `@BotFather` → `/newbot` →
   pick a name and a handle → copy the token it gives you
   (looks like `1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).
2. **A model API key.** The reference build calls DeepSeek
   (https://platform.deepseek.com — cheap, works worldwide). Any
   OpenAI-compatible API also works (the agent can swap the endpoint for you:
   OpenAI, Groq, Together, a local Ollama server, etc.).
3. **Node.js 18+** installed (https://nodejs.org). The agent can verify this.

## Exact steps for Claude Code

Claude: follow these steps in order. Do not improvise the clinical logic —
it is already written and tested; your job is assembly and configuration.

### Step 1 — Install and configure
```bash
npm install
cp .env.example .env
```
Ask the user for their Telegram bot token and model API key; write them into
`.env` as `INSTANTHPI_BOT_TOKEN` and `DEEPSEEK_API_KEY`. Ask for their own
numeric Telegram user id (they can get it from `@userinfobot`) and set
`ADMIN_USER_ID`.

### Step 2 — Understand the architecture (read, don't rewrite)
- `bot.js` — everything: Telegram long-polling, the per-user state machine
  `idle → intake → confirming → followup → processing → complete`,
  the AI calls, PDF report generation, and the image sends.
- `prompts.js` — the clinical brain: `INTAKE_QUESTIONS` (the 18 canonical
  OPQRST intake questions) and every prompt used at each stage. The bot asks
  the questions ONE AT A TIME, skips what it already knows, then presents an
  HPI summary plus follow-up questions together, with a correction loop.
- `analytics.js` — aggregate-only metrics (no personal health information,
  ever). Keep it that way.
- `assets/` — the exact images the bot sends in chat:
  `step1-welcome.png … step8-faq.png` (the guided-flow cards) and
  `doc-*.png` (the document-type explainer cards). `bot.js` sends these at the
  matching steps and caches Telegram `file_id`s after first send.
- `generate-step-images.js` / `generate-doc-images.js` /
  `generate-header-images.js` — regenerate the images with any image API if
  the user wants their own branding (set `GEMINI_API_KEY` or port the calls to
  another image model). Using the shipped `assets/` as-is is fine and faster.

### Step 3 — Run it
```bash
node bot.js
```
Then message the bot on Telegram. Verify the flow end-to-end: `/start`,
answer the intake, receive the HPI summary, confirm, receive the report.

### Step 4 — Multi-agent consensus (the important part)
The reference `bot.js` calls one model. Upgrade it to the council pattern we
run in production:
- For each completed case, send the SAME de-identified case to 2+ different
  models (e.g. DeepSeek + one other).
- Have each answer independently, then pass both answers to one model with:
  "You are the council secretary. Compare these independent clinical
  assessments, surface any disagreement explicitly, and produce a consensus
  report. Each position must cite the medical study or guideline that
  supports it."
- The patient-facing output must say plainly that these are the answers of
  multiple AIs ("they offered and recommended…"), in the patient's own
  language, and must never pretend to be a single human.

### Step 5 — Privacy rules (non-negotiable)
- Strip names, exact dates of birth, addresses, and ID numbers from the text
  BEFORE any API call. The models reason over the case, not the person.
- Store nothing beyond what `analytics.js` already counts.
- Never log message contents.

### Step 6 — Keep it free
Run it on any $0–5/month box (a home machine works — it's long-polling, no
inbound ports needed). Expected model cost is under a cent per full
consultation with DeepSeek-class pricing.

---

## Safety rails (bake into any modification)
- Not for emergencies: on red-flag symptoms (chest pain, stroke signs, heavy
  bleeding, difficulty breathing) the bot must say "call your local emergency
  services now" and stop.
- Always recommend seeing a physical doctor whenever that is possible.
- Health education, not medical advice; no doctor-patient relationship.

## The mission, one line
Quality healthcare reasoning for everyone, for nearly no cost — universally.
Not just rich people and rich countries. Fork it, translate it, run it for
your population. Share your mods — they will be reviewed and the best ones
folded back in for everyone.

— Carlos Faviel Font, MD (board-certified family physician) · cff@centremedicalfont.ca
Support: https://instanthpi.ai/donations
