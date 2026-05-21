/* Root app — design canvas with all sections + artboards */

const { useState } = React;

/* Wrap any view in the standard Cursor-extension chrome (tab strip + status bar). */
function Chrome({ activeTab, children }) {
  return (
    <div className="app">
      <div className="titlebar">
        <div className="titlebar__brand">
          <span className="dot" />
          Symphony
          <span className="meta">main</span>
        </div>
        <div className="tabs">
          <button className="tab" data-active={activeTab==='dashboard'}>
            {Icon.dashboard()}<span>Dashboard</span>
          </button>
          <button className="tab" data-active={activeTab==='issues'}>
            {Icon.layout()}<span>Issues</span>
            <span className="badge">11</span>
          </button>
          <button className="tab" data-active={activeTab==='history'}>
            {Icon.history()}<span>Chat history</span>
            <span className="badge">4 live</span>
          </button>
        </div>
        <div className="titlebar__right">
          <button className="icon-btn">{Icon.search()}</button>
          <button className="icon-btn">{Icon.more()}</button>
        </div>
      </div>
      {children}
      <div className="statusbar">
        <span className="statusbar__seg"><span className="pulse" />4 agents running</span>
        <span className="statusbar__sep">·</span>
        <span className="statusbar__seg mono">openai/symphony@main</span>
        <span className="statusbar__sep">·</span>
        <span className="statusbar__seg mono">poll 22s · next in 8s</span>
        <div className="statusbar__right">
          <span className="statusbar__seg mono">linear · connected</span>
          <span className="statusbar__sep">·</span>
          <span className="statusbar__seg mono">codex app-server · v0.4.2</span>
          <span className="statusbar__sep">·</span>
          <span className="statusbar__seg mono">0 errors · 24h</span>
        </div>
      </div>
    </div>
  );
}

/* Cursor activity-bar + chrome wrapping a narrow sidebar webview. */
function SidebarChrome({ children, title='Symphony' }) {
  return (
    <div style={{
      display:'grid', gridTemplateColumns:'42px 1fr', height:'100%',
      background:'var(--bg)'
    }}>
      {/* activity bar */}
      <div style={{
        background:'#0a0a0c', borderRight:'1px solid var(--border)',
        display:'flex', flexDirection:'column', alignItems:'center', padding:'8px 0', gap:4
      }}>
        {[
          { icon: Icon.dashboard, active:false },
          { icon: Icon.layout, active:false },
          { icon: Icon.bolt, active:true },
          { icon: Icon.history, active:false },
          { icon: Icon.message, active:false },
        ].map((it, i) => (
          <button key={i} style={{
            width:30, height:30, display:'inline-flex', alignItems:'center', justifyContent:'center',
            borderRadius:5, color: it.active ? 'var(--text)' : 'var(--text-3)',
            background: it.active ? 'var(--elevated)' : 'transparent',
            position:'relative'
          }}>
            {it.active && <span style={{
              position:'absolute', left:-9, top:5, bottom:5, width:2, background:'var(--accent)', borderRadius:1
            }} />}
            <span style={{ width:16, height:16, display:'inline-flex' }}>{it.icon()}</span>
          </button>
        ))}
        <div style={{ flex:1 }} />
      </div>
      {children}
    </div>
  );
}

/* ============================================================
   Section / Artboard wrappers, with optional context labels
   ============================================================ */
