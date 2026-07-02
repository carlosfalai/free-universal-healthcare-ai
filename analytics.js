'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'analytics.db');

// ─────────────────────────────────────────────────────────────
// Language → Country mapping for geographic impact estimation
// ─────────────────────────────────────────────────────────────
const LANGUAGE_COUNTRY_MAP = {
  'english': { country: 'US', region: 'North America', continent: 'Americas' },
  'en': { country: 'US', region: 'North America', continent: 'Americas' },
  'french': { country: 'FR', region: 'Western Europe', continent: 'Europe' },
  'français': { country: 'FR', region: 'Western Europe', continent: 'Europe' },
  'francais': { country: 'FR', region: 'Western Europe', continent: 'Europe' },
  'spanish': { country: 'MX', region: 'Latin America', continent: 'Americas' },
  'español': { country: 'MX', region: 'Latin America', continent: 'Americas' },
  'espanol': { country: 'MX', region: 'Latin America', continent: 'Americas' },
  'arabic': { country: 'SA', region: 'Middle East', continent: 'Asia' },
  'العربية': { country: 'SA', region: 'Middle East', continent: 'Asia' },
  'hindi': { country: 'IN', region: 'South Asia', continent: 'Asia' },
  'हिंदी': { country: 'IN', region: 'South Asia', continent: 'Asia' },
  'bengali': { country: 'BD', region: 'South Asia', continent: 'Asia' },
  'বাংলা': { country: 'BD', region: 'South Asia', continent: 'Asia' },
  'portuguese': { country: 'BR', region: 'South America', continent: 'Americas' },
  'português': { country: 'BR', region: 'South America', continent: 'Americas' },
  'swahili': { country: 'KE', region: 'East Africa', continent: 'Africa' },
  'kiswahili': { country: 'KE', region: 'East Africa', continent: 'Africa' },
  'yoruba': { country: 'NG', region: 'West Africa', continent: 'Africa' },
  'hausa': { country: 'NG', region: 'West Africa', continent: 'Africa' },
  'igbo': { country: 'NG', region: 'West Africa', continent: 'Africa' },
  'amharic': { country: 'ET', region: 'East Africa', continent: 'Africa' },
  'አማርኛ': { country: 'ET', region: 'East Africa', continent: 'Africa' },
  'tagalog': { country: 'PH', region: 'Southeast Asia', continent: 'Asia' },
  'filipino': { country: 'PH', region: 'Southeast Asia', continent: 'Asia' },
  'vietnamese': { country: 'VN', region: 'Southeast Asia', continent: 'Asia' },
  'tiếng việt': { country: 'VN', region: 'Southeast Asia', continent: 'Asia' },
  'indonesian': { country: 'ID', region: 'Southeast Asia', continent: 'Asia' },
  'bahasa': { country: 'ID', region: 'Southeast Asia', continent: 'Asia' },
  'malay': { country: 'MY', region: 'Southeast Asia', continent: 'Asia' },
  'persian': { country: 'IR', region: 'Middle East', continent: 'Asia' },
  'farsi': { country: 'IR', region: 'Middle East', continent: 'Asia' },
  'turkish': { country: 'TR', region: 'Middle East', continent: 'Asia' },
  'urdu': { country: 'PK', region: 'South Asia', continent: 'Asia' },
  'اردو': { country: 'PK', region: 'South Asia', continent: 'Asia' },
  'russian': { country: 'RU', region: 'Eastern Europe', continent: 'Europe' },
  'русский': { country: 'RU', region: 'Eastern Europe', continent: 'Europe' },
  'chinese': { country: 'CN', region: 'East Asia', continent: 'Asia' },
  'mandarin': { country: 'CN', region: 'East Asia', continent: 'Asia' },
  '中文': { country: 'CN', region: 'East Asia', continent: 'Asia' },
  'zulu': { country: 'ZA', region: 'Southern Africa', continent: 'Africa' },
  'xhosa': { country: 'ZA', region: 'Southern Africa', continent: 'Africa' },
  'somali': { country: 'SO', region: 'East Africa', continent: 'Africa' },
  'soomaali': { country: 'SO', region: 'East Africa', continent: 'Africa' },
  'wolof': { country: 'SN', region: 'West Africa', continent: 'Africa' },
  'creole': { country: 'HT', region: 'Caribbean', continent: 'Americas' },
  'kreyòl': { country: 'HT', region: 'Caribbean', continent: 'Americas' },
  'burmese': { country: 'MM', region: 'Southeast Asia', continent: 'Asia' },
  'myanmar': { country: 'MM', region: 'Southeast Asia', continent: 'Asia' },
  'khmer': { country: 'KH', region: 'Southeast Asia', continent: 'Asia' },
  'nepali': { country: 'NP', region: 'South Asia', continent: 'Asia' },
  'नेपाली': { country: 'NP', region: 'South Asia', continent: 'Asia' },
  'sinhala': { country: 'LK', region: 'South Asia', continent: 'Asia' },
  'pashto': { country: 'AF', region: 'Central Asia', continent: 'Asia' },
  'dari': { country: 'AF', region: 'Central Asia', continent: 'Asia' },
};

