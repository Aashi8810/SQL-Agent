// ============================================================
// NL-SQL Agent — Backend Proxy Server
// Express + PostgreSQL
// ============================================================

require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// Helmet sets safe HTTP headers
app.use(helmet());

// Only allow requests from your frontend origin
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. curl, Postman) only in dev
    if (!origin && process.env.NODE_ENV !== "production") return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "16kb" })); // prevent oversized payloads

// Rate limiting — 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." }
});
app.use(limiter);

// ============================================================
// POSTGRESQL CONNECTION POOL
// ============================================================

const pool = new Pool({
  host:     process.env.PG_HOST,
  port:     parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl:      process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  max:      10,              // max pool connections
  idleTimeoutMillis: 30000,  // close idle connections after 30s
  connectionTimeoutMillis: 5000
});

// Test DB connection on startup
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Failed to connect to PostgreSQL:", err.message);
    process.exit(1);
  }
  console.log("✅ Connected to PostgreSQL:", process.env.PG_DATABASE);
  release();
});

// ============================================================
// SQL SAFETY VALIDATOR
// Called before executing any query
// ============================================================

function validateSQL(sql) {
  if (!sql || typeof sql !== "string") {
    return { valid: false, reason: "No SQL provided." };
  }

  const trimmed = sql.trim();

  // Must start with SELECT
  if (!/^SELECT\b/i.test(trimmed)) {
    return { valid: false, reason: "Only SELECT queries are permitted." };
  }

  // Block dangerous keywords
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|EXEC|EXECUTE|GRANT|REVOKE|VACUUM|COPY|pg_read_file|pg_ls_dir)\b/i;
  if (dangerous.test(trimmed)) {
    return { valid: false, reason: "Query contains forbidden operations." };
  }

  // Block comments that could be used to hide injections
  if (/\/\*[\s\S]*?\*\//.test(trimmed)) {
    return { valid: false, reason: "Block comments are not allowed." };
  }

  // Block multiple statements via semicolon (except trailing)
  const withoutTrailing = trimmed.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return { valid: false, reason: "Multiple statements are not allowed." };
  }

  // Enforce a row limit — prevent accidental full-table dumps
  // We append LIMIT server-side if none is present
  return { valid: true };
}

// Append a hard row cap if the query has no LIMIT clause
function enforceLimitCap(sql, cap = 1000) {
  const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
  if (hasLimit) return sql;
  return `${sql.trim().replace(/;?\s*$/, "")} LIMIT ${cap}`;
}

// ============================================================
// ROUTE: GET /health
// Simple liveness check
// ============================================================

app.get("/health", (req, res) => {
  res.json({ status: "ok", database: process.env.PG_DATABASE });
});

// ============================================================
// ROUTE: GET /schema
// Returns all tables + columns + one sample row per table
// Used by the React app to build the LLM prompt context
// Replaces Module 1 (Schema Registry) and Module 6 (Seeder)
// ============================================================

app.get("/schema", async (req, res) => {
  try {
    // Fetch all columns across all public tables
    const columnsResult = await pool.query(`
      SELECT
        c.table_name,
        c.column_name,
        c.data_type,
        c.ordinal_position
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON c.table_name = t.table_name
        AND c.table_schema = t.table_schema
      WHERE c.table_schema = $1
        AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
    `, [process.env.PG_SCHEMA || "public"]);

    // Build schema object: { tableName: { columns: [...], sample: "..." } }
    const schema = {};
    for (const row of columnsResult.rows) {
      if (!schema[row.table_name]) {
        schema[row.table_name] = { columns: [], types: {}, sample: "" };
      }
      schema[row.table_name].columns.push(row.column_name);
      schema[row.table_name].types[row.column_name] = row.data_type;
    }

    // Fetch one sample row per table (in parallel)
    await Promise.all(
      Object.keys(schema).map(async (table) => {
        try {
          const sample = await pool.query(
            `SELECT * FROM "${table}" LIMIT 1`
          );
          if (sample.rows.length > 0) {
            // Serialize as key:value pairs for the LLM prompt
            schema[table].sample = Object.entries(sample.rows[0])
              .map(([k, v]) => `${k}:${JSON.stringify(v)}`)
              .join(", ");
          }
        } catch (_) {
          // Table may not be selectable — skip sample gracefully
          schema[table].sample = "(no sample available)";
        }
      })
    );

    // Return table count as a convenience for the UI
    res.json({
      schema,
      tableCount: Object.keys(schema).length,
      database: process.env.PG_DATABASE
    });

  } catch (err) {
    console.error("Schema fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch schema: " + err.message });
  }
});

