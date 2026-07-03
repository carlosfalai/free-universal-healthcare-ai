# Which AI models should I use? (medical performance + cost)

*"Which AI is good enough for health questions?"* is the most common thing
people ask. Here is the plain answer, updated periodically. **None of this
replaces a doctor — see one whenever you can.** But when you can't, use the
models that actually score highest on medical exams, and know what they cost.

## How AI models are scored on medicine

**MedQA** = US Medical Licensing Exam (USMLE) style questions. The bar to
keep in mind:

- **~60%** = the USMLE Step 1 pass threshold (a human passes here)
- **~80%+** = expert human physician level on MedQA
- The best AI models now score **90–96%** — above the human passing bar,
  and at or above expert level on the multiple-choice test.

A caveat that matters: scoring 93% still means being **wrong 7% of the time**,
and free-text clinical questions are harder than multiple choice. This is
exactly why our system never trusts one model — it runs a **council** that
must reach consensus and cite evidence. A wrong answer in medicine is a missed
diagnosis, not a lost point.

## Best models for medical use (MedQA / USMLE, 2026)

| Tier | Model | MedQA (USMLE) | Notes |
|---|---|---|---|
| Top | OpenAI o3 / o4-mini-high | ~95–96% | Reasoning models; highest MedQA scores recorded |
| Top | GPT-5 | ~93% | Strong all-round clinical + free-text |
| Top | Google Gemini 2.5 Pro | ~90–95% | Strong, widely available |
| Top | Anthropic Claude Opus (4.x) | ~91% | Excellent reasoning + instruction-following |
| Strong | GPT-4.1 | ~88% | Cheaper, still well above human pass bar |
| Strong | Claude Sonnet (4.x/5) | ~87% | Best value for building; what we use in Claude Code |
| Strong | DeepSeek R2 / V-series | ~85% | Cheapest capable option (~10x cheaper than the above) |
| Open/local | MedGemma 27B, Qwen 3.5 | ~82–84% | Run offline on your own machine (prepper / no-grid) |
| Open/local | OpenBioLLM-70B, MMed-Llama 3 | ~63–74% | Above human pass bar, fully local, free |

**Short answer for a patient asking "which one":** use **GPT-5, Gemini 2.5 Pro,
or Claude Opus** for the best single answer; use **DeepSeek** if cost matters;
run **MedGemma or Qwen locally** if you have no internet or want total privacy.
**Best of all — ask two or three of them the same question and see if they
agree.** Agreement is the signal; disagreement means get a human.

## What a consult actually costs

Prices are per **1 million tokens** (input / output). A full structured
consult (intake + reasoning + a written answer) is roughly **8,000–15,000
tokens** total — call it ~12k.

| Model | Price in/out (per 1M tok) | Cost of ONE full consult |
|---|---|---|
| DeepSeek | ~$0.30 / $1.20 | **~$0.01** (a penny) |
| GPT-4.1 / Gemini Flash class | ~$1 / $5 | **~$0.03** |
| Claude Sonnet / GPT-5 mini class | ~$3 / $15 | **~$0.10** |
| Claude Opus / GPT-5 / Gemini Pro | ~$5–10 / $25–50 | **~$0.20–0.40** |

### One AI vs. a council of multiple AIs

Our system runs a **council**: 2–3 models answer independently, then one model
compares them, surfaces disagreement, and writes a consensus with citations.

| Setup | Rough cost per consult |
|---|---|
| One cheap model (DeepSeek) | **~$0.01** |
| One strong model (Opus/GPT-5) | **~$0.20–0.40** |
| Council: 3 cheap models + 1 synthesis | **~$0.05** |
| Council: 3 strong models + 1 strong synthesis | **~$0.80–1.50** |
| **Recommended: 2 cheap + 1 strong + cheap synthesis** | **~$0.15–0.30** |

Two ways to cut it further, both built into the system:
- **Batch API (50% off)** when the answer isn't urgent → halves every number above.
- **Compress first:** on huge inputs (e.g. a 1,000-page record), cheap models
  summarize into a digest and only the digest goes to the expensive council —
  so cost scales with the *case*, not the page count.

**Bottom line:** a rigorous multi-AI consult that beats the human passing bar
costs **cents to about a dollar.** That is the whole premise of free universal
care — the intelligence is nearly free; the barrier is who controls access.

---

*Scores are approximate and move as new models ship (o3/o4, GPT-5, Gemini 2.5,
Claude Opus 4.x figures as of 2026). Always verify against a live leaderboard
before quoting exact numbers. Not medical advice.*

Sources: MedQA leaderboards at awesomeagents.ai, pricepertoken.com, llm-stats.com (2026).
