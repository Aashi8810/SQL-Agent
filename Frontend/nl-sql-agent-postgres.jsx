import { useState, useRef, useEffect, useCallback } from "react";
import React from 'react';

// ============================================================
// CONFIG
// Point this at wherever your backend is deployed.
// In development: http://localhost:3001
// In production:  https://your-backend-domain.com
// ============================================================
const API_BASE = "http://localhost:3001";

// ============================================================
// MODULE 1: Schema Registry (now DYNAMIC)
// Fetched from the backend at runtime via GET /schema.
// Replaces the hardcoded SCHEMA_REGISTRY constant.
// The backend introspects information_schema so this always
// reflects your real PostgreSQL database structure.
// ============================================================

async function fetchLiveSchema() {
  const res = await fetch(`${API_BASE}/schema`);
  if (!res.ok) throw new Error("Failed to fetch schema from backend.");
  const { schema, database } = await res.json();
  return { schema, database };
}

// ============================================================
// MODULE 2: Schema Prompt Builder (now DYNAMIC)
// Same job as before — builds an LLM-readable context block —
// but now reads from the live schema instead of the registry.
// ============================================================

function buildSchemaPrompt(schema, database) {
  const lines = [
    `Database: ${database}`,
    `Dialect: PostgreSQL`,
    ``,
    `Tables:`
  ];
  for (const [table, meta] of Object.entries(schema)) {
    lines.push(`  ${table}(${meta.columns.join(", ")})`);
    if (meta.sample) lines.push(`    Sample: ${meta.sample}`);
  }
  return lines.join("\n");
}

// ============================================================
// MODULE 3: SQL Generator — Points to secure Backend Proxy
// ============================================================
async function generateSQL(question, schemaPrompt) {
  const response = await fetch("http://localhost:3001/generate-sql", { // No /api/
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, schemaPrompt })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.sql;
}

// ============================================================
// MODULE 4: SQL Explainer — Points to secure Backend Proxy
// ============================================================
// Inside explainSQL:
async function explainSQL(sql, question) {
  const response = await fetch("http://localhost:3001/explain-sql", { // No /api/
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, question })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.explanation;
}

// ============================================================
// MODULE 5: Query Executor — now calls the backend proxy
// Replaces the sql.js engine entirely.
// Sends the generated SQL to POST /query on your backend,
// which validates and runs it against PostgreSQL.
// Returns the same { columns, rows, rowCount } shape as before
// so all downstream modules (ResultsTable, history) are unchanged.
// ============================================================

