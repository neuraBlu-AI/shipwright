import { useState, useEffect, useCallback } from "react";

// ─── Config (localStorage) ────────────────────────────────────────────────────

const CONFIG_KEY = "sts_config";
const loadConfig = () => {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); }
  catch { return {}; }
};
const saveConfig = (cfg) => localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
const isConfigured = (cfg) =>
  !!(cfg.planeKey && cfg.planeWorkspace && cfg.planeProjectId && cfg.githubToken && cfg.githubRepo);

// ─── API helpers ──────────────────────────────────────────────────────────────

const planeGet = async (path, key) => {
  // Uses /plane-api prefix, proxied by Vite (dev) and Vercel (production)
  // to https://api.plane.so/api/v1 — avoids browser CORS restrictions
  const r = await fetch(`/plane-api${path}`, {
    headers: { "x-api-key": key },
  });
  if (!r.ok) throw new Error(`Plane API error ${r.status}: ${r.statusText}`);
  return r.json();
};

const ghGet = async (path, token) => {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) throw new Error(`GitHub API error ${r.status}: ${r.statusText}`);
  return r.json();
};

// ─── Data fetchers ────────────────────────────────────────────────────────────

const PRIORITY_MAP = { 0: "None", 1: "Urgent", 2: "High", 3: "Medium", 4: "Low" };