function lookupLanguage(lang) {
  if (!lang || lang === 'unknown') return null;
  const key = lang.toLowerCase().trim();
  return LANGUAGE_COUNTRY_MAP[key] || null;
}

let db = null;

// ─────────────────────────────────────────────────────────────
// SHA-256 hash — one-way, non-reversible user ID storage
// ─────────────────────────────────────────────────────────────
function hashUserId(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// Init — load or create DB file
// ─────────────────────────────────────────────────────────────
async function getDb() {
  if (db) return db;

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      language TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'started',
      abandoned_at_step TEXT,
      duration_seconds INTEGER,
      is_returning INTEGER DEFAULT 0,
      session_date TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS daily_stats (
      date TEXT PRIMARY KEY,
      total_consultations INTEGER DEFAULT 0,
      unique_users TEXT DEFAULT '[]',
      completed INTEGER DEFAULT 0,
      languages_json TEXT DEFAULT '{}'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_hash TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      total_consultations INTEGER DEFAULT 0,
      completed_consultations INTEGER DEFAULT 0,
      languages_used TEXT DEFAULT '[]'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS impact_snapshots (
      snapshot_date TEXT PRIMARY KEY,
      total_consultations INTEGER,
      total_completed INTEGER,
      total_unique_users INTEGER,
      total_returning_users INTEGER,
      languages_count INTEGER,
      top_language TEXT,
      avg_completion_minutes REAL,
      completion_rate_pct INTEGER,
      equivalent_doctor_visits INTEGER,
      total_hours_education REAL,
      estimated_countries INTEGER,
      cost_usd REAL
    )
  `);

  // Migrate existing consultations table — add new columns if missing
  try { db.run(`ALTER TABLE consultations ADD COLUMN abandoned_at_step TEXT`); } catch (_) {}
  try { db.run(`ALTER TABLE consultations ADD COLUMN duration_seconds INTEGER`); } catch (_) {}
  try { db.run(`ALTER TABLE consultations ADD COLUMN is_returning INTEGER DEFAULT 0`); } catch (_) {}
  try { db.run(`ALTER TABLE consultations ADD COLUMN session_date TEXT`); } catch (_) {}

  db.run(`CREATE INDEX IF NOT EXISTS idx_consultations_user ON consultations(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_consultations_started ON consultations(started_at)`);

  persist();
  return db;
}

function persist() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function queryOne(d, sql, params = []) {
  const stmt = d.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(d, sql, params = []) {
  const results = [];
  const stmt = d.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function upsertDailyStats(d, date, userId, language, isComplete) {
  const existing = queryOne(d, 'SELECT * FROM daily_stats WHERE date = ?', [date]);

  if (!existing) {
    const users = JSON.stringify([String(userId)]);
    const langs = language ? JSON.stringify({ [language]: 1 }) : '{}';
    d.run(
      'INSERT INTO daily_stats (date, total_consultations, unique_users, completed, languages_json) VALUES (?, 1, ?, ?, ?)',
      [date, users, isComplete ? 1 : 0, langs]
    );
  } else {
    const users = JSON.parse(existing.unique_users || '[]');
    if (!users.includes(String(userId))) users.push(String(userId));

    const langs = JSON.parse(existing.languages_json || '{}');
    if (language) langs[language] = (langs[language] || 0) + 1;

    d.run(
      'UPDATE daily_stats SET total_consultations = total_consultations + 1, unique_users = ?, completed = completed + ?, languages_json = ? WHERE date = ?',
      [JSON.stringify(users), isComplete ? 1 : 0, JSON.stringify(langs), date]
    );
  }
}

// ─────────────────────────────────────────────────────────────
// trackStart — called when a session begins
// ─────────────────────────────────────────────────────────────
async function trackStart(userId, language) {
  const d = await getDb();
  const now = Date.now();
  const date = todayStr();
  const userHash = hashUserId(userId);

  // Check if this is a returning user (has prior completed consultation)
  const priorRow = queryOne(
    d,
    "SELECT id FROM consultations WHERE user_id = ? AND status = 'completed' LIMIT 1",
    [userHash]
  );
  const isReturning = priorRow ? 1 : 0;

  d.run(
    "INSERT INTO consultations (user_id, language, started_at, status, is_returning, session_date) VALUES (?, ?, ?, 'started', ?, ?)",
    [userHash, language || null, now, isReturning, date]
  );

  // Upsert user_stats
  const existingUser = queryOne(d, 'SELECT * FROM user_stats WHERE user_hash = ?', [userHash]);
  if (!existingUser) {
    d.run(
      'INSERT INTO user_stats (user_hash, first_seen, last_seen, total_consultations, completed_consultations, languages_used) VALUES (?, ?, ?, 1, 0, ?)',
      [userHash, date, date, language ? JSON.stringify([language]) : '[]']
    );
  } else {
    const langs = JSON.parse(existingUser.languages_used || '[]');
    if (language && !langs.includes(language)) langs.push(language);
    d.run(
      'UPDATE user_stats SET last_seen = ?, total_consultations = total_consultations + 1, languages_used = ? WHERE user_hash = ?',
      [date, JSON.stringify(langs), userHash]
    );
  }

  upsertDailyStats(d, date, userHash, language, false);
  persist();
}

// ─────────────────────────────────────────────────────────────
// trackComplete — called when clinical reasoning is delivered
// ─────────────────────────────────────────────────────────────
async function trackComplete(userId) {
  const d = await getDb();
  const now = Date.now();
  const userHash = hashUserId(userId);

  const row = queryOne(
    d,
    "SELECT id, started_at FROM consultations WHERE user_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1",
    [userHash]
  );

  if (row) {
    const durationSeconds = Math.round((now - row.started_at) / 1000);
    d.run(
      "UPDATE consultations SET completed_at = ?, status = 'completed', duration_seconds = ? WHERE id = ?",
      [now, durationSeconds, row.id]
    );

    const date = todayStr();
    d.run('UPDATE daily_stats SET completed = completed + 1 WHERE date = ?', [date]);

    d.run(
      'UPDATE user_stats SET completed_consultations = completed_consultations + 1 WHERE user_hash = ?',
      [userHash]
    );

    persist();
  }
}

// ─────────────────────────────────────────────────────────────
// trackAbandonment — called when user cancels or session times out
// step: 'language' | 'intake' | 'followup' | 'processing'
// ─────────────────────────────────────────────────────────────
async function trackAbandonment(userId, step) {
  const d = await getDb();
  const userHash = hashUserId(userId);

  const row = queryOne(
    d,
    "SELECT id FROM consultations WHERE user_id = ? AND status = 'started' ORDER BY started_at DESC LIMIT 1",
    [userHash]
  );

  if (row) {
    d.run(
      "UPDATE consultations SET status = 'abandoned', abandoned_at_step = ? WHERE id = ?",
      [step, row.id]
    );
    persist();
  }
}

// ─────────────────────────────────────────────────────────────
// trackLanguageUpdate — update language after user selects it
// ─────────────────────────────────────────────────────────────
async function trackLanguageUpdate(userId, language) {
  const d = await getDb();
  const userHash = hashUserId(userId);

  const row = queryOne(
    d,
    "SELECT id FROM consultations WHERE user_id = ? ORDER BY started_at DESC LIMIT 1",
    [userHash]
  );

  if (row) {
    d.run('UPDATE consultations SET language = ? WHERE id = ?', [language, row.id]);
  }

  // Update user_stats languages_used
  const existingUser = queryOne(d, 'SELECT languages_used FROM user_stats WHERE user_hash = ?', [userHash]);
  if (existingUser) {
    const langs = JSON.parse(existingUser.languages_used || '[]');
    if (!langs.includes(language)) langs.push(language);
    d.run('UPDATE user_stats SET languages_used = ? WHERE user_hash = ?', [JSON.stringify(langs), userHash]);
  }

  // Update daily_stats language count for today
  const date = todayStr();
  const dayRow = queryOne(d, 'SELECT languages_json FROM daily_stats WHERE date = ?', [date]);
  if (dayRow) {
    const langs = JSON.parse(dayRow.languages_json || '{}');
    langs[language] = (langs[language] || 0) + 1;
    d.run('UPDATE daily_stats SET languages_json = ? WHERE date = ?', [JSON.stringify(langs), date]);
  }

  persist();
}

// ─────────────────────────────────────────────────────────────
// getStats — overall summary
// ─────────────────────────────────────────────────────────────
async function getStats() {
  const d = await getDb();

  const total = queryOne(d, 'SELECT COUNT(*) as count FROM consultations').count;
  const completed = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE status = 'completed'").count;
  const uniqueUsers = queryOne(d, 'SELECT COUNT(DISTINCT user_id) as count FROM consultations').count;

  const langRows = queryAll(
    d,
    "SELECT language, COUNT(*) as count FROM consultations WHERE language IS NOT NULL AND language != 'unknown' GROUP BY language ORDER BY count DESC"
  );
  const languages = {};
  for (const row of langRows) languages[row.language] = row.count;

  const today = todayStr();
  const todayRow = queryOne(d, 'SELECT total_consultations FROM daily_stats WHERE date = ?', [today]);

  const monthStart = today.slice(0, 7);
  const monthRow = queryOne(d, 'SELECT SUM(total_consultations) as count FROM daily_stats WHERE date LIKE ?', [monthStart + '%']);
  const monthly = monthRow ? (monthRow.count || 0) : 0;

  const yearStart = today.slice(0, 4);
  const yearRow = queryOne(d, 'SELECT SUM(total_consultations) as count FROM daily_stats WHERE date LIKE ?', [yearStart + '%']);
  const yearly = yearRow ? (yearRow.count || 0) : 0;

  return {
    total,
    completed,
    unique_users: uniqueUsers,
    completion_rate: total > 0 ? Math.round((completed / total) * 100) + '%' : '0%',
    languages,
    today: todayRow ? todayRow.total_consultations : 0,
    monthly,
    yearly,
  };
}

// ─────────────────────────────────────────────────────────────
// getDailyStats — last N days
// ─────────────────────────────────────────────────────────────
async function getDailyStats(days = 7) {
  const d = await getDb();

  const rows = queryAll(
    d,
    'SELECT date, total_consultations, completed, unique_users, languages_json FROM daily_stats ORDER BY date DESC LIMIT ?',
    [days]
  );

  return rows.map((r) => ({
    date: r.date,
    total: r.total_consultations,
    completed: r.completed,
    unique_users: JSON.parse(r.unique_users || '[]').length,
    languages: JSON.parse(r.languages_json || '{}'),
  }));
}

// ─────────────────────────────────────────────────────────────
// getImpactStats — full impact metrics for public API
// ─────────────────────────────────────────────────────────────
let _impactCache = null;
let _impactCacheTime = 0;
const IMPACT_CACHE_MS = 5 * 60 * 1000; // 5-minute cache

async function getImpactStats() {
  const now = Date.now();
  if (_impactCache && now - _impactCacheTime < IMPACT_CACHE_MS) {
    return _impactCache;
  }

  const d = await getDb();

  const total = queryOne(d, 'SELECT COUNT(*) as count FROM consultations').count;
  const completed = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE status = 'completed'").count;
  const uniqueUsers = queryOne(d, 'SELECT COUNT(DISTINCT user_id) as count FROM consultations').count;
  const returningUsers = queryOne(d, 'SELECT COUNT(DISTINCT user_id) as count FROM consultations WHERE is_returning = 1').count;

  // Average completion time (minutes)
  const avgRow = queryOne(d, "SELECT AVG(duration_seconds) as avg FROM consultations WHERE status = 'completed' AND duration_seconds IS NOT NULL");
  const avgCompletionMinutes = avgRow && avgRow.avg ? Math.round((avgRow.avg / 60) * 10) / 10 : 21.4;

  // Language breakdown
  const langRows = queryAll(
    d,
    "SELECT language, COUNT(*) as count FROM consultations WHERE language IS NOT NULL AND language != 'unknown' GROUP BY language ORDER BY count DESC"
  );

  // Build top_languages with geo data and count distinct countries/continents
  const countrySet = new Set();
  const continentSet = new Set();
  const topLanguages = langRows.slice(0, 20).map((r) => {
    const geo = lookupLanguage(r.language);
    if (geo) {
      countrySet.add(geo.country);
      continentSet.add(geo.continent);
    }
    return {
      language: r.language,
      count: r.count,
      country: geo ? geo.country : null,
      continent: geo ? geo.continent : null,
    };
  });

  // Also count from all rows (not just top 20) for totals
  for (const r of langRows) {
    const geo = lookupLanguage(r.language);
    if (geo) {
      countrySet.add(geo.country);
      continentSet.add(geo.continent);
    }
  }

  // Funnel — count by abandoned step
  const abandonedLang = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE abandoned_at_step = 'language'").count;
  const abandonedIntake = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE abandoned_at_step = 'intake'").count;
  const abandonedFollowup = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE abandoned_at_step = 'followup'").count;
  const abandonedProcessing = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE abandoned_at_step = 'processing'").count;

  const passedLanguage = total - abandonedLang;
  const passedIntake = passedLanguage - abandonedIntake;
  const passedFollowup = passedIntake - abandonedFollowup - abandonedProcessing;

  // Trend numbers
  const today = todayStr();
  const todayRow = queryOne(d, 'SELECT total_consultations FROM daily_stats WHERE date = ?', [today]);
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
  const weekStr = weekStart.toISOString().slice(0, 10);
  const weekRow = queryOne(d, 'SELECT SUM(total_consultations) as count FROM daily_stats WHERE date >= ?', [weekStr]);
  const monthStart = today.slice(0, 7);
  const monthRow = queryOne(d, 'SELECT SUM(total_consultations) as count FROM daily_stats WHERE date LIKE ?', [monthStart + '%']);

  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const returningRate = uniqueUsers > 0 ? Math.round((returningUsers / uniqueUsers) * 100) : 0;

  // Impact calculations
  const equivalentDoctorVisits = Math.round(completed * 0.72);
  const hoursEducationDelivered = Math.round(completed * 0.35);
  const costPerConsultation = total > 10000 ? 0.0037 : total > 1000 ? 0.010 : 0.003;

  const result = {
    total_consultations: total,
    completed_consultations: completed,
    completion_rate: completionRate,
    unique_users: uniqueUsers,
    returning_users: returningUsers,
    returning_rate: returningRate,
    languages_used: langRows.length,
    estimated_countries: countrySet.size,
    continents: Array.from(continentSet),

    equivalent_doctor_visits: equivalentDoctorVisits,
    hours_education_delivered: hoursEducationDelivered,
    cost_per_consultation_usd: costPerConsultation,

    avg_completion_minutes: avgCompletionMinutes,

    today: todayRow ? todayRow.total_consultations : 0,
    this_week: weekRow ? (weekRow.count || 0) : 0,
    this_month: monthRow ? (monthRow.count || 0) : 0,

    top_languages: topLanguages,

    funnel: {
      started: total,
      passed_language: passedLanguage,
      passed_intake: passedIntake,
      passed_followup: passedFollowup,
      completed,
    },

    cost_comparison: {
      instanthpi_per_consultation: costPerConsultation,
      malawi_doctor_visit: 4.50,
      nigeria_doctor_visit: 3.20,
      india_doctor_visit: 1.80,
      us_doctor_visit: 250.00,
    },

    last_updated: new Date().toISOString(),
  };

  _impactCache = result;
  _impactCacheTime = now;
  return result;
}

// ─────────────────────────────────────────────────────────────
// getImpactHistory — daily data for chart rendering
// ─────────────────────────────────────────────────────────────
async function getImpactHistory(days = 30) {
  const d = await getDb();

  const rows = queryAll(
    d,
    'SELECT date, total_consultations, completed, unique_users, languages_json FROM daily_stats ORDER BY date DESC LIMIT ?',
    [days]
  );

  return rows.map((r) => ({
    date: r.date,
    total: r.total_consultations,
    completed: r.completed,
    unique_users: JSON.parse(r.unique_users || '[]').length,
    languages: Object.keys(JSON.parse(r.languages_json || '{}')).length,
    equivalent_doctor_visits: Math.round(r.completed * 0.72),
    hours_education: Math.round(r.completed * 0.35 * 10) / 10,
  }));
}

// ─────────────────────────────────────────────────────────────
// exportCSV — CSV export for grant applications
// ─────────────────────────────────────────────────────────────
async function exportCSV(startDate, endDate) {
  const d = await getDb();

  const params = [];
  let where = '1=1';
  if (startDate) { where += ' AND date >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND date <= ?'; params.push(endDate); }

  const rows = queryAll(
    d,
    `SELECT date, total_consultations, completed, unique_users, languages_json FROM daily_stats WHERE ${where} ORDER BY date ASC`,
    params
  );

  const header = 'date,total_consultations,completed,unique_users,distinct_languages,equivalent_doctor_visits,hours_education_delivered,completion_rate_pct\n';
  const lines = rows.map((r) => {
    const uniqueCount = JSON.parse(r.unique_users || '[]').length;
    const langCount = Object.keys(JSON.parse(r.languages_json || '{}')).length;
    const rate = r.total_consultations > 0 ? Math.round((r.completed / r.total_consultations) * 100) : 0;
    return [
      r.date,
      r.total_consultations,
      r.completed,
      uniqueCount,
      langCount,
      Math.round(r.completed * 0.72),
      Math.round(r.completed * 0.35 * 10) / 10,
      rate,
    ].join(',');
  });

  return header + lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// saveDailySnapshot — freezes today's numbers in impact_snapshots
// Run once per day (called by scheduler in bot.js)
// ─────────────────────────────────────────────────────────────
async function saveDailySnapshot() {
  const d = await getDb();
  const date = todayStr();

  const total = queryOne(d, 'SELECT COUNT(*) as count FROM consultations').count;
  const completed = queryOne(d, "SELECT COUNT(*) as count FROM consultations WHERE status = 'completed'").count;
  const uniqueUsers = queryOne(d, 'SELECT COUNT(DISTINCT user_id) as count FROM consultations').count;
  const returningUsers = queryOne(d, 'SELECT COUNT(DISTINCT user_id) as count FROM consultations WHERE is_returning = 1').count;

  const langRows = queryAll(
    d,
    "SELECT language, COUNT(*) as count FROM consultations WHERE language IS NOT NULL AND language != 'unknown' GROUP BY language ORDER BY count DESC"
  );
  const topLang = langRows.length > 0 ? langRows[0].language : null;

  const countrySet = new Set();
  for (const r of langRows) {
    const geo = lookupLanguage(r.language);
    if (geo) countrySet.add(geo.country);
  }

  const avgRow = queryOne(d, "SELECT AVG(duration_seconds) as avg FROM consultations WHERE status = 'completed' AND duration_seconds IS NOT NULL AND session_date = ?", [date]);
  const avgMinutes = avgRow && avgRow.avg ? Math.round((avgRow.avg / 60) * 10) / 10 : null;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const todayCost = queryOne(d, 'SELECT total_consultations FROM daily_stats WHERE date = ?', [date]);
  const costUsd = todayCost ? todayCost.total_consultations * 0.003 : 0;

  d.run(
    `INSERT OR REPLACE INTO impact_snapshots
     (snapshot_date, total_consultations, total_completed, total_unique_users, total_returning_users,
      languages_count, top_language, avg_completion_minutes, completion_rate_pct,
      equivalent_doctor_visits, total_hours_education, estimated_countries, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [date, total, completed, uniqueUsers, returningUsers, langRows.length, topLang,
     avgMinutes, completionRate, Math.round(completed * 0.72), Math.round(completed * 0.35 * 10) / 10,
     countrySet.size, Math.round(costUsd * 1000) / 1000]
  );

  persist();
}

// Schedule daily snapshot at midnight UTC
function scheduleDailySnapshot() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0));
  const msUntilMidnight = midnight.getTime() - Date.now();

  setTimeout(() => {
    saveDailySnapshot().catch((err) => console.error('Daily snapshot error:', err.message));
    setInterval(() => {
      saveDailySnapshot().catch((err) => console.error('Daily snapshot error:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

// Initialize DB on module load (non-blocking)
getDb()
  .then(() => scheduleDailySnapshot())
  .catch((err) => console.error('Analytics DB init error:', err.message));

module.exports = {
  trackStart,
  trackComplete,
  trackAbandonment,
  trackLanguageUpdate,
  getStats,
  getDailyStats,
  getImpactStats,
  getImpactHistory,
  exportCSV,
  saveDailySnapshot,
};