function App() {
  return (
    <DesignCanvas
      title="Symphony Extension"
      subtitle="Cursor extension UI · dark-only · variations across views"
    >
      {/* ============== STYLE DIRECTIONS ============== */}
      <DCSection
        id="style-directions"
        title="A · Visual direction"
        subtitle="Three accent treatments on the project dashboard. The amber direction is the recommended primary — it makes 'agent running' read immediately. Cool-cyan reads calmer, Linear-faithful blends into Linear data."
      >
        <DCArtboard id="dash-amber"      label="Amber · agent-warm (recommended)" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="dashboard"><DashboardView variant="cards" /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="dash-cyan"       label="Cool-cyan · calmer" width={1400} height={900}>
          <ThemeFrame theme="cyan"><Chrome activeTab="dashboard"><DashboardView variant="cards" /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="dash-violet"     label="Violet · Linear-faithful" width={1400} height={900}>
          <ThemeFrame theme="violet"><Chrome activeTab="dashboard"><DashboardView variant="cards" /></Chrome></ThemeFrame>
        </DCArtboard>
      </DCSection>

      {/* ============== DASHBOARD COMPOSITIONS ============== */}
      <DCSection
        id="dashboard-comps"
        title="B · Project dashboard — compositions"
        subtitle="Same data, three takes. Cards is the calm default. Command-center exposes a terse, terminal-style status block above the panels. Dense-grid trades padding for a richer at-a-glance status breakdown."
      >
        <DCArtboard id="dash-cards"  label="B1 · Cards (default)" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="dashboard"><DashboardView variant="cards" /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="dash-cmd"    label="B2 · Command-center" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="dashboard"><DashboardView variant="command-center" /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="dash-grid"   label="B3 · Dense grid" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="dashboard"><DashboardView variant="grid" /></Chrome></ThemeFrame>
        </DCArtboard>
      </DCSection>

      {/* ============== ISSUES 3-COLUMN ============== */}
      <DCSection
        id="issues"
        title="C · Linear three-column — backlog · swimlane · detail"
        subtitle="The detail column is closeable. Two column proportions: balanced (280·flex·400) and detail-heavy (240·flex·480) — pick based on how much time you spend reading issue bodies vs. scanning the board."
      >
        <DCArtboard id="issues-balanced" label="C1 · Balanced · detail open" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="issues"><IssuesView variant="balanced" detailOpen={true} /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="issues-detail"   label="C2 · Detail-heavy · detail open" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="issues"><IssuesView variant="detail-heavy" detailOpen={true} /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="issues-closed"   label="C3 · Detail closed (board mode)" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="issues"><IssuesView variant="balanced" detailOpen={false} /></Chrome></ThemeFrame>
        </DCArtboard>
      </DCSection>

      {/* ============== CHAT HISTORY ============== */}
      <DCSection
        id="history"
        title="D · Chat history — layouts"
        subtitle="The 8 message types (system / user / assistant / thinking / tool_call / status / task / request) rendered three ways. List-and-transcript is the recommended default; flat timeline is useful for triage; focused transcript hides the list when reading deeply."
      >
        <DCArtboard id="hist-list"      label="D1 · Sessions list + transcript (recommended)" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="history"><ChatHistoryView variant="list" /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="hist-timeline"  label="D2 · Flat timeline (all sessions)" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="history"><ChatHistoryView variant="timeline" /></Chrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="hist-focused"   label="D3 · Transcript focused (list collapsed)" width={1400} height={900}>
          <ThemeFrame theme="amber"><Chrome activeTab="history"><ChatHistoryView variant="focused" /></Chrome></ThemeFrame>
        </DCArtboard>
      </DCSection>

      {/* ============== AGENT RUN STATE VISUAL LANGUAGE ============== */}
      <DCSection
        id="states"
        title="E · Agent run state — visual language"
        subtitle="One card per lifecycle state, in the exact form they appear inside the dashboard's Active sessions panel and the swimlane cards. The colored stripe + dot + spinner together give an unambiguous read at a glance."
      >
        <DCArtboard id="state-creating"  label="CREATING"  width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="creating" issue="SYM-42" title="Stream agent app-server updates to orchestrator"
              agent="codex-08" step="Acquiring workspace lock" duration="3s" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-running"   label="RUNNING"   width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="running" issue="SYM-12" title="Add exponential backoff to retry queue with jitter"
              agent="codex-04" step="Running mix test" duration="4m 41s" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-queued"    label="QUEUED"    width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="queued" issue="SYM-50" title="Document trust & safety posture"
              agent={null} step="Waiting for concurrency slot" duration="—" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-review"    label="HUMAN REVIEW" width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="review" issue="SYM-15" title="Workspace cleanup hook for terminal-state issues"
              agent="codex-02" step="PR #1248 awaiting review" duration="24m" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-finished"  label="FINISHED"  width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="finished" issue="SYM-52" title="Linear GraphQL query isolation + tests"
              agent="codex-06" step="Merged · #1190" duration="1h 14m" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-error"     label="ERROR"     width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="error" issue="SYM-09" title="Initial Linear tracker integration"
              agent="codex-11" step="rate-limit cascade — 429" duration="18s" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-cancelled" label="CANCELLED" width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="cancelled" issue="SYM-07" title="WORKFLOW.md loader"
              agent="codex-10" step="Cancelled by operator" duration="9s" />
          </div></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="state-expired"   label="EXPIRED"   width={320} height={170}>
          <ThemeFrame theme="amber"><div style={{ padding:14, background:'var(--bg)', height:'100%' }}>
            <AgentStateCard state="expired" issue="SYM-03" title="Workspace prune (terminal)"
              agent="codex-—" step="Idle 30m — released" duration="30m" />
          </div></ThemeFrame>
        </DCArtboard>
      </DCSection>

      {/* ============== SIDEBAR WEBVIEWS ============== */}
      <DCSection
        id="sidebar"
        title="F · Sidebar webview — at a glance"
        subtitle="Same system, narrow webview form factor (about 380px wide). Three opt-in panels: primary status, orchestrator chat, and chat history list. All open in Cursor's secondary sidebar."
      >
        <DCArtboard id="sb-primary" label="F1 · Status panel" width={380} height={780}>
          <ThemeFrame theme="amber"><SidebarChrome><SidebarPrimary /></SidebarChrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="sb-chat"    label="F2 · Orchestrator chat" width={380} height={780}>
          <ThemeFrame theme="amber"><SidebarChrome><SidebarChat /></SidebarChrome></ThemeFrame>
        </DCArtboard>
        <DCArtboard id="sb-history" label="F3 · Chat history list" width={380} height={780}>
          <ThemeFrame theme="amber"><SidebarChrome><SidebarHistory /></SidebarChrome></ThemeFrame>
        </DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}

/* Theme frame — sets CSS variables for accent direction.
   The base styles inherit, only --accent / --accent-soft / --accent-strong /
   running-state dot color shift between themes. */
function ThemeFrame({ theme, children }) {
  const themes = {
    amber: {
      '--accent': '#f0b86c',
      '--accent-soft': 'rgba(240,184,108,0.14)',
      '--accent-strong': '#ffc77a',
      '--run-active': '#f0b86c',
      '--st-progress': '#f0b86c',
    },
    cyan: {
      '--accent': '#6cd2e1',
      '--accent-soft': 'rgba(108,210,225,0.14)',
      '--accent-strong': '#86dfee',
      '--run-active': '#6cd2e1',
      '--st-progress': '#6cd2e1',
    },
    violet: {
      '--accent': '#a78bfa',
      '--accent-soft': 'rgba(167,139,250,0.14)',
      '--accent-strong': '#b8a1ff',
      '--run-active': '#a78bfa',
      '--st-progress': '#e8a55a',
    },
  };
  return (
    <div style={{ ...themes[theme], height:'100%', width:'100%', background:'var(--bg)' }}>
      {children}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