async function executeSQL(sql) {
  const res = await fetch(`${API_BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql })
  });

  const data = await res.json();

  if (!res.ok || data.error) {
    throw new Error(data.error || "Query failed.");
  }

  return {
    columns: data.columns,
    rows: data.rows,
    rowCount: data.rowCount,
    durationMs: data.durationMs
  };
}

// ============================================================
// MODULE 6: REMOVED
// Database seeding is no longer needed — your real PostgreSQL
// database already has its own data. Schema introspection
// is handled by GET /schema on the backend.
// ============================================================

// ============================================================
// MODULE 7: Query History Manager (in-memory)
// Identical to the original — no changes needed.
// ============================================================

function useQueryHistory() {
  const [history, setHistory] = useState([]);
  const addEntry = useCallback((entry) => {
    setHistory(prev => [
      { ...entry, id: Date.now(), timestamp: new Date().toLocaleTimeString() },
      ...prev
    ].slice(0, 20));
  }, []);
  return { history, addEntry };
}

// ============================================================
// MODULE 8: Result Formatter / ResultsTable
// Identical to the original — no changes needed.
// ============================================================

function ResultsTable({ columns, rows }) {
  if (!columns.length) return (
    <div style={{ textAlign: "center", padding: "2rem", color: "var(--muted)", fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.85rem" }}>
      Query executed successfully — no rows returned
    </div>
  );
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem", fontFamily: "'IBM Plex Mono', monospace" }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col} style={{ padding: "0.5rem 0.75rem", textAlign: "left", background: "var(--surface2)", color: "var(--accent)", borderBottom: "1px solid var(--border)", fontWeight: 600, whiteSpace: "nowrap" }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ borderBottom: "1px solid var(--border)", background: ri % 2 === 0 ? "transparent" : "var(--surface2)" }}>
              {row.map((cell, ci) => (
                <td key={ci} style={{ padding: "0.45rem 0.75rem", color: "var(--fg)", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {cell === null
                    ? <span style={{ color: "var(--muted)", fontStyle: "italic" }}>NULL</span>
                    : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// SCHEMA PANEL — shows live table/column info in the sidebar
// New component — replaces the static schema selector buttons.
// ============================================================

function SchemaPanel({ schema, database, loading }) {
  const [expanded, setExpanded] = useState({});

  const toggle = (table) => setExpanded(prev => ({ ...prev, [table]: !prev[table] }));

  if (loading) return (
    <div style={{ color: "var(--muted)", fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.75rem", padding: "0.5rem 0" }}>
      Loading schema…
    </div>
  );

  if (!schema) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
      {Object.entries(schema).map(([table, meta]) => (
        <div key={table}>
          <button
            onClick={() => toggle(table)}
            style={{
              width: "100%", background: "transparent", border: "1px solid var(--border)",
              borderRadius: "5px", padding: "0.45rem 0.65rem", cursor: "pointer",
              textAlign: "left", display: "flex", justifyContent: "space-between",
              alignItems: "center", fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.75rem", color: "var(--fg)", transition: "all 0.15s"
            }}
          >
            <span style={{ fontWeight: 600 }}>{table}</span>
            <span style={{ color: "var(--muted)", fontSize: "0.65rem" }}>
              {meta.columns.length} cols {expanded[table] ? "▲" : "▼"}
            </span>
          </button>
          {expanded[table] && (
            <div style={{
              background: "var(--surface2)", border: "1px solid var(--border)",
              borderTop: "none", borderRadius: "0 0 5px 5px",
              padding: "0.4rem 0.65rem", display: "flex", flexWrap: "wrap", gap: "0.3rem"
            }}>
              {meta.columns.map(col => (
                <span key={col} style={{
                  background: "var(--surface)", border: "1px solid var(--border)",
                  borderRadius: "3px", padding: "1px 6px",
                  fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.65rem",
                  color: "var(--muted2)"
                }}>{col}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// MODULE 9: Main Application — NLSQLAgent
// Key changes vs original:
//   - No schemaKey / schema switcher (single live DB)
//   - fetchLiveSchema() on mount replaces initSQLEngine + seedDatabase
//   - executeSQL is now async (calls backend)
//   - Sidebar shows live table explorer instead of schema buttons
//   - Status bar shows query duration from the backend
// ============================================================

export default function NLSQLAgent() {
  // Core query state
  const [question, setQuestion] = useState("");
  const [state, setState] = useState("idle"); // idle | loading-schema | loading-sql | loading-exec | loading-explain | done | error
  const [generatedSQL, setGeneratedSQL] = useState("");
  const [explanation, setExplanation] = useState("");
  const [queryResult, setQueryResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [activeTab, setActiveTab] = useState("results");
  const [durationMs, setDurationMs] = useState(null);

  // Live schema state (replaces hardcoded SCHEMA_REGISTRY)
  const [liveSchema, setLiveSchema] = useState(null);
  const [dbName, setDbName] = useState("");
  const [schemaLoading, setSchemaLoading] = useState(true);
  const [schemaPrompt, setSchemaPrompt] = useState("");

  const { history, addEntry } = useQueryHistory();
  const textareaRef = useRef(null);

  // ── On mount: fetch live schema from backend ──────────────
  useEffect(() => {
    setState("loading-schema");
    fetchLiveSchema()
      .then(({ schema, database }) => {
        setLiveSchema(schema);
        setDbName(database);
        setSchemaPrompt(buildSchemaPrompt(schema, database));
        setSchemaLoading(false);
        setState("idle");
      })
      .catch(err => {
        setErrorMsg("Could not connect to backend: " + err.message);
        setState("error");
        setSchemaLoading(false);
      });
  }, []);

  // ── Main query pipeline ───────────────────────────────────
  const handleSubmit = async () => {
    if (!question.trim() || schemaLoading) return;
    setState("loading-sql");
    setGeneratedSQL(""); setQueryResult(null); setExplanation("");
    setErrorMsg(""); setActiveTab("results"); setDurationMs(null);

    try {
      // Step 1: Claude generates SQL using the live schema
      const sql = await generateSQL(question, schemaPrompt);
      setGeneratedSQL(sql);
      setState("loading-exec");

      // Step 2: Backend executes SQL against real PostgreSQL
      const result = await executeSQL(sql);
      setQueryResult(result);
      setDurationMs(result.durationMs);
      setState("loading-explain");
      setActiveTab("results");

      // Step 3: Claude explains the query in plain English
      const expl = await explainSQL(sql, question);
      setExplanation(expl);
      setState("done");

      addEntry({ question, sql, rowCount: result.rowCount });
    } catch (err) {
      setErrorMsg(err.message);
      setState("error");
    }
  };

  const handleHistoryReplay = (entry) => {
    setQuestion(entry.question);
    if (textareaRef.current) textareaRef.current.focus();
  };

  const isLoading = state.startsWith("loading");
  const dbReady = !schemaLoading && state !== "error";

  const stepLabel =
    state === "loading-schema"  ? "Connecting to database…" :
    state === "loading-sql"     ? "Generating SQL…" :
    state === "loading-exec"    ? "Executing query…" :
    state === "loading-explain" ? "Analyzing results…" : null;

  // ── Render ────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Syne:wght@400;600;700;800&display=swap');

        :root {
          --bg: #0a0c10;
          --surface: #111318;
          --surface2: #181c24;
          --border: #1f2535;
          --accent: #4fffb0;
          --accent2: #7c6fff;
          --accent3: #ff6b6b;
          --fg: #e2e8f4;
          --muted: #5a6580;
          --muted2: #8893b0;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        .nl-sql-root {
          background: var(--bg);
          min-height: 100vh;
          color: var(--fg);
          font-family: 'Syne', sans-serif;
          display: grid;
          grid-template-columns: 270px 1fr;
          grid-template-rows: 60px 1fr;
          height: 100vh;
          overflow: hidden;
        }

        .topbar {
          grid-column: 1 / -1;
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          padding: 0 1.5rem;
          gap: 1rem;
        }

        .topbar-logo {
          font-size: 1.1rem;
          font-weight: 800;
          letter-spacing: -0.02em;
          color: var(--accent);
        }
        .topbar-logo span { color: var(--fg); }

        .topbar-badge {
          background: var(--surface2);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 2px 8px;
          font-size: 0.7rem;
          font-family: 'IBM Plex Mono', monospace;
          color: var(--muted2);
          letter-spacing: 0.05em;
        }

        .db-status {
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.75rem;
          font-family: 'IBM Plex Mono', monospace;
          color: var(--muted2);
        }

        .status-dot {
          width: 7px; height: 7px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 6px var(--accent);
          animation: pulse 2s infinite;
        }
        .status-dot.offline { background: var(--accent3); box-shadow: 0 0 6px var(--accent3); }

        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

        .sidebar {
          background: var(--surface);
          border-right: 1px solid var(--border);
          overflow-y: auto;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .sidebar-section-title {
          font-size: 0.65rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 0.6rem;
          font-family: 'IBM Plex Mono', monospace;
        }

        .history-list { display: flex; flex-direction: column; gap: 0.35rem; }

        .history-item {
          background: transparent;
          border: 1px solid var(--border);
          border-radius: 5px;
          padding: 0.45rem 0.65rem;
          cursor: pointer;
          text-align: left;
          transition: all 0.15s;
          width: 100%;
        }
        .history-item:hover { background: var(--surface2); border-color: var(--muted); }

        .history-q {
          font-size: 0.72rem;
          color: var(--muted2);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-family: 'Syne', sans-serif;
        }

        .history-meta {
          font-size: 0.62rem;
          color: var(--muted);
          font-family: 'IBM Plex Mono', monospace;
          margin-top: 2px;
        }

        .main-panel {
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .query-bar {
          padding: 1.25rem 1.5rem;
          border-bottom: 1px solid var(--border);
          background: var(--surface);
        }

        .query-label {
          font-size: 0.65rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
          font-family: 'IBM Plex Mono', monospace;
          margin-bottom: 0.6rem;
        }

        .query-input-row {
          display: flex;
          gap: 0.75rem;
          align-items: flex-end;
        }

        .query-textarea {
          flex: 1;
          background: var(--surface2);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 0.75rem 1rem;
          color: var(--fg);
          font-family: 'Syne', sans-serif;
          font-size: 0.9rem;
          resize: none;
          min-height: 52px;
          max-height: 100px;
          outline: none;
          transition: border-color 0.15s;
          line-height: 1.5;
        }
        .query-textarea:focus { border-color: var(--accent); }
        .query-textarea::placeholder { color: var(--muted); }

        .run-btn {
          background: var(--accent);
          color: #0a0c10;
          border: none;
          border-radius: 8px;
          padding: 0.75rem 1.5rem;
          font-family: 'Syne', sans-serif;
          font-size: 0.85rem;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.15s;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          height: 52px;
        }
        .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .run-btn:not(:disabled):hover { background: #6fffbf; transform: translateY(-1px); }

        .results-area {
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          padding: 1.25rem 1.5rem;
          gap: 1rem;
        }

        .status-bar {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.78rem;
        }

        .loading-indicator {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          color: var(--accent);
        }

        .spinner {
          width: 14px; height: 14px;
          border: 2px solid var(--surface2);
          border-top-color: var(--accent);
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .result-stats {
          display: flex;
          gap: 1rem;
          align-items: center;
          flex-wrap: wrap;
        }

        .stat-pill {
          background: var(--surface2);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 2px 10px;
          font-size: 0.72rem;
          font-family: 'IBM Plex Mono', monospace;
          color: var(--muted2);
        }
        .stat-pill.highlight { border-color: var(--accent); color: var(--accent); }
        .stat-pill.speed { border-color: var(--accent2); color: var(--accent2); }

        .tabs {
          display: flex;
          gap: 0.25rem;
          border-bottom: 1px solid var(--border);
        }

        .tab-btn {
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          padding: 0.5rem 1rem;
          font-family: 'Syne', sans-serif;
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--muted2);
          cursor: pointer;
          transition: all 0.15s;
          margin-bottom: -1px;
        }
        .tab-btn:hover { color: var(--fg); }
        .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }

        .tab-content {
          flex: 1;
          overflow: auto;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
        }

        .sql-display {
          padding: 1rem 1.25rem;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.82rem;
          line-height: 1.7;
          white-space: pre-wrap;
          color: var(--fg);
        }

        .sql-keyword { color: var(--accent2); font-weight: 600; }
        .sql-comment { color: var(--muted); font-style: italic; }
        .sql-string  { color: #ffb347; }
        .sql-number  { color: #7cd4fd; }

        .explain-box {
          padding: 1.25rem;
          font-size: 0.88rem;
          color: var(--muted2);
          line-height: 1.7;
          font-family: 'Syne', sans-serif;
        }

        .error-box {
          background: rgba(255,107,107,0.08);
          border: 1px solid rgba(255,107,107,0.3);
          border-radius: 8px;
          padding: 1rem 1.25rem;
          color: var(--accent3);
          font-family: 'IBM Plex Mono', monospace;
          font-size: 0.82rem;
        }

        .empty-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: var(--muted);
          gap: 0.75rem;
          font-family: 'IBM Plex Mono', monospace;
        }

        .empty-icon { font-size: 2.5rem; opacity: 0.3; }

        .empty-text {
          font-size: 0.82rem;
          text-align: center;
          max-width: 300px;
          line-height: 1.6;
        }
      `}</style>

      <div className="nl-sql-root">

        {/* ── TOP BAR ── */}
        <header className="topbar">
          <div className="topbar-logo">NL<span>SQL</span></div>
          <div className="topbar-badge">AGENT v2.0</div>
          <div className="topbar-badge">CLAUDE SONNET 4</div>
          <div className="topbar-badge">POSTGRESQL</div>
          <div className="db-status">
            <div className={`status-dot ${dbReady ? "" : "offline"}`} />
            {schemaLoading
              ? "Connecting…"
              : dbReady
                ? `${dbName} · ${liveSchema ? Object.keys(liveSchema).length : 0} tables`
                : "Connection error"
            }
          </div>
        </header>

        {/* ── SIDEBAR ── */}
        <aside className="sidebar">
          <div>
            <div className="sidebar-section-title">Live Schema — {dbName}</div>
            <SchemaPanel
              schema={liveSchema}
              database={dbName}
              loading={schemaLoading}
            />
          </div>

          {history.length > 0 && (
            <div>
              <div className="sidebar-section-title">Recent Queries</div>
              <div className="history-list">
                {history.slice(0, 10).map(entry => (
                  <button
                    key={entry.id}
                    className="history-item"
                    onClick={() => handleHistoryReplay(entry)}
                  >
                    <div className="history-q">{entry.question}</div>
                    <div className="history-meta">
                      {entry.rowCount} rows · {entry.timestamp}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* ── MAIN PANEL ── */}
        <main className="main-panel">

          {/* Query input */}
          <div className="query-bar">
            <div className="query-label">Ask a question about your database in plain English</div>
            <div className="query-input-row">
              <textarea
                ref={textareaRef}
                className="query-textarea"
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
                placeholder={`e.g. "Show me the top 10 customers by revenue this month"`}
                rows={2}
                disabled={isLoading}
              />
              <button
                className="run-btn"
                onClick={handleSubmit}
                disabled={isLoading || !question.trim() || !dbReady}
              >
                {isLoading ? <><div className="spinner" /> Running</> : "▶ Run"}
              </button>
            </div>
          </div>

          {/* Results area */}
          <div className="results-area">

            {/* Loading status */}
            {isLoading && (
              <div className="status-bar">
                <div className="loading-indicator">
                  <div className="spinner" />
                  {stepLabel}
                </div>
              </div>
            )}

            {/* Success stats */}
            {state === "done" && queryResult && (
              <div className="status-bar">
                <div className="result-stats">
                  <div className="stat-pill highlight">{queryResult.rowCount} rows returned</div>
                  <div className="stat-pill">{queryResult.columns.length} columns</div>
                  {durationMs !== null && (
                    <div className="stat-pill speed">{durationMs}ms</div>
                  )}
                </div>
              </div>
            )}

            {/* Error */}
            {state === "error" && (
              <div className="error-box">⚠ {errorMsg}</div>
            )}

            {/* Tabs + content */}
            {(state === "done" || state === "loading-explain") && queryResult && (
              <>
                <div className="tabs">
                  <button
                    className={`tab-btn ${activeTab === "results" ? "active" : ""}`}
                    onClick={() => setActiveTab("results")}
                  >
                    Results {queryResult && `(${queryResult.rowCount})`}
                  </button>
                  <button
                    className={`tab-btn ${activeTab === "sql" ? "active" : ""}`}
                    onClick={() => setActiveTab("sql")}
                  >
                    SQL Query
                  </button>
                  <button
                    className={`tab-btn ${activeTab === "explain" ? "active" : ""}`}
                    onClick={() => setActiveTab("explain")}
                  >
                    Explanation
                  </button>
                </div>

                <div className="tab-content">
                  {activeTab === "results" && (
                    <ResultsTable columns={queryResult.columns} rows={queryResult.rows} />
                  )}
                  {activeTab === "sql" && <SQLHighlight sql={generatedSQL} />}
                  {activeTab === "explain" && (
                    <div className="explain-box">
                      {explanation || (
                        <span style={{ color: "var(--muted)" }}>Generating explanation…</span>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Idle empty state */}
            {state === "idle" && (
              <div className="empty-state">
                <div className="empty-icon">⌗</div>
                <div className="empty-text">
                  {schemaLoading
                    ? "Connecting to your PostgreSQL database…"
                    : `Connected to ${dbName}. Ask anything about your data.`
                  }
                </div>
              </div>
            )}

          </div>
        </main>
      </div>
    </>
  );
}

// ============================================================
// MODULE 10: SQL Syntax Highlighter
// Identical to the original — no changes needed.
// ============================================================

function SQLHighlight({ sql }) {
  const keywords = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP BY|ORDER BY|HAVING|LIMIT|AS|AND|OR|NOT|IN|IS|NULL|DISTINCT|COUNT|SUM|AVG|MAX|MIN|ROUND|COALESCE|CASE|WHEN|THEN|ELSE|END|BY|DESC|ASC|WITH|UNION|ALL|OFFSET|RETURNING|ILIKE|LIKE)\b/gi;

  const lines = sql.split("\n");

  return (
    <div className="sql-display">
      {lines.map((line, li) => {
        if (line.trim().startsWith("--")) {
          return <div key={li}><span className="sql-comment">{line}</span></div>;
        }
        const allMatches = [];
        let m;
        const kwRe = new RegExp(keywords.source, "gi");
        while ((m = kwRe.exec(line)) !== null)
          allMatches.push({ start: m.index, end: m.index + m[0].length, type: "kw", text: m[0] });
        const strRe = /'[^']*'/g;
        while ((m = strRe.exec(line)) !== null)
          allMatches.push({ start: m.index, end: m.index + m[0].length, type: "str", text: m[0] });
        const numRe = /\b\d+(\.\d+)?\b/g;
        while ((m = numRe.exec(line)) !== null)
          allMatches.push({ start: m.index, end: m.index + m[0].length, type: "num", text: m[0] });
        allMatches.sort((a, b) => a.start - b.start);
        const filtered = [];
        let cursor = 0;
        for (const tok of allMatches) {
          if (tok.start >= cursor) { filtered.push(tok); cursor = tok.end; }
        }
        const result = [];
        let pos = 0;
        for (const tok of filtered) {
          if (tok.start > pos) result.push(<span key={pos}>{line.slice(pos, tok.start)}</span>);
          const cls = tok.type === "kw" ? "sql-keyword" : tok.type === "str" ? "sql-string" : "sql-number";
          result.push(<span key={tok.start} className={cls}>{tok.text}</span>);
          pos = tok.end;
        }
        if (pos < line.length) result.push(<span key={pos}>{line.slice(pos)}</span>);
        return <div key={li}>{result}</div>;
      })}
    </div>
  );
}
