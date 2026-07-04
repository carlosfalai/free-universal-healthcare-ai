# WORK-STATE (session 2026-07-03, Claude)

## Goal
Free healthcare bot (this repo, live as @free_healthcare_education_bot / t.me/InstantHPIBot):
run photo OCR/exam-findings AND (optionally) reasoning inside Carlos's AWS BAA (acct 730335301855,
us-east-1 — same as casecheck-site) for low fees + compliance.

## Done (committed c4459fd + this work-in-progress)
- vision.js: Haiku vision exam-findings module (Anthropic API direct path), wired into bot.js:
  handlePhoto() -> session.examFindings -> folded into HPI/follow-up gen + final clinical reasoning.
  prompts.js welcome mentions photos. .env.example has ANTHROPIC_API_KEY.
- bedrock.js (NEW, just written): BAA backend. converseVision (Haiku 4.5
  us.anthropic.claude-haiku-4-5-20251001-v1:0) + converseText (deepseek.v3.2) via
  @aws-sdk/client-bedrock-runtime. Env: BEDROCK_AWS_* or AWS_* keys (exist in ~/.claude/.env),
  BEDROCK_REGION, BEDROCK_REASONING=1 opt-in.

## Remaining steps
1. vision.js: prefer Bedrock (bedrockAvailable()) over Anthropic-direct; visionEnabled() = bedrock OR anthropic key.
2. bot.js: in callDeepSeek wrapper, if bedrockReasoningEnabled() route to bedrock.converseText(REASONING_MODEL_ID,...)
   (keep DeepSeek direct as default; NOTE deepseek-reasoner name deprecates 2026-07-24 — swap prompts.js
   DEEPSEEK_MODEL to 'deepseek-chat'? verify before changing).
3. npm install @aws-sdk/client-bedrock-runtime (package.json).
4. node -c all files; commit+push (repo carlosfalai/free-universal-healthcare-ai, master).
5. Tell Carlos: deploy env needed on live bot host (host unknown — ASK: where does the live bot run?):
   AWS_ACCESS_KEY_ID/SECRET (BAA), BEDROCK_REGION=us-east-1, optional BEDROCK_REASONING=1; npm i.
6. Pricing answer (verified 2026-07): Haiku 4.5 = $1/$5 per MTok BOTH Anthropic direct AND Bedrock (BAA free).
   DeepSeek direct V4 Flash $0.14/$0.28, V4 Pro $0.435/$0.87 (NO BAA, China);
   Bedrock DeepSeek V3.2 $0.62/$1.85 (in-BAA). Vision photo ≈ $0.004 each.

## Other session context (all DONE + shipped)
- casecheck-site: benchmark scoreboard live; UsuryCheck /usury + CanadaCheck /canada live (b9444ac);
  Carlos's personal usury audit PDF delivered (~/usury-audit).
- instanthpi.ai/education/: 20-screenshot bot example gallery LIVE (repo instanthpi-web b295e00).
- Battery-guard crash restore done + auto-restore.ps1 patched.
