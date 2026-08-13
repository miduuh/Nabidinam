const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const ExcelJS = require('exceljs');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'meelad2026'; // CHANGE THIS before your event

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

let liveQuestion = null; // { id, question_text, options, duration_seconds, startedAt }
let liveTimer = null;

function assignRanks(rows, scoreKey) {
  let previousScore = null;
  let rank = 0;
  let position = 0;
  return rows.map((row) => {
    position += 1;
    if (previousScore === null || row[scoreKey] !== previousScore) {
      rank = position;
    }
    previousScore = row[scoreKey];
    return { ...row, rank };
  });
}

function currentLeaderboard(limit = 15) {
  // Only completed questions count. This keeps the public ranking stable while a
  // live question is in progress, then updates it once that question is closed.
  const rows = db.prepare(`
    SELECT u.id, u.name,
      COALESCE(SUM(CASE WHEN q.status = 'closed' THEN a.is_correct ELSE 0 END), 0) as score
    FROM users u
    LEFT JOIN answers a ON a.user_id = u.id
    LEFT JOIN questions q ON q.id = a.question_id
    GROUP BY u.id
    ORDER BY score DESC, u.id ASC
    LIMIT ?
  `).all(limit);
  return assignRanks(rows, 'score').map((r) => ({ rank: r.rank, name: r.name, score: r.score }));
}

// ---------- Registration / Login ----------
app.post('/api/register', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length < 8) return res.status(400).json({ error: 'Invalid phone number' });

  const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
  if (existing) return res.json({ user: existing });

  const info = db.prepare('INSERT INTO users (name, phone) VALUES (?, ?)').run(name, cleanPhone);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ user });
});

app.post('/api/login', (req, res) => {
  const { phone } = req.body;
  const cleanPhone = String(phone || '').replace(/\D/g, '');
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(cleanPhone);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user });
});

// ---------- Quiz: participant ----------
app.get('/api/quiz/current', (req, res) => {
  if (!liveQuestion) return res.json({ live: false });
  const remaining = Math.max(0, liveQuestion.duration_seconds - Math.floor((Date.now() - liveQuestion.startedAt) / 1000));
  res.json({
    live: true,
    id: liveQuestion.id,
    question_text: liveQuestion.question_text,
    options: liveQuestion.options,
    duration_seconds: liveQuestion.duration_seconds,
    remaining
  });
});

app.get('/api/leaderboard', (req, res) => {
  res.json({ leaderboard: currentLeaderboard() });
});

