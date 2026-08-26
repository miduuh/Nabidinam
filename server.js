const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const ExcelJS = require('exceljs');

const { pool, initDatabase } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'meelad2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

let liveQuestion = null;
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

    return {
      ...row,
      rank
    };
  });
}

async function currentLeaderboard(limit = null) {
  const query = `
    SELECT
      u.id,
      u.name,
      COALESCE(
        SUM(
          CASE
            WHEN q.status = 'closed' THEN a.is_correct
            ELSE 0
          END
        ),
        0
      ) AS score
    FROM users u
    LEFT JOIN answers a ON a.user_id = u.id
    LEFT JOIN questions q ON q.id = a.question_id
    GROUP BY u.id, u.name
    ORDER BY score DESC, u.id ASC
    ${limit ? 'LIMIT $1' : ''}
  `;

  const result = await pool.query(query, limit ? [limit] : []);

  const rows = result.rows.map(row => ({
    ...row,
    score: Number(row.score)
  }));

  return assignRanks(rows, 'score').map((r) => ({
    rank: r.rank,
    name: r.name,
    score: r.score
  }));
}

// ---------- Registration / Login ----------

app.post('/api/register', async (req, res) => {
  try {
    const { name, phone } = req.body;

    if (!name || !phone) {
      return res.status(400).json({
        error: 'Name and phone required'
      });
    }

    const cleanPhone = String(phone).replace(/\D/g, '');

    if (cleanPhone.length < 8) {
      return res.status(400).json({
        error: 'Invalid phone number'
      });
    }

    const existingResult = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [cleanPhone]
    );

    const existing = existingResult.rows[0];

    if (existing) {
      return res.json({ user: existing });
    }

    const insertResult = await pool.query(
      `
      INSERT INTO users (name, phone)
      VALUES ($1, $2)
      RETURNING *
      `,
      [name, cleanPhone]
    );

    res.json({
      user: insertResult.rows[0]
    });

  } catch (error) {
    console.error('Registration error:', error);

    res.status(500).json({
      error: 'Registration failed'
    });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { phone } = req.body;

    const cleanPhone = String(phone || '').replace(/\D/g, '');

    const result = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [cleanPhone]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({
        error: 'Not found'
      });
    }

    res.json({ user });

  } catch (error) {
    console.error('Login error:', error);

    res.status(500).json({
      error: 'Login failed'
    });
  }
});

// ---------- Quiz: participant ----------

app.get('/api/quiz/current', (req, res) => {
  if (!liveQuestion) {
    return res.json({
      live: false
    });
  }

  const remaining = Math.max(
    0,
    liveQuestion.duration_seconds -
      Math.floor((Date.now() - liveQuestion.startedAt) / 1000)
  );

  res.json({
    live: true,
    id: liveQuestion.id,
    question_text: liveQuestion.question_text,
    options: liveQuestion.options,
    duration_seconds: liveQuestion.duration_seconds,
    remaining
  });
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    res.json({
      leaderboard: await currentLeaderboard()
    });
  } catch (error) {
    console.error('Leaderboard error:', error);

    res.status(500).json({
      error: 'Could not load leaderboard'
    });
  }
});

// Submit answer
app.post('/api/quiz/answer', async (req, res) => {
  try {
    const {
      user_id,
      question_id,
      selected_option,
      forfeited
    } = req.body;

    if (!liveQuestion || liveQuestion.id !== Number(question_id)) {
      return res.status(400).json({
        error: 'This question is no longer live'
      });
    }

    const questionResult = await pool.query(
      'SELECT * FROM questions WHERE id = $1',
      [question_id]
    );

    const q = questionResult.rows[0];

    if (!q) {
      return res.status(404).json({
        error: 'Question not found'
      });
    }

    const isCorrect =
      !forfeited &&
      selected_option &&
      selected_option === q.correct_option
        ? 1
        : 0;

    await pool.query(
      `
      INSERT INTO answers (
        user_id,
        question_id,
        selected_option,
        is_correct,
        forfeited
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, question_id)
      DO UPDATE SET
        selected_option = EXCLUDED.selected_option,
        is_correct = EXCLUDED.is_correct,
        forfeited = EXCLUDED.forfeited
      `,
      [
        user_id,
        question_id,
        selected_option || null,
        isCorrect,
        forfeited ? 1 : 0
      ]
    );

    res.json({
      ok: true,
      recorded: true
    });

  } catch (error) {
    console.error('Save answer error:', error);

    res.status(500).json({
      error: 'Could not save answer'
    });
  }
});