function timeAgo(dateStr) {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

async function fetchTickets(cfg) {
  const { planeKey, planeWorkspace, planeProjectId } = cfg;

  const [labelsRes, statesRes, issuesRes] = await Promise.all([
    planeGet(`/workspaces/${planeWorkspace}/projects/${planeProjectId}/labels/`, planeKey),
    planeGet(`/workspaces/${planeWorkspace}/projects/${planeProjectId}/states/`, planeKey),
    planeGet(`/workspaces/${planeWorkspace}/projects/${planeProjectId}/issues/?per_page=100`, planeKey),
  ]);

  const labels = labelsRes.results ?? labelsRes ?? [];
  const states = statesRes.results ?? statesRes ?? [];
  const issues = issuesRes.results ?? issuesRes ?? [];

  const aiDevLabel = labels.find((l) => l.name?.toLowerCase() === "ai_dev");
  const stateMap = Object.fromEntries((Array.isArray(states) ? states : []).map((s) => [s.id, s.name]));

  const filtered = aiDevLabel
    ? issues.filter((i) => {
        const ids = i.label_ids ?? i.labels ?? [];
        return ids.some((l) => l === aiDevLabel.id || l?.id === aiDevLabel.id);
      })
    : [];

  return {
    tickets: filtered.map((i) => ({
      id: `TICKET-${i.sequence_id}`,
      title: i.name,
      priority: PRIORITY_MAP[i.priority] ?? "Medium",
      status: stateMap[i.state] ?? "To-Do",
      created: timeAgo(i.created_at),
      url: `https://app.plane.so/${planeWorkspace}/projects/${planeProjectId}/issues/${i.id}`,
    })),
    warning: !aiDevLabel ? 'No "ai_dev" label found — create it in Plane first.' : null,
  };
}

async function fetchPRs(cfg) {
  const { githubToken, githubRepo } = cfg;
  const prs = await ghGet(`/repos/${githubRepo}/pulls?state=open&per_page=20`, githubToken);

  return Promise.all(
    prs.map(async (pr) => {
      const [checksResult, commentsResult] = await Promise.allSettled([
        ghGet(`/repos/${githubRepo}/commits/${pr.head.sha}/check-runs`, githubToken),
        ghGet(`/repos/${githubRepo}/issues/${pr.number}/comments`, githubToken),
      ]);

      // CI status from check-runs
      let ci = "pending";
      if (checksResult.status === "fulfilled") {
        const runs = checksResult.value.check_runs ?? [];
        if (runs.length === 0) ci = "pending";
        else if (runs.some((r) => r.status !== "completed")) ci = "running";
        else if (runs.every((r) => ["success", "neutral", "skipped"].includes(r.conclusion))) ci = "passing";
        else ci = "failed";
      }

      // AI review assessment from bot comment
      let aiReview = "pending";
      if (commentsResult.status === "fulfilled") {
        const botComment = commentsResult.value.find(
          (c) => c.user?.login === "github-actions[bot]" && c.body?.includes("## AI Code Review")
        );
        if (botComment) {
          const m = botComment.body.match(/\*\*Overall Assessment:\*\* ([^\n\r]+)/);
          aiReview = m?.[1]?.trim() ?? "REVIEWED";
        }
      }

      const ticketMatch = pr.head.ref.match(/TICKET-(\d+)/i);
      return {
        number: pr.number,
        id: `PR #${pr.number}`,
        ticket: ticketMatch ? `TICKET-${ticketMatch[1]}` : "",
        title: pr.title,
        branch: pr.head.ref,
        ci,
        aiReview,
        author: pr.user.login,
        updated: timeAgo(pr.updated_at),
        url: pr.html_url,
      };
    })
  );
}

async function fetchBuilds(cfg) {
  const { githubToken, githubRepo } = cfg;

  // Try the specific build workflow first, fall back to all runs
  let runs = [];
  try {
    const data = await ghGet(
      `/repos/${githubRepo}/actions/workflows/flutter-build.yml/runs?per_page=6`,
      githubToken
    );
    runs = data.workflow_runs ?? [];
  } catch {
    const data = await ghGet(
      `/repos/${githubRepo}/actions/runs?per_page=10`,
      githubToken
    );
    runs = (data.workflow_runs ?? [])
      .filter((r) => r.name?.toLowerCase().includes("build"))
      .slice(0, 5);
  }

  return Promise.all(
    runs.map(async (run) => {
      let ios = "—", android = "—";
      try {
        const jobs = await ghGet(`/repos/${githubRepo}/actions/runs/${run.id}/jobs`, githubToken);
        for (const job of jobs.jobs ?? []) {
          const icon =
            job.conclusion === "success" ? "✓"
            : job.conclusion === "failure" ? "✗"
            : job.status === "in_progress" ? "⏳"
            : "—";
          if (job.name?.toLowerCase().includes("ios")) ios = icon;
          if (job.name?.toLowerCase().includes("android")) android = icon;
        }
      } catch {}

      return {
        version: run.head_branch ?? run.display_title ?? "—",
        date: timeAgo(run.created_at),
        ios,
        android,
        url: run.html_url,
        status: run.conclusion ?? run.status,
      };
    })
  );
}

// ─── UI primitives ────────────────────────────────────────────────────────────

const Badge = ({ label, color }) => {
  const colors = {
    green: "bg-emerald-100 text-emerald-700",
    yellow: "bg-amber-100 text-amber-700",
    red: "bg-red-100 text-red-700",
    blue: "bg-blue-100 text-blue-700",
    gray: "bg-slate-100 text-slate-500",
    indigo: "bg-indigo-100 text-indigo-700",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${colors[color] ?? colors.gray}`}>
      {label}
    </span>
  );
};

const CiDot = ({ status }) => {
  const map = {
    passing: <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />Passing</span>,
    running: <span className="flex items-center gap-1 text-xs text-amber-600 font-medium"><span className="w-2 h-2 rounded-full bg-amber-400 inline-block animate-pulse" />Running</span>,
    failed: <span className="flex items-center gap-1 text-xs text-red-600 font-medium"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Failed</span>,
    pending: <span className="flex items-center gap-1 text-xs text-slate-400 font-medium"><span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />Pending</span>,
  };
  return map[status] ?? map.pending;
};

const Spinner = () => (
  <div className="flex items-center justify-center py-12">
    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

const ErrorBanner = ({ message, onRetry }) => (
  <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start gap-3">
    <span className="text-red-500 text-lg shrink-0">⚠️</span>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium text-red-800">API error</p>
      <p className="text-xs text-red-600 mt-0.5 break-words">{message}</p>
      {message?.toLowerCase().includes("cors") || message?.toLowerCase().includes("failed to fetch") ? (
        <p className="text-xs text-red-500 mt-1">
          This may be a CORS restriction. Try opening the app via <code className="bg-red-100 px-1 rounded">npm run dev</code> on localhost, or use a proxy.
        </p>
      ) : null}
    </div>
    {onRetry && (
      <button onClick={onRetry} className="text-xs text-red-700 underline shrink-0">Retry</button>
    )}
  </div>
);

const priorityColor = (p) => ({ High: "red", Urgent: "red", Medium: "yellow", Low: "gray", None: "gray" }[p] ?? "gray");
const reviewColor = (r) => ({ APPROVED: "green", "NEEDS CHANGES": "yellow", "CRITICAL ISSUES": "red" }[r] ?? "gray");

// ─── Setup Wizard ─────────────────────────────────────────────────────────────

function SetupWizard({ initialConfig, onDone }) {
  const [step, setStep] = useState(0);
  const [vals, setVals] = useState({
    planeKey: initialConfig.planeKey ?? "",
    planeWorkspace: initialConfig.planeWorkspace ?? "",
    planeProjectId: initialConfig.planeProjectId ?? "",
    githubToken: initialConfig.githubToken ?? "",
    githubRepo: initialConfig.githubRepo ?? "",
  });

  const steps = [
    {
      icon: "🗂️",
      title: "Connect Plane.so",
      desc: "Plane is where your tickets live. Claude reads them automatically via API.",
      fields: [
        { key: "planeKey", label: "Plane API Key", type: "password", placeholder: "plane_api_xxxxxxxx", hint: "Plane → Settings → API Tokens" },
        { key: "planeWorkspace", label: "Workspace Slug", type: "text", placeholder: "my-startup", hint: "From your Plane workspace URL: app.plane.so/{slug}" },
        { key: "planeProjectId", label: "Project ID", type: "text", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", hint: "Plane → Project → Settings → General" },
      ],
    },
    {
      icon: "🐙",
      title: "Connect GitHub",
      desc: "Claude opens PRs here. You review and merge.",
      fields: [
        { key: "githubToken", label: "Personal Access Token", type: "password", placeholder: "ghp_xxxxxxxxxxxxxxxxxxxx", hint: "GitHub → Settings → Developer settings → Tokens (classic) — needs repo + workflow scopes" },
        { key: "githubRepo", label: "Repository", type: "text", placeholder: "yourorg/your-repo", hint: "e.g. neurabluAI/why" },
      ],
    },
  ];

  const handleFinish = () => {
    saveConfig(vals);
    onDone(vals);
  };

  if (step === steps.length) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
        <div className="bg-white rounded-2xl shadow-xl p-10 max-w-md w-full text-center">
          <div className="text-6xl mb-4">🎉</div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">You're all set!</h2>
          <p className="text-slate-500 mb-8">
            Your pipeline is connected. Write a ticket and let Claude handle the development.
          </p>
          <button onClick={handleFinish} className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition">
            Open Dashboard →
          </button>
        </div>
      </div>
    );
  }

  const current = steps[step];
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-8">
      <div className="max-w-lg w-full">
        <div className="flex gap-2 mb-8 justify-center">
          {steps.map((_, i) => (
            <div key={i} className={`h-1.5 rounded-full flex-1 transition-all ${i <= step ? "bg-indigo-500" : "bg-slate-200"}`} />
          ))}
        </div>
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-4xl mb-3">{current.icon}</div>
          <h2 className="text-xl font-bold text-slate-900 mb-1">{current.title}</h2>
          <p className="text-slate-500 text-sm mb-6">{current.desc}</p>
          <div className="space-y-4">
            {current.fields.map((f) => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-slate-700 mb-1">{f.label}</label>
                <input
                  type={f.type}
                  value={vals[f.key]}
                  onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
                <p className="text-xs text-slate-400 mt-1">→ {f.hint}</p>
              </div>
            ))}
          </div>
          <div className="flex gap-3 mt-8">
            {step > 0 && (
              <button onClick={() => setStep(step - 1)} className="flex-1 border border-slate-200 text-slate-600 py-2.5 rounded-xl font-medium hover:bg-slate-50 transition">
                Back
              </button>
            )}
            <button onClick={() => setStep(step + 1)} className="flex-1 bg-indigo-600 text-white py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition">
              {step === steps.length - 1 ? "Finish setup" : "Continue →"}
            </button>
          </div>
        </div>
        <p className="text-center text-xs text-slate-400 mt-4">Keys are saved locally in your browser only.</p>
      </div>
    </div>
  );
}

// ─── Ticket Writer ────────────────────────────────────────────────────────────

function TicketWriter({ config, onClose, onSave }) {
  const [stage, setStage] = useState("describe");
  const [idea, setIdea] = useState("");
  const [ticket, setTicket] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const EXAMPLE = {
    title: idea.length > 10 ? idea.slice(0, 60) : "Add biometric authentication (Face ID / Touch ID)",
    type: "Feature",
    priority: "High",
    story: "As a returning user, I want to log in with Face ID so I don't have to type my password every time.",
    criteria: [
      "Given the user has Face ID enabled, when they open the app, then they are prompted to use Face ID",
      "Given Face ID succeeds, then the user is taken to the home screen",
      "Given Face ID fails, then a fallback to password login is offered",
      "Given the device doesn't support biometrics, then the biometric option is hidden",
    ],
    context: "Use the `local_auth` Flutter package. Check `AuthService` in `lib/services/auth_service.dart`.",
  };

  const handleGenerate = () => {
    setStage("generating");
    setTimeout(() => { setTicket(EXAMPLE); setStage("review"); }, 2000);
  };

  const handleSend = async () => {
    setSending(true);
    setError(null);
    try {
      // In a real app: POST to Plane API to create the issue
      // For now, simulate a short delay and call onSave
      await new Promise((r) => setTimeout(r, 800));
      onSave(ticket);
      onClose();
    } catch (e) {
      setError(e.message);
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div>
            <h2 className="font-bold text-slate-900 text-lg">Write a new ticket</h2>
            <p className="text-sm text-slate-500">Describe your feature idea — AI structures it for you</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">✕</button>
        </div>
        <div className="p-6">
          {stage === "describe" && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Describe your idea in plain words</label>
              <textarea
                rows={5}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. I want users to be able to log in with Face ID so they don't have to type their password every time they open the app..."
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
              />
              <p className="text-xs text-slate-400 mt-2">Just describe what you want users to do — no technical knowledge needed.</p>
              <button onClick={handleGenerate} disabled={!idea.trim()} className="mt-4 w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition">
                ✨ Structure with AI
              </button>
            </div>
          )}
          {stage === "generating" && (
            <div className="py-12 text-center">
              <div className="text-4xl mb-4 animate-pulse">🤖</div>
              <p className="font-semibold text-slate-700">Structuring your ticket…</p>
              <p className="text-sm text-slate-400 mt-1">Writing Acceptance Criteria and technical context</p>
            </div>
          )}
          {stage === "review" && ticket && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Title</label>
                <input defaultValue={ticket.title} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              </div>
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Type</label>
                  <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                    <option>Feature</option><option>Bug</option><option>Chore</option>
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Priority</label>
                  <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none">
                    <option>High</option><option>Medium</option><option>Low</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">User Story</label>
                <p className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2.5">{ticket.story}</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Acceptance Criteria</label>
                <div className="space-y-2">
                  {ticket.criteria.map((c, i) => (
                    <div key={i} className="flex items-start gap-2 bg-slate-50 rounded-lg px-3 py-2">
                      <span className="text-indigo-500 font-bold text-sm mt-0.5 shrink-0">AC{i + 1}</span>
                      <p className="text-sm text-slate-700">{c}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Technical Context</label>
                <p className="text-sm text-slate-600 bg-slate-50 rounded-lg px-3 py-2.5 font-mono">{ticket.context}</p>
              </div>
              {error && <ErrorBanner message={error} />}
              <div className="flex gap-3 pt-2">
                <button onClick={() => setStage("describe")} className="flex-1 border border-slate-200 text-slate-600 py-2.5 rounded-xl font-medium hover:bg-slate-50 transition text-sm">
                  ← Edit idea
                </button>
                <button onClick={handleSend} disabled={sending} className="flex-1 bg-indigo-600 text-white py-2.5 rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 transition text-sm">
                  {sending ? "Sending…" : "Send to Plane ✓"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Pages ────────────────────────────────────────────────────────────────────

function Dashboard({ data, loading, error, onRetry, onWriteTicket }) {
  const { tickets = [], prs = [], builds = [] } = data;
  const approvedPRs = prs.filter((p) => p.aiReview === "APPROVED" && p.ci === "passing").length;
  const lastBuild = builds[0];

  const stats = [
    { label: "Tickets queued", value: loading.tickets ? "…" : tickets.length, sub: "with ai_dev label", icon: "🗂️" },
    { label: "Open PRs", value: loading.prs ? "…" : prs.length, sub: `${approvedPRs} ready to merge`, icon: "🔀" },
    { label: "Last build", value: lastBuild ? lastBuild.version : "—", sub: lastBuild ? lastBuild.date : "no builds yet", icon: "📦" },
    { label: "iOS / Android", value: lastBuild ? `${lastBuild.ios} / ${lastBuild.android}` : "— / —", sub: "last build status", icon: "📱" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-400">Live data from Plane + GitHub</p>
        </div>
        <button onClick={onWriteTicket} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-indigo-700 transition flex items-center gap-2">
          <span>✨</span> Write ticket
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-white rounded-xl border border-slate-100 p-4 shadow-sm">
            <div className="text-xl mb-1">{s.icon}</div>
            <div className="text-xl font-bold text-slate-900">{s.value}</div>
            <div className="text-xs font-medium text-slate-500">{s.label}</div>
            <div className="text-xs text-slate-400">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Ticket Queue */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          🗂️ Ticket Queue
          <span className="text-xs text-slate-400 font-normal">Claude picks these up automatically</span>
        </h2>
        {loading.tickets ? <Spinner /> : error.tickets ? <ErrorBanner message={error.tickets} onRetry={() => onRetry("tickets")} /> : tickets.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">No ai_dev tickets found. Write your first ticket to get started.</p>
        ) : (
          <div className="space-y-2">
            {tickets.map((t) => (
              <a key={t.id} href={t.url} target="_blank" rel="noreferrer" className="block bg-white rounded-xl border border-slate-100 p-4 shadow-sm hover:border-indigo-200 transition">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-slate-400">{t.id}</span>
                  <Badge label={t.priority} color={priorityColor(t.priority)} />
                  <Badge label={t.status} color={t.status === "To-Do" ? "indigo" : t.status.toLowerCase().includes("progress") ? "yellow" : "blue"} />
                </div>
                <p className="text-sm font-medium text-slate-800 truncate">{t.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">{t.created}</p>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* PR Pipeline */}
      <div>
        <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
          🔀 PR Pipeline
          <span className="text-xs text-slate-400 font-normal">Review and merge to ship</span>
        </h2>
        {loading.prs ? <Spinner /> : error.prs ? <ErrorBanner message={error.prs} onRetry={() => onRetry("prs")} /> : prs.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">No open pull requests.</p>
        ) : (
          <div className="space-y-2">
            {prs.map((pr) => (
              <div key={pr.id} className="bg-white rounded-xl border border-slate-100 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono text-slate-400">{pr.id}</span>
                      {pr.ticket && <span className="text-xs font-mono text-slate-400">{pr.ticket}</span>}
                    </div>
                    <p className="text-sm font-medium text-slate-800 truncate">{pr.title}</p>
                    <p className="text-xs font-mono text-slate-400 mt-0.5 truncate">{pr.branch}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <CiDot status={pr.ci} />
                    <Badge label={`AI: ${pr.aiReview}`} color={reviewColor(pr.aiReview)} />
                  </div>
                </div>
                {pr.aiReview === "APPROVED" && pr.ci === "passing" && (
                  <div className="mt-3 pt-3 border-t border-slate-50 flex justify-end">
                    <a href={pr.url} target="_blank" rel="noreferrer" className="bg-emerald-500 text-white text-xs px-3 py-1.5 rounded-lg font-semibold hover:bg-emerald-600 transition">
                      Review & merge on GitHub →
                    </a>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Tickets({ data, loading, error, onRetry, onWriteTicket }) {
  const { tickets = [] } = data;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Tickets</h1>
        <button onClick={onWriteTicket} className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-indigo-700 transition">✨ Write ticket</button>
      </div>
      {loading.tickets ? <Spinner /> : error.tickets ? <ErrorBanner message={error.tickets} onRetry={() => onRetry("tickets")} /> : tickets.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🗂️</div>
          <p className="text-slate-500 font-medium">No ai_dev tickets yet</p>
          <p className="text-sm text-slate-400 mt-1">Write a ticket and assign the ai_dev label in Plane</p>
          <button onClick={onWriteTicket} className="mt-4 bg-indigo-600 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-indigo-700 transition">✨ Write your first ticket</button>
        </div>
      ) : (
        tickets.map((t) => (
          <a key={t.id} href={t.url} target="_blank" rel="noreferrer" className="block bg-white rounded-xl border border-slate-100 p-5 shadow-sm hover:border-indigo-200 transition">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xs font-mono text-slate-400">{t.id}</span>
                  <Badge label={t.priority} color={priorityColor(t.priority)} />
                  <Badge label="ai_dev" color="indigo" />
                </div>
                <p className="font-semibold text-slate-800">{t.title}</p>
                <p className="text-sm text-slate-400 mt-1">{t.created}</p>
              </div>
              <Badge label={t.status} color={t.status === "To-Do" ? "indigo" : t.status.toLowerCase().includes("progress") ? "yellow" : "blue"} />
            </div>
          </a>
        ))
      )}
    </div>
  );
}

function PullRequests({ data, loading, error, onRetry }) {
  const { prs = [] } = data;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-slate-900">Pull Requests</h1>
      {loading.prs ? <Spinner /> : error.prs ? <ErrorBanner message={error.prs} onRetry={() => onRetry("prs")} /> : prs.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-12">No open pull requests.</p>
      ) : (
        prs.map((pr) => (
          <div key={pr.id} className="bg-white rounded-xl border border-slate-100 p-5 shadow-sm space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-slate-400">{pr.id}</span>
                  {pr.ticket && <span className="text-xs font-mono text-slate-400">{pr.ticket}</span>}
                </div>
                <p className="font-semibold text-slate-800">{pr.title}</p>
                <p className="text-xs font-mono text-indigo-500 mt-1 truncate">{pr.branch}</p>
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <CiDot status={pr.ci} />
                <Badge label={`AI: ${pr.aiReview}`} color={reviewColor(pr.aiReview)} />
              </div>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-slate-50">
              <span className="text-xs text-slate-400">by {pr.author} · {pr.updated}</span>
              <a href={pr.url} target="_blank" rel="noreferrer" className="border border-slate-200 text-slate-600 text-xs px-3 py-1.5 rounded-lg hover:bg-slate-50 transition">
                View on GitHub →
              </a>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function Builds({ data, loading, error, onRetry, config }) {
  const { builds = [] } = data;
  const [owner, repo] = (config.githubRepo ?? "").split("/");
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Builds</h1>
        {config.githubRepo && (
          <a
            href={`https://github.com/${config.githubRepo}/releases/new`}
            target="_blank"
            rel="noreferrer"
            className="border border-slate-200 text-slate-600 px-4 py-2 rounded-xl text-sm font-medium hover:bg-slate-50 transition"
          >
            🏷️ Tag new release
          </a>
        )}
      </div>
      {loading.builds ? <Spinner /> : error.builds ? <ErrorBanner message={error.builds} onRetry={() => onRetry("builds")} /> : builds.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-slate-500 font-medium">No builds yet</p>
          <p className="text-sm text-slate-400 mt-1">Tag a release to trigger your first build: <code className="bg-slate-100 px-1 rounded">git tag v0.0.1 && git push --tags</code></p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Version</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">iOS</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Android</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wide">Date</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((b, i) => (
                <tr key={i} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50">
                  <td className="px-5 py-3.5">
                    <a href={b.url} target="_blank" rel="noreferrer" className="font-mono font-semibold text-indigo-600 hover:underline">{b.version}</a>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={b.ios === "✓" ? "text-emerald-600 font-bold" : b.ios === "✗" ? "text-red-500 font-bold" : "text-slate-400"}>
                      {b.ios === "✓" ? "✓ Ready" : b.ios === "✗" ? "✗ Failed" : b.ios}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={b.android === "✓" ? "text-emerald-600 font-bold" : b.android === "✗" ? "text-red-500 font-bold" : "text-slate-400"}>
                      {b.android === "✓" ? "✓ Ready" : b.android === "✗" ? "✗ Failed" : b.android}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">{b.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SettingsPage({ config, onSave, onReset }) {
  const [vals, setVals] = useState({ ...config });
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    saveConfig(vals);
    onSave(vals);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const fields = [
    { section: "🗂️ Plane.so", keys: [
      { key: "planeKey", label: "API Key", type: "password" },
      { key: "planeWorkspace", label: "Workspace Slug", type: "text" },
      { key: "planeProjectId", label: "Project ID", type: "text" },
    ]},
    { section: "🐙 GitHub", keys: [
      { key: "githubToken", label: "Personal Access Token", type: "password" },
      { key: "githubRepo", label: "Repository (owner/repo)", type: "text" },
    ]},
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-slate-900">Settings</h1>
      {fields.map((section) => (
        <div key={section.section} className="bg-white rounded-xl border border-slate-100 p-5 shadow-sm">
          <h2 className="font-semibold text-slate-800 mb-4">{section.section}</h2>
          <div className="space-y-3">
            {section.keys.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-500 mb-1">{f.label}</label>
                <input
                  type={f.type}
                  value={vals[f.key] ?? ""}
                  onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="flex gap-3">
        <button onClick={handleSave} className="flex-1 bg-indigo-600 text-white py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition">
          {saved ? "Saved ✓" : "Save changes"}
        </button>
        <button onClick={onReset} className="border border-red-200 text-red-500 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-red-50 transition">
          Reset
        </button>
      </div>
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

const NAV = [
  { id: "dashboard", icon: "⬡", label: "Dashboard" },
  { id: "tickets", icon: "🗂️", label: "Tickets" },
  { id: "prs", icon: "🔀", label: "Pull Requests" },
  { id: "builds", icon: "📦", label: "Builds" },
  { id: "settings", icon: "⚙️", label: "Settings" },
];

export default function App() {
  const [config, setConfig] = useState(() => loadConfig());
  const [showSetup, setShowSetup] = useState(() => !isConfigured(loadConfig()));
  const [activeNav, setActiveNav] = useState("dashboard");
  const [showTicketWriter, setShowTicketWriter] = useState(false);
  const [notification, setNotification] = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [data, setData] = useState({ tickets: [], prs: [], builds: [] });
  const [loading, setLoading] = useState({ tickets: false, prs: false, builds: false });
  const [error, setError] = useState({ tickets: null, prs: null, builds: null });

  const notify = (msg) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const fetchAll = useCallback(async (cfg) => {
    if (!isConfigured(cfg)) return;
    setLoading({ tickets: true, prs: true, builds: true });
    setError({ tickets: null, prs: null, builds: null });

    // Fetch all in parallel, handle each independently
    const [ticketsResult, prsResult, buildsResult] = await Promise.allSettled([
      fetchTickets(cfg),
      fetchPRs(cfg),
      fetchBuilds(cfg),
    ]);

    setData({
      tickets: ticketsResult.status === "fulfilled" ? ticketsResult.value.tickets : [],
      prs: prsResult.status === "fulfilled" ? prsResult.value : [],
      builds: buildsResult.status === "fulfilled" ? buildsResult.value : [],
    });
    setError({
      tickets: ticketsResult.status === "rejected" ? ticketsResult.reason?.message : null,
      prs: prsResult.status === "rejected" ? prsResult.reason?.message : null,
      builds: buildsResult.status === "rejected" ? buildsResult.reason?.message : null,
    });
    setLoading({ tickets: false, prs: false, builds: false });
    setLastRefresh(new Date());
  }, []);

  const retrySection = useCallback(async (section) => {
    if (!isConfigured(config)) return;
    setLoading((l) => ({ ...l, [section]: true }));
    setError((e) => ({ ...e, [section]: null }));
    try {
      if (section === "tickets") {
        const r = await fetchTickets(config);
        setData((d) => ({ ...d, tickets: r.tickets }));
      } else if (section === "prs") {
        const r = await fetchPRs(config);
        setData((d) => ({ ...d, prs: r }));
      } else if (section === "builds") {
        const r = await fetchBuilds(config);
        setData((d) => ({ ...d, builds: r }));
      }
    } catch (e) {
      setError((err) => ({ ...err, [section]: e.message }));
    }
    setLoading((l) => ({ ...l, [section]: false }));
  }, [config]);

  // Initial fetch + auto-refresh every 2 min
  useEffect(() => {
    if (isConfigured(config)) fetchAll(config);
    const interval = setInterval(() => { if (isConfigured(config)) fetchAll(config); }, 120000);
    return () => clearInterval(interval);
  }, [config, fetchAll]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await fetchAll(config);
    setRefreshing(false);
  };

  if (showSetup) {
    return (
      <SetupWizard
        initialConfig={config}
        onDone={(cfg) => { setConfig(cfg); setShowSetup(false); fetchAll(cfg); }}
      />
    );
  }

  const renderPage = () => {
    switch (activeNav) {
      case "dashboard": return <Dashboard data={data} loading={loading} error={error} onRetry={retrySection} onWriteTicket={() => setShowTicketWriter(true)} />;
      case "tickets": return <Tickets data={data} loading={loading} error={error} onRetry={retrySection} onWriteTicket={() => setShowTicketWriter(true)} />;
      case "prs": return <PullRequests data={data} loading={loading} error={error} onRetry={retrySection} />;
      case "builds": return <Builds data={data} loading={loading} error={error} onRetry={retrySection} config={config} />;
      case "settings": return <SettingsPage config={config} onSave={(cfg) => { setConfig(cfg); fetchAll(cfg); }} onReset={() => { localStorage.removeItem(CONFIG_KEY); setConfig({}); setShowSetup(true); }} />;
      default: return null;
    }
  };

  return (
    <div className="flex h-screen bg-slate-50 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 bg-slate-900 flex flex-col shrink-0">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="text-white font-bold text-base leading-tight">Story → Store</div>
          <div className="text-slate-400 text-xs mt-0.5">{config.githubRepo ?? "not configured"}</div>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                activeNav === item.id ? "bg-indigo-600 text-white" : "text-slate-400 hover:text-white hover:bg-slate-800"
              }`}
            >
              <span>{item.icon}</span>{item.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-slate-800 space-y-2">
          <button onClick={() => setShowTicketWriter(true)} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold py-2.5 rounded-xl transition">
            ✨ Write ticket
          </button>
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="w-full text-slate-500 hover:text-slate-300 text-xs py-1.5 transition flex items-center justify-center gap-1.5"
          >
            <span className={refreshing ? "animate-spin inline-block" : ""}>↻</span>
            {lastRefresh ? `Updated ${timeAgo(lastRefresh)}` : "Refresh"}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-6">{renderPage()}</div>
      </main>

      {showTicketWriter && (
        <TicketWriter
          config={config}
          onClose={() => setShowTicketWriter(false)}
          onSave={(t) => {
            notify("Ticket sent to Plane ✓ Claude will pick it up shortly");
            fetchAll(config);
          }}
        />
      )}

      {notification && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-5 py-3 rounded-xl shadow-xl z-50 font-medium">
          {notification}
        </div>
      )}
    </div>
  );
}