// Submit answer (also called with selected_option = null when forfeited by tab-switch)
app.post('/api/quiz/answer', (req, res) => {
  const { user_id, question_id, selected_option, forfeited } = req.body;
  if (!liveQuestion || liveQuestion.id !== question_id) {
    return res.status(400).json({ error: 'This question is no longer live' });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(question_id);
  const isCorrect = !forfeited && selected_option && selected_option === q.correct_option ? 1 : 0;

  try {
    db.prepare(`
      INSERT INTO answers (user_id, question_id, selected_option, is_correct, forfeited)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, question_id) DO UPDATE SET
        selected_option = excluded.selected_option,
        is_correct = excluded.is_correct,
        forfeited = excluded.forfeited
    `).run(user_id, question_id, selected_option || null, isCorrect, forfeited ? 1 : 0);
  } catch (e) {
    return res.status(500).json({ error: 'Could not save answer' });
  }

  res.json({ ok: true, recorded: true });
});

// Report a cheat/tab-switch event (auto-forfeits current question)
app.post('/api/quiz/flag', (req, res) => {
  const { user_id, question_id, event } = req.body;
  db.prepare('INSERT INTO cheat_log (user_id, question_id, event) VALUES (?, ?, ?)').run(user_id, question_id || null, event || 'tab-switch');
  if (liveQuestion && question_id === liveQuestion.id) {
    try {
      db.prepare(`
        INSERT INTO answers (user_id, question_id, selected_option, is_correct, forfeited)
        VALUES (?, ?, NULL, 0, 1)
        ON CONFLICT(user_id, question_id) DO UPDATE SET forfeited = 1, is_correct = 0
      `).run(user_id, question_id);
    } catch (e) { /* ignore */ }
  }
  res.json({ ok: true });
});

// ---------- Swalath counter ----------
app.get('/api/swalath/:userId', (req, res) => {
  const userId = req.params.userId;
  const row = db.prepare('SELECT total_count FROM swalath WHERE user_id = ?').get(userId);
  const history = db.prepare(`
    SELECT date(logged_at) as day, SUM(amount) as total
    FROM swalath_log WHERE user_id = ?
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all(userId);
  res.json({ total: row ? row.total_count : 0, history });
});

app.post('/api/swalath/:userId/add', (req, res) => {
  const userId = req.params.userId;
  const amount = Number(req.body.amount) || 1;
  if (amount < 1) return res.status(400).json({ error: 'Invalid amount' });
  if (amount > 10000) return res.status(400).json({ error: "you can't add above 10000 a day" });

  const today = db.prepare(`
    SELECT IFNULL(SUM(amount), 0) AS total
    FROM swalath_log
    WHERE user_id = ? AND date(logged_at) = date('now')
  `).get(userId).total;

  if (today + amount > 10000) {
    return res.status(400).json({ error: "you can't add above 10000 a day" });
  }

  db.prepare(`
    INSERT INTO swalath (user_id, total_count) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET total_count = total_count + excluded.total_count
  `).run(userId, amount);
  db.prepare('INSERT INTO swalath_log (user_id, amount) VALUES (?, ?)').run(userId, amount);
  const row = db.prepare('SELECT total_count FROM swalath WHERE user_id = ?').get(userId);
  io.emit('swalath-update');
  res.json({ total: row.total_count });
});

app.get('/api/admin/swalath/:userId/history', requireAdmin, (req, res) => {
  const userId = req.params.userId;
  const user = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(userId);
  const history = db.prepare(`
    SELECT date(logged_at) AS day, SUM(amount) AS total
    FROM swalath_log WHERE user_id = ?
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all(userId);
  res.json({ user: user || { name: null, phone: null }, history });
});

// ---------- Admin ----------
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) return res.json({ ok: true, token: ADMIN_PASSWORD });
  res.status(401).json({ error: 'Wrong password' });
});

app.get('/api/admin/questions', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM questions ORDER BY sort_order, id').all());
});

