const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PRESENTER_CODE = '1234';
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { responses: {}, survey: {}, pidLabels: {}, pidCounter: 0, state: { page: 0, track: null } };
  }
}
let data = loadData();
if (!data.pidLabels) data.pidLabels = {};
if (!data.pidCounter) data.pidCounter = 0;

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function labelFor(pid) {
  if (!data.pidLabels[pid]) {
    data.pidCounter += 1;
    data.pidLabels[pid] = data.pidCounter;
  }
  return '参加者' + data.pidLabels[pid];
}

function ensureResponse(pid) {
  if (!data.responses[pid]) data.responses[pid] = { answers: {}, questions: {}, questionAnswers: {} };
  if (!data.responses[pid].questionAnswers) data.responses[pid].questionAnswers = {};
  return data.responses[pid];
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

// byPage[pageId].items: every participant who has an answer and/or a supplementary
// question on that page, with their display label and any reply already given.
function computeTallies() {
  const byPage = {};
  for (const pid in data.responses) {
    const r = data.responses[pid];
    const pageIds = new Set([
      ...Object.keys(r.answers || {}),
      ...Object.keys(r.questions || {}),
    ]);
    pageIds.forEach(pageId => {
      if (!byPage[pageId]) byPage[pageId] = { items: [] };
      byPage[pageId].items.push({
        pid,
        label: labelFor(pid),
        answer: r.answers ? r.answers[pageId] : undefined,
        question: r.questions ? r.questions[pageId] : undefined,
        reply: r.questionAnswers ? r.questionAnswers[pageId] : undefined,
      });
    });
  }
  const submitted = [];
  for (const pid in data.survey) {
    const s = data.survey[pid];
    if (s.submittedAt) submitted.push({ satisfaction: s.satisfaction || null, good: s.good || '', topics: s.topics || '' });
  }
  return { byPage, submitted, participantCount: Object.keys(data.responses).length };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }

    if (req.method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, data.state);
    }

    if (req.method === 'POST' && p === '/api/state') {
      const body = await readBody(req);
      if (String(body.code) !== PRESENTER_CODE) return sendJson(res, 403, { error: '合言葉が違います。' });
      data.state = { page: body.page, track: body.track, updatedAt: Date.now() };
      save();
      return sendJson(res, 200, { ok: true, state: data.state });
    }

    if (req.method === 'GET' && p === '/api/tallies') {
      return sendJson(res, 200, computeTallies());
    }

    if (req.method === 'GET' && p === '/api/my') {
      const pid = u.searchParams.get('pid');
      const r = data.responses[pid] || { answers: {}, questions: {}, questionAnswers: {} };
      const s = data.survey[pid] || null;
      return sendJson(res, 200, {
        answers: r.answers || {},
        questions: r.questions || {},
        questionAnswers: r.questionAnswers || {},
        survey: s,
      });
    }

    if (req.method === 'POST' && p === '/api/answer') {
      const body = await readBody(req);
      if (!body.pid || !body.pageId) return sendJson(res, 400, { error: '不正な送信です。' });
      ensureResponse(body.pid).answers[body.pageId] = body.value;
      save();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/question') {
      const body = await readBody(req);
      if (!body.pid || !body.pageId) return sendJson(res, 400, { error: '不正な送信です。' });
      ensureResponse(body.pid).questions[body.pageId] = body.text;
      save();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/survey') {
      const body = await readBody(req);
      if (!body.pid) return sendJson(res, 400, { error: '不正な送信です。' });
      const payload = body.payload || {};
      data.survey[body.pid] = {
        satisfaction: payload.satisfaction || null,
        good: payload.good || '',
        topics: payload.topics || '',
        name: payload.name || '',
        org: payload.org || '',
        email: payload.email || '',
        submittedAt: new Date().toISOString(),
      };
      save();
      return sendJson(res, 200, { ok: true });
    }

    // Presenter replies to ONE specific participant's question/answer on a page.
    if (req.method === 'POST' && p === '/api/instructor-answer') {
      const body = await readBody(req);
      if (String(body.code) !== PRESENTER_CODE) return sendJson(res, 403, { error: '合言葉が違います。' });
      if (!body.pid || !body.pageId) return sendJson(res, 400, { error: '不正な送信です。' });
      ensureResponse(body.pid).questionAnswers[body.pageId] = body.text;
      save();
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log('Server listening on http://localhost:' + PORT);
});