// ============================================================
// ROUTE: POST /generate-sql (No /api prefix, uses Axios)
// ============================================================
app.post("/generate-sql", async (req, res) => {
  try {
    const { question, schemaPrompt } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "Backend missing GROQ_API_KEY configuration." });
    }

    const systemPrompt = `You are an expert PostgreSQL query generator. Given a database schema and a natural language question, produce a single valid SQL SELECT query.\nRules:\n- Output ONLY valid SQL — no markdown, no explanation, no backticks\n- Use standard PostgreSQL syntax\n- Use table aliases for clarity when joining\n- Never use DROP, DELETE, UPDATE, INSERT or any DDL/DML\n- Always add ORDER BY and LIMIT when appropriate\n\n${schemaPrompt}`;

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant", // Active supported model
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Question: ${question}` }
      ],
      temperature: 0.1
    }, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      }
    });

    const sqlOutput = response.data.choices[0].message.content.replace(/```sql|```/g, "").trim();
    return res.json({ sql: sqlOutput });

  } catch (err) {
    console.error("Backend SQL generation error:", err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || "SQL generation failed." });
  }
});

// ============================================================
// ROUTE: POST /explain-sql (No /api prefix, uses Axios)
// ============================================================
app.post("/explain-sql", async (req, res) => {
  try {
    const { sql, question } = req.body;

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "Backend missing GROQ_API_KEY configuration." });
    }

    const response = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: "llama-3.1-8b-instant", // Active supported model
      messages: [
        { role: "system", content: "You explain SQL queries in plain English for non-technical users. Be concise (2-4 sentences). Explain what data is being retrieved and any filters/aggregations applied. No code formatting." },
        { role: "user", content: `Original question: "${question}"\n\nSQL:\n${sql}\n\nExplain this query in simple terms.` }
      ]
    }, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      }
    });

    return res.json({ explanation: response.data.choices[0].message.content.trim() });
  } catch (err) {
    console.error("Backend Explanation error:", err.message);
    return res.status(500).json({ error: err.response?.data?.error?.message || "Explanation failed on backend." });
  }
});


// ============================================================
// ROUTE: POST /query
// Validates and executes a SQL query against PostgreSQL
// ============================================================
app.post("/query", async (req, res) => {
  try {
    const { sql } = req.body;

    // 1. Run safety validation checks
    const validation = validateSQL(sql);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.reason });
    }

    // 2. Enforce a row limit cap automatically if none exists
    const finalSql = enforceLimitCap(sql);

    // 3. Track performance duration and run the query
    const startTime = Date.now();
    const dbResult = await pool.query(finalSql);
    const durationMs = Date.now() - startTime;

    // 4. Format the columns and rows into a matrix matching the frontend's expected format
    const columns = dbResult.fields.map(f => f.name);
    const rows = dbResult.rows.map(row => columns.map(col => row[col]));

    // 5. Send back structured database info
    return res.json({
      columns,
      rows,
      rowCount: dbResult.rowCount,
      durationMs
    });

  } catch (err) {
    console.error("Database execution error:", err.message);
    return res.status(500).json({ error: "Database error: " + err.message });
  }
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error." });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
  console.log(`🚀 NL-SQL Proxy running on port ${PORT}`);
  console.log(`   Allowed origins: ${allowedOrigins.join(", ")}`);
});