// Report cheat/tab-switch event
app.post('/api/quiz/flag', async (req, res) => {
  try {
    const {
      user_id,
      question_id,
      event
    } = req.body;

    await pool.query(
      `
      INSERT INTO cheat_log (
        user_id,
        question_id,
        event
      )
      VALUES ($1, $2, $3)
      `,
      [
        user_id,
        question_id || null,
        event || 'tab-switch'
      ]
    );

    if (
      liveQuestion &&
      Number(question_id) === liveQuestion.id
    ) {
      await pool.query(
        `
        INSERT INTO answers (
          user_id,
          question_id,
          selected_option,
          is_correct,
          forfeited
        )
        VALUES ($1, $2, NULL, 0, 1)
        ON CONFLICT (user_id, question_id)
        DO UPDATE SET
          forfeited = 1,
          is_correct = 0
        `,
        [user_id, question_id]
      );
    }

    res.json({
      ok: true
    });

  } catch (error) {
    console.error('Cheat flag error:', error);

    res.status(500).json({
      error: 'Could not record event'
    });
  }
});

// ---------- Swalath counter ----------

app.get('/api/swalath/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;

    const rowResult = await pool.query(
      `
      SELECT total_count
      FROM swalath
      WHERE user_id = $1
      `,
      [userId]
    );

    const row = rowResult.rows[0];

    const historyResult = await pool.query(
      `
      SELECT
        DATE(logged_at) AS day,
        SUM(amount) AS total
      FROM swalath_log
      WHERE user_id = $1
      GROUP BY DATE(logged_at)
      ORDER BY day DESC
      LIMIT 30
      `,
      [userId]
    );

    res.json({
      total: row ? Number(row.total_count) : 0,
      history: historyResult.rows
    });

  } catch (error) {
    console.error('Swalath fetch error:', error);

    res.status(500).json({
      error: 'Could not load Swalath data'
    });
  }
});

app.post('/api/swalath/:userId/add', async (req, res) => {
  const client = await pool.connect();

  try {
    const userId = req.params.userId;
    const amount = Number(req.body.amount) || 1;

    if (amount < 1) {
      return res.status(400).json({
        error: 'Invalid amount'
      });
    }

    if (amount > 10000) {
      return res.status(400).json({
        error: "you can't add above 10000 a day"
      });
    }

    await client.query('BEGIN');

    const todayResult = await client.query(
      `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM swalath_log
      WHERE user_id = $1
        AND DATE(logged_at) = CURRENT_DATE
      `,
      [userId]
    );

    const today = Number(todayResult.rows[0].total);

    if (today + amount > 10000) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: "you can't add above 10000 a day"
      });
    }

    await client.query(
      `
      INSERT INTO swalath (
        user_id,
        total_count
      )
      VALUES ($1, $2)
      ON CONFLICT (user_id)
      DO UPDATE SET
        total_count = swalath.total_count + EXCLUDED.total_count
      `,
      [userId, amount]
    );

    await client.query(
      `
      INSERT INTO swalath_log (
        user_id,
        amount
      )
      VALUES ($1, $2)
      `,
      [userId, amount]
    );

    const rowResult = await client.query(
      `
      SELECT total_count
      FROM swalath
      WHERE user_id = $1
      `,
      [userId]
    );

    await client.query('COMMIT');

    const row = rowResult.rows[0];

    io.emit('swalath-update');

    res.json({
      total: Number(row.total_count)
    });

  } catch (error) {
    await client.query('ROLLBACK');

    console.error('Swalath add error:', error);

    res.status(500).json({
      error: 'Could not update Swalath'
    });

  } finally {
    client.release();
  }
});

app.get('/api/swalath/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.name,
        s.total_count
      FROM swalath s
      JOIN users u ON u.id = s.user_id
      WHERE s.total_count > 0
      ORDER BY s.total_count DESC, u.id ASC
      LIMIT 100
    `);

    const rows = result.rows.map(row => ({
      ...row,
      total_count: Number(row.total_count)
    }));

    res.json({
      leaderboard: assignRanks(rows, 'total_count')
    });

  } catch (error) {
    console.error('Public Swalath leaderboard error:', error);

    res.status(500).json({
      error: 'Could not load Swalath leaderboard'
    });
  }
});

app.get(
  '/api/admin/swalath/:userId/history',
  requireAdmin,
  async (req, res) => {
    try {
      const userId = req.params.userId;

      const userResult = await pool.query(
        `
        SELECT name, phone
        FROM users
        WHERE id = $1
        `,
        [userId]
      );

      const historyResult = await pool.query(
        `
        SELECT
          DATE(logged_at) AS day,
          SUM(amount) AS total
        FROM swalath_log
        WHERE user_id = $1
        GROUP BY DATE(logged_at)
        ORDER BY day DESC
        LIMIT 30
        `,
        [userId]
      );

      res.json({
        user: userResult.rows[0] || {
          name: null,
          phone: null
        },
        history: historyResult.rows
      });

    } catch (error) {
      console.error('Swalath history error:', error);

      res.status(500).json({
        error: 'Could not load history'
      });
    }
  }
);

// ---------- Admin ----------

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    return res.json({
      ok: true,
      token: ADMIN_PASSWORD
    });
  }

  res.status(401).json({
    error: 'Wrong password'
  });
});

// Get questions
app.get('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM questions
      ORDER BY sort_order, id
      `
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Get questions error:', error);

    res.status(500).json({
      error: 'Could not load questions'
    });
  }
});

