const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // requis sur Render
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cafe_sessions (
      id          SERIAL PRIMARY KEY,
      group_id    TEXT NOT NULL,
      active      BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cafe_votes (
      id          SERIAL PRIMARY KEY,
      session_id  INTEGER REFERENCES cafe_sessions(id) ON DELETE CASCADE,
      sender      TEXT NOT NULL,
      vote        TEXT NOT NULL CHECK (vote IN ('oui','non')),
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(session_id, sender)
    );
  `);
  console.log('✅ Tables café prêtes');
}

module.exports = { pool, initDB };