app.post('/api/admin/questions', requireAdmin, (req, res) => {
  const { question_text, option_a, option_b, option_c, option_d, correct_option, duration_seconds } = req.body;
  const info = db.prepare(`
    INSERT INTO questions (question_text, option_a, option_b, option_c, option_d, correct_option, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(question_text, option_a, option_b, option_c, option_d, correct_option, duration_seconds || 20);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/admin/questions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/quiz/start/:id', requireAdmin, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });

  liveQuestion = {
    id: q.id,
    question_text: q.question_text,
    options: { a: q.option_a, b: q.option_b, c: q.option_c, d: q.option_d },
    duration_seconds: q.duration_seconds,
    startedAt: Date.now()
  };
  db.prepare("UPDATE questions SET status = 'live', started_at = ? WHERE id = ?").run(liveQuestion.startedAt, q.id);

  io.emit('question-live', liveQuestion);

  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    io.emit('question-ended', { id: q.id, correct_option: q.correct_option });
    db.prepare("UPDATE questions SET status = 'closed' WHERE id = ?").run(q.id);
    liveQuestion = null;
    io.emit('leaderboard-update', currentLeaderboard());
  }, q.duration_seconds * 1000);

  res.json({ ok: true });
});

app.post('/api/admin/quiz/stop', requireAdmin, (req, res) => {
  if (liveTimer) clearTimeout(liveTimer);
  if (liveQuestion) {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(liveQuestion.id);
    io.emit('question-ended', { id: liveQuestion.id, correct_option: q.correct_option });
    db.prepare("UPDATE questions SET status = 'closed' WHERE id = ?").run(liveQuestion.id);
  }
  liveQuestion = null;
  io.emit('leaderboard-update', currentLeaderboard());
  res.json({ ok: true });
});

app.get('/api/admin/participants-count', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
  res.json({ count: row.c });
});

// Reset all event/participant data while keeping the question bank
app.post('/api/admin/reset-event', requireAdmin, (req, res) => {
  try {
    // Stop any currently running question
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }

    if (liveQuestion) {
      io.emit('question-ended', {
        id: liveQuestion.id
      });
    }

    liveQuestion = null;

    // Delete event/participant data.
    // Questions are intentionally preserved.
    const reset = db.transaction(() => {
      db.prepare('DELETE FROM answers').run();
      db.prepare('DELETE FROM cheat_log').run();
      db.prepare('DELETE FROM swalath_log').run();
      db.prepare('DELETE FROM swalath').run();
      db.prepare('DELETE FROM users').run();

      // Reset question status so the existing question bank
      // is ready for the next event.
      db.prepare(`
        UPDATE questions
        SET status = 'draft',
            started_at = NULL
      `).run();
    });

    reset();

    // Notify connected clients
    io.emit('leaderboard-update', []);
    io.emit('swalath-update');
    io.emit('event-reset');

    res.json({
      ok: true,
      message: 'Event data reset successfully. Questions were preserved.'
    });

  } catch (error) {
    console.error('Reset event error:', error);

    res.status(500).json({
      ok: false,
      error: 'Failed to reset event data'
    });
  }
});

app.get('/api/admin/swalath-leaderboard', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id as user_id, u.name, s.total_count
    FROM swalath s
    JOIN users u ON u.id = s.user_id
    WHERE s.total_count > 0
    ORDER BY s.total_count DESC, u.id ASC
    LIMIT 100
  `).all();
  const leaderboard = assignRanks(rows, 'total_count');
  res.json({ leaderboard });
});

app.get('/api/admin/cheat-log', requireAdmin, (req, res) => {
  res.json(db.prepare(`
    SELECT c.*, u.name, u.phone FROM cheat_log c JOIN users u ON u.id = c.user_id
    ORDER BY c.id DESC LIMIT 200
  `).all());
});

// Excel export of full results
app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const questions = db.prepare('SELECT * FROM questions ORDER BY sort_order, id').all();
  const answers = db.prepare('SELECT * FROM answers').all();

  const answerMap = {}; // user_id -> question_id -> answer
  answers.forEach(a => {
    answerMap[a.user_id] = answerMap[a.user_id] || {};
    answerMap[a.user_id][a.question_id] = a;
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Results');

  const columns = [
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Phone', key: 'phone', width: 15 }
  ];
  questions.forEach(q => {
    columns.push({ header: `Q${q.id}: ${q.question_text.slice(0, 30)}`, key: `q_${q.id}`, width: 20 });
  });
  columns.push({ header: 'Total Score', key: 'total', width: 12 });
  sheet.columns = columns;

  users.forEach(u => {
    const row = { name: u.name, phone: u.phone };
    let total = 0;
    questions.forEach(q => {
      const a = answerMap[u.id] && answerMap[u.id][q.id];
      if (!a) {
        row[`q_${q.id}`] = '-';
      } else if (a.forfeited) {
        row[`q_${q.id}`] = 'Forfeited (left quiz)';
      } else {
        row[`q_${q.id}`] = `${(a.selected_option || '-').toUpperCase()} ${a.is_correct ? '(Correct, +1)' : '(Wrong, +0)'}`;
        total += a.is_correct;
      }
    });
    row.total = total;
    sheet.addRow(row);
  });

  sheet.getRow(1).font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=quiz_results.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