// Add question
app.post('/api/admin/questions', requireAdmin, async (req, res) => {
  try {
    const {
      question_text,
      option_a,
      option_b,
      option_c,
      option_d,
      correct_option,
      duration_seconds
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO questions (
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_option,
        duration_seconds
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [
        question_text,
        option_a,
        option_b,
        option_c,
        option_d,
        correct_option,
        duration_seconds || 20
      ]
    );

    res.json({
      id: result.rows[0].id
    });

  } catch (error) {
    console.error('Add question error:', error);

    res.status(500).json({
      error: 'Could not add question'
    });
  }
});

// Delete question
app.delete(
  '/api/admin/questions/:id',
  requireAdmin,
  async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM questions WHERE id = $1',
        [req.params.id]
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error('Delete question error:', error);

      res.status(500).json({
        error: 'Could not delete question'
      });
    }
  }
);

// Start quiz
app.post(
  '/api/admin/quiz/start/:id',
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM questions WHERE id = $1',
        [req.params.id]
      );

      const q = result.rows[0];

      if (!q) {
        return res.status(404).json({
          error: 'Not found'
        });
      }

      liveQuestion = {
        id: q.id,
        question_text: q.question_text,
        options: {
          a: q.option_a,
          b: q.option_b,
          c: q.option_c,
          d: q.option_d
        },
        duration_seconds: q.duration_seconds,
        startedAt: Date.now()
      };

      await pool.query(
        `
        UPDATE questions
        SET
          status = 'live',
          started_at = $1
        WHERE id = $2
        `,
        [
          liveQuestion.startedAt,
          q.id
        ]
      );

      io.emit('question-live', liveQuestion);

      if (liveTimer) {
        clearTimeout(liveTimer);
      }

      liveTimer = setTimeout(async () => {
        try {
          io.emit('question-ended', {
            id: q.id,
            correct_option: q.correct_option
          });

          await pool.query(
            `
            UPDATE questions
            SET status = 'closed'
            WHERE id = $1
            `,
            [q.id]
          );

          liveQuestion = null;

          io.emit(
            'leaderboard-update',
            await currentLeaderboard()
          );

        } catch (error) {
          console.error('Question timer error:', error);
        }
      }, q.duration_seconds * 1000);

      res.json({
        ok: true
      });

    } catch (error) {
      console.error('Start quiz error:', error);

      res.status(500).json({
        error: 'Could not start quiz'
      });
    }
  }
);

// Stop quiz
app.post(
  '/api/admin/quiz/stop',
  requireAdmin,
  async (req, res) => {
    try {
      if (liveTimer) {
        clearTimeout(liveTimer);
        liveTimer = null;
      }

      if (liveQuestion) {
        const result = await pool.query(
          `
          SELECT *
          FROM questions
          WHERE id = $1
          `,
          [liveQuestion.id]
        );

        const q = result.rows[0];

        if (q) {
          io.emit('question-ended', {
            id: liveQuestion.id,
            correct_option: q.correct_option
          });

          await pool.query(
            `
            UPDATE questions
            SET status = 'closed'
            WHERE id = $1
            `,
            [liveQuestion.id]
          );
        }
      }

      liveQuestion = null;

      io.emit(
        'leaderboard-update',
        await currentLeaderboard()
      );

      res.json({
        ok: true
      });

    } catch (error) {
      console.error('Stop quiz error:', error);

      res.status(500).json({
        error: 'Could not stop quiz'
      });
    }
  }
);

// Participants count
app.get(
  '/api/admin/participants-count',
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT COUNT(*) AS c FROM users'
      );

      res.json({
        count: Number(result.rows[0].c)
      });

    } catch (error) {
      console.error('Participants count error:', error);

      res.status(500).json({
        error: 'Could not get participant count'
      });
    }
  }
);

// ---------- Reset Event ----------

