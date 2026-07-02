# Securing the Data — the three ways to run this

The rule behind all of it: **the AI reasons over the case, never over the
person.** Identity and clinical content are kept distinct and separate. How
you enforce that depends on how you deploy.

## 1. Online forms / bots → pseudonymize with an alphanumeric identifier

If intake happens through forms or a hosted bot, generate an **alphanumeric
identifier** for each person and let ONLY that code travel with the clinical
content. The mapping between code and identity lives in one place you control
(we run ours from a Google Sheet) and is never sent to any AI API.

Google Sheets formula (one code per row):

```
=UPPER(DEC2HEX(RANDBETWEEN(0,4294967295),8))
```

or the JavaScript equivalent used by the bots:

```js
const pid = Array.from(crypto.getRandomValues(new Uint8Array(6)),
  b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');  // e.g. "K7M2Q9XR"
```

- The sheet holds: `code | name | contact`. Nothing else ever leaves it.
- Every AI call, every stored transcript, every council debate references the
  code only. Strip names, dates of birth, addresses, and ID numbers from free
  text BEFORE the API call.
- Re-identification happens only at the last step, by the human who owns the
  sheet.

## 2. Local → nothing to pseudonymize

If you run the system locally (the Phase-3 downloadable exe, or the bot on
your own machine talking to a local model), you don't need identifiers at
all — **keep everything local, like paper.** The record never leaves the
device; there is nothing to secure in transit because nothing transits. Only
de-identified case text goes out if and when you invoke the multi-AI council.

## 3. Prebuilt, verifiable systems

If you are a clinician, don't reinvent PHI custody: use a prebuilt system
that is already known and verifiable — **Spruce Health**, or a verifiable
EMR/DMR. Let that system hold identity and communications; this project's
AI layer works beside it on de-identified case content only.

## Tooling rules

- **Building with Claude Code?** Use **Claude Sonnet 5** (`claude-sonnet-5`)
  as the engine — near-Opus quality on coding and agentic work at Sonnet
  cost.
- **A doctor working with real patient data?** Run model calls through
  **AWS Bedrock** under a **BAA** (Business Associate Agreement). Bedrock
  serves the same Claude models with the compliance wrapper a working
  physician needs. Never send PHI to a consumer API endpoint.

## Costs by persona — pick your lane

Costs scale with your goals, revenue, and interest. Approximate monthly
figures at current API prices:

| Persona | Goal | Stack | Cost |
|---|---|---|---|
| **Patient with no access** | Get understood, get guidance | The free Telegram bots | **$0** — donations carry you |
| **Prepper / self-reliant** | Own your medical record offline | Local exe + local or DeepSeek-class model | **$0–5/mo** |
| **Student / builder** | Learn, fork, extend | Claude Code + Sonnet 5 | **$20–100/mo** (a Claude subscription covers most of it) |
| **Working physician** | Automate your practice, real PHI | AWS Bedrock BAA: Haiku de-identification + Sonnet 5 council + Textract OCR | **$50–300/mo** depending on volume (≈$0.01–0.05 per consultation) |
| **Clinic / organization** | Population-scale automation | Bedrock pipelines + verifiable EMR + physician verification layer | **$500+/mo**, scales with patients |

Every tier above "patient" funds the tier below it. That is the model.

Questions: cff@centremedicalfont.ca · support: https://instanthpi.ai/donations