app.post(
  '/api/admin/reset-event',
  requireAdmin,
  async (req, res) => {
    const client = await pool.connect();

    try {
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

      await client.query('BEGIN');

      await client.query('DELETE FROM answers');
      await client.query('DELETE FROM cheat_log');
      await client.query('DELETE FROM swalath_log');
      await client.query('DELETE FROM swalath');
      await client.query('DELETE FROM users');

      await client.query(`
        UPDATE questions
        SET
          status = 'draft',
          started_at = NULL
      `);

      await client.query('COMMIT');

      io.emit('leaderboard-update', []);
      io.emit('swalath-update');
      io.emit('event-reset');

      res.json({
        ok: true,
        message:
          'Event data reset successfully. Questions were preserved.'
      });

    } catch (error) {
      await client.query('ROLLBACK');

      console.error('Reset event error:', error);

      res.status(500).json({
        ok: false,
        error: 'Failed to reset event data'
      });

    } finally {
      client.release();
    }
  }
);

// Swalath leaderboard
app.get(
  '/api/admin/swalath-leaderboard',
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          u.id AS user_id,
          u.name,
          s.total_count
        FROM swalath s
        JOIN users u ON u.id = s.user_id
        WHERE s.total_count > 0
        ORDER BY s.total_count DESC, u.id ASC
        LIMIT 100
      `);

      const rows = result.rows.map(row => ({
        ...row,
        total_count: Number(row.total_count)
      }));

      const leaderboard = assignRanks(
        rows,
        'total_count'
      );

      res.json({
        leaderboard
      });

    } catch (error) {
      console.error('Swalath leaderboard error:', error);

      res.status(500).json({
        error: 'Could not load Swalath leaderboard'
      });
    }
  }
);

// Cheat log
app.get(
  '/api/admin/cheat-log',
  requireAdmin,
  async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          c.*,
          u.name,
          u.phone
        FROM cheat_log c
        JOIN users u ON u.id = c.user_id
        ORDER BY c.id DESC
        LIMIT 200
      `);

      res.json(result.rows);

    } catch (error) {
      console.error('Cheat log error:', error);

      res.status(500).json({
        error: 'Could not load cheat log'
      });
    }
  }
);

// ---------- Excel export ----------

app.get(
  '/api/admin/export',
  requireAdmin,
  async (req, res) => {
    try {
      const usersResult = await pool.query(
        'SELECT * FROM users ORDER BY id'
      );

      const questionsResult = await pool.query(
        `
        SELECT *
        FROM questions
        ORDER BY sort_order, id
        `
      );

      const answersResult = await pool.query(
        'SELECT * FROM answers'
      );

      const users = usersResult.rows;
      const questions = questionsResult.rows;
      const answers = answersResult.rows;

      const answerMap = {};

      answers.forEach((a) => {
        if (!answerMap[a.user_id]) {
          answerMap[a.user_id] = {};
        }

        answerMap[a.user_id][a.question_id] = a;
      });

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Results');

      const columns = [
        {
          header: 'Name',
          key: 'name',
          width: 22
        },
        {
          header: 'Phone',
          key: 'phone',
          width: 15
        }
      ];

      questions.forEach((q) => {
        columns.push({
          header: `Q${q.id}: ${q.question_text.slice(0, 30)}`,
          key: `q_${q.id}`,
          width: 20
        });
      });

      columns.push({
        header: 'Total Score',
        key: 'total',
        width: 12
      });

      sheet.columns = columns;

      users.forEach((u) => {
        const row = {
          name: u.name,
          phone: u.phone
        };

        let total = 0;

        questions.forEach((q) => {
          const a =
            answerMap[u.id] &&
            answerMap[u.id][q.id];

          if (!a) {
            row[`q_${q.id}`] = '-';

          } else if (a.forfeited) {
            row[`q_${q.id}`] =
              'Forfeited (left quiz)';

          } else {
            row[`q_${q.id}`] =
              `${(a.selected_option || '-').toUpperCase()} ${
                a.is_correct
                  ? '(Correct, +1)'
                  : '(Wrong, +0)'
              }`;

            total += Number(a.is_correct);
          }
        });

        row.total = total;

        sheet.addRow(row);
      });

      sheet.getRow(1).font = {
        bold: true
      };

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      res.setHeader(
        'Content-Disposition',
        'attachment; filename=quiz_results.xlsx'
      );

      await workbook.xlsx.write(res);

      res.end();

    } catch (error) {
      console.error('Excel export error:', error);

      if (!res.headersSent) {
        res.status(500).json({
          error: 'Could not export results'
        });
      }
    }
  }
);

// ---------- Start server ----------

async function startServer() {
  try {
    await initDatabase();

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

  } catch (error) {
    console.error(
      'Database initialization failed:',
      error
    );

    process.exit(1);
  }
}

startServer();