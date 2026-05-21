/* The three main views + sidebar variants + agent-state cards.
   Each view accepts a `variant` prop to render different compositions. */

const D = () => window.SYM_DATA;

/* ============================================================
   CHAT HISTORY VIEW
   variant: 'list' (sessions left + transcript right)
            'timeline' (flat event timeline)
            'focused' (transcript fills, sessions collapsed)
   ============================================================ */
function ChatHistoryView({ variant = 'list' }) {
  const data = D();
  const session = data.sessions.find(s => s.id === 'sess_01HZ8…b4f');
  // expand the tool_call at index 9 (mix test) and the first tool_call (read_file)
  const openIdx = new Set([5, 9, 10]);

  if (variant === 'timeline') {
    return <FlatTimeline />;
  }

  return (
    <div className="history">
      {variant !== 'focused' && <SessionsList selectedId={session.id} />}
      <TranscriptPane session={session} openSet={openIdx} variant={variant} />
    </div>
  );
}

function SessionsList({ selectedId }) {
  const data = D();
  return (
    <div className="history__sessions">
      <div className="colhead">
        <h3>Sessions <span className="count">{data.sessions.length}</span></h3>
        <div className="grow" />
        <button className="icon-btn" title="Filter">{Icon.filter()}</button>
        <button className="icon-btn" title="Sort">{Icon.sort()}</button>
      </div>
      <div className="sessions__filter">
        <button className="pill" data-active="true">All</button>
        <button className="pill">Running <span style={{color:'var(--accent)', marginLeft:4}}>4</span></button>
        <button className="pill">Finished</button>
        <button className="pill">Errors</button>
      </div>
      <div className="sessions__list">
        {data.sessions.map(s => (
          <div className="session-row" key={s.id} data-selected={s.id===selectedId}>
            <span className="ico"><StatusBadgeDot state={s.state} /></span>
            <div className="info">
              <div className="top">
                <span className="id">{s.issue}</span>
                <SessionStateChip state={s.state} />
              </div>
              <div className="t">{s.title}</div>
              <div className="meta">
                <span>{s.model}</span>
                <span style={{color:'var(--text-4)'}}>·</span>
                <span>{s.msgCount} msgs</span>
                <span style={{color:'var(--text-4)'}}>·</span>
                <span>{s.toolCount} tools</span>
              </div>
              <div className="meta" style={{color:'var(--text-4)'}}>
                {s.lastEvent}
              </div>
            </div>
            <div className="right">{s.updatedAt}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusBadgeDot({ state }) {
  const color = {
    running:'var(--run-active)', finished:'var(--run-done)',
    error:'var(--run-error)', cancelled:'var(--text-3)', queued:'var(--run-queued)'
  }[state] || 'var(--text-3)';
  return (
    <span style={{
      display:'inline-block', width:8, height:8, borderRadius:999,
      background: color,
      boxShadow: state==='running' ? '0 0 0 3px rgba(240,184,108,0.15)' : 'none',
      animation: state==='running' ? 'pulse 1.6s ease-in-out infinite' : 'none'
    }} />
  );
}

function SessionStateChip({ state }) {
  const map = {
    running:  { cls:'statbadge--running',   label:'RUNNING' },
    finished: { cls:'statbadge--finished',  label:'FINISHED' },
    error:    { cls:'statbadge--error',     label:'ERROR' },
    cancelled:{ cls:'statbadge--cancelled', label:'CANCELLED' },
    queued:   { cls:'statbadge--creating',  label:'QUEUED' },
  }[state] || { cls:'statbadge--pending', label:state.toUpperCase() };
  return <span className={`statbadge ${map.cls}`}><span className="d" />{map.label}</span>;
}

function TranscriptPane({ session, openSet, variant }) {
  const data = D();
  return (
    <div className="transcript-wrap">
      <div className="transcript-head">
        <div>
          <h2>{session.title}</h2>
          <div className="meta">
            <span style={{color:'var(--text-2)', fontFamily:'var(--font-sans)'}}>
              <strong style={{color:'var(--text)', fontWeight:500}}>{session.issue}</strong>
            </span>
            <SessionStateChip state={session.state} />
            <span>{session.model}</span>
            <span style={{color:'var(--text-4)'}}>·</span>
            <span>{session.id}</span>
            <span style={{color:'var(--text-4)'}}>·</span>
            <span>{session.msgCount} messages · {session.toolCount} tools</span>
          </div>
        </div>
        <div className="right">
          <button className="btn"><span>{Icon.branch()}</span>Open workspace</button>
          <button className="btn"><span>{Icon.link()}</span>SYM-12</button>
          <button className="icon-btn" title="More">{Icon.more()}</button>
        </div>
      </div>
      <div className="transcript">
        {data.transcript.map((m, i) => (
          <Message key={i} m={m} open={openSet.has(i)} />
        ))}
      </div>
    </div>
  );
}

/* ----- variant: flat timeline (all sessions interleaved) ----- */
function FlatTimeline() {
  const data = D();
  // Synthesize a flat timeline from sessions + activity feed for visual purposes
  const events = [
    { t:'just now', sess:'SYM-12', kind:'tool_call', text:'shell.run · mix test', state:'running' },
    { t:'30s ago',  sess:'SYM-42', kind:'request',   text:'awaiting operator approval' },
    { t:'1m ago',   sess:'SYM-18', kind:'tool_call', text:'read_file lib/symphony/tracker.ex', state:'finished' },
    { t:'1m ago',   sess:'SYM-25', kind:'assistant', text:'Editing dispatcher.ex — replacing constant with backoff_ms/1' },
    { t:'2m ago',   sess:'SYM-12', kind:'task',      text:'Tests pass — 12/12 examples, 0 failures' },
    { t:'3m ago',   sess:'SYM-12', kind:'tool_call', text:'edit_file · test/symphony/dispatcher_test.exs', state:'finished' },
    { t:'4m ago',   sess:'SYM-25', kind:'thinking',  text:'The semaphore should be per-workflow, not per-orchestrator. Adjusting interface…' },
    { t:'5m ago',   sess:'SYM-37', kind:'task',      text:'Opened PR #1255 → main' },
    { t:'8m ago',   sess:'SYM-42', kind:'tool_call', text:'shell.run · iex -S mix · stalled', state:'running' },
    { t:'12m ago',  sess:'SYM-25', kind:'tool_call', text:'apply_patch · lib/symphony/dispatcher.ex', state:'finished' },
    { t:'14m ago',  sess:'SYM-12', kind:'status',    text:'CREATING → RUNNING' },
    { t:'14m ago',  sess:'SYM-12', kind:'user',      text:'Issue: Add exponential backoff to retry queue with jitter…' },
    { t:'18m ago',  sess:'SYM-15', kind:'task',      text:'Reached Human Review — PR #1248' },
    { t:'22m ago',  sess:'SYM-42', kind:'status',    text:'CREATING → RUNNING' },
    { t:'48m ago',  sess:'SYM-25', kind:'status',    text:'RETRY (attempt 2/3, backoff 8s)' },
  ];

  return (
    <div className="history" style={{ gridTemplateColumns:'1fr' }}>
      <div className="transcript-wrap">
        <div className="transcript-head">
          <div>
            <h2>Activity timeline</h2>
            <div className="meta">
              <span>All sessions · last 1h</span>
              <span style={{color:'var(--text-4)'}}>·</span>
              <span>4 running · 7 finished</span>
              <span style={{color:'var(--text-4)'}}>·</span>
              <span>live</span>
              <span className="pulse" style={{
                width:6, height:6, borderRadius:999, background:'var(--accent)',
                boxShadow:'0 0 0 2px rgba(240,184,108,0.18)',
                display:'inline-block', animation:'pulse 1.6s ease-in-out infinite'
              }} />
            </div>
          </div>
          <div className="right">
            <button className="btn">{Icon.filter()}Filter</button>
            <button className="btn">Group by session</button>
          </div>
        </div>
        <div className="transcript" style={{ padding:'12px 24px 60px' }}>
          {events.map((e, i) => <TimelineRow key={i} e={e} />)}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({ e }) {
  const av = {
    user:'av--user', assistant:'av--assist', thinking:'av--thinking',
    tool_call:'av--tool', status:'av--status', task:'av--task', request:'av--request',
    system:'av--system'
  }[e.kind] || 'av--status';
  const label = {
    user:'User prompt', assistant:'Assistant', thinking:'Thinking',
    tool_call:'Tool call', status:'Status', task:'Task', request:'Request', system:'System'
  }[e.kind];

  return (
    <div style={{
      display:'grid',
      gridTemplateColumns:'70px 26px 1fr auto',
      alignItems:'center', gap:14,
      padding:'8px 0',
      borderBottom:'1px solid var(--border-subtle)',
      fontSize:12
    }}>
      <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-4)' }}>{e.t}</span>
      <span className={`av ${av}`} style={{ width:22, height:22, borderRadius:5, fontSize:9, display:'inline-flex', alignItems:'center', justifyContent:'center' }}>
        {{user:'U',assistant:'A',thinking:'…',tool_call:'⚙',status:'•',task:'✓',request:'?',system:'S'}[e.kind]}
      </span>
      <div style={{ display:'flex', flexDirection:'column', gap:2, minWidth:0 }}>
        <div style={{ display:'flex', gap:8, alignItems:'center', fontSize:11, color:'var(--text-3)' }}>
          <span style={{ fontWeight:500, color:'var(--text-2)' }}>{label}</span>
          <span style={{ color:'var(--text-4)' }}>·</span>
          <span style={{ fontFamily:'var(--font-mono)', color:'var(--text-2)' }}>{e.sess}</span>
          {e.state ? <StatusBadge state={e.state} /> : null}
        </div>
        <div style={{ color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {e.text}
        </div>
      </div>
      <span style={{ color:'var(--text-4)', fontFamily:'var(--font-mono)', fontSize:10.5 }}>open →</span>
    </div>
  );
}

/* ============================================================
   ISSUES VIEW — three columns (backlog | swimlane | detail)
   variant: 'balanced' or 'detail-heavy'
   ============================================================ */
function IssuesView({ variant = 'balanced', detailOpen = true }) {
  const data = D();
  const selectedId = 'SYM-12';
  const selected = data.issues.find(i => i.id === selectedId);

  const inProgress = data.issues.filter(i => i.status === 'progress');
  const inReview   = data.issues.filter(i => i.status === 'review');
  const todo       = data.issues.filter(i => i.status === 'todo');

  const cols = variant === 'detail-heavy'
    ? '240px minmax(0, 1fr) 480px'
    : '280px minmax(0, 1fr) 400px';

  return (
    <div className="issues" data-detail={detailOpen} style={{ gridTemplateColumns: detailOpen ? cols : `${cols.split(' ').slice(0,2).join(' ')} 0` }}>
      <BacklogCol selectedId={selectedId} />
      <SwimlanesCol cols={{ todo, progress: inProgress, review: inReview }} selectedId={selectedId} />
      {detailOpen && <DetailCol issue={selected} />}
    </div>
  );
}

function BacklogCol({ selectedId }) {
  const data = D();
  const backlog = data.issues.filter(i => i.status === 'backlog' || i.status === 'todo')
                              .sort((a,b) => priorityWeight(b.priority) - priorityWeight(a.priority));

  return (
    <div className="issues__col">
      <div className="colhead">
        <h3>Backlog <span className="count">{backlog.length}</span></h3>
        <div className="grow" />
        <button className="icon-btn" title="Filter">{Icon.filter()}</button>
        <button className="icon-btn" title="Sort">{Icon.sort()}</button>
        <button className="icon-btn" title="New issue">{Icon.plus()}</button>
      </div>
      <div style={{ minHeight:0, overflow:'hidden', display:'flex', flexDirection:'column' }}>
        <div className="backlog__search">
          <div className="field">
            {Icon.search()}
            <input placeholder="Filter by title, label, project…" />
            <span className="kbd">⌘K</span>
          </div>
        </div>
        <div className="backlog__body">
          {backlog.map(i => (
            <div className="backlog__item" key={i.id} data-selected={i.id===selectedId}>
              <StatusIcon state={i.status} />
              <div className="ttl">
                <div style={{display:'flex', alignItems:'center', gap:6}}>
                  <span className="id">{i.id}</span>
                  <Priority level={i.priority} />
                </div>
                <span className="t">{i.title}</span>
              </div>
              <div className="right">
                {i.labels.slice(0,1).map(l => <span key={l} className="swatch-dot" style={{
                  width:7, height:7, borderRadius:999,
                  background: data.labels[l]?.color || 'var(--text-4)'
                }} />)}
                <Avatar user={i.assignee} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function priorityWeight(p) { return p === 'urgent' ? 4 : (typeof p === 'number' ? p : 0); }

function SwimlanesCol({ cols, selectedId }) {
  return (
    <div className="issues__col">
      <div className="colhead">
        <h3>Symphony · Cycle 14</h3>
        <span className="count" style={{fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-3)'}}>
          May 15 – May 29
        </span>
        <div className="grow" />
        <button className="btn btn--ghost" style={{padding:'3px 8px'}}>Group: status</button>
        <button className="icon-btn">{Icon.filter()}</button>
      </div>
      <div className="swimlanes">
        <Swimlane title="Todo" state="todo" items={cols.todo} selectedId={selectedId} />
        <Swimlane title="In Progress" state="progress" items={cols.progress} selectedId={selectedId} />
        <Swimlane title="In Review" state="review" items={cols.review} selectedId={selectedId} />
      </div>
    </div>
  );
}

function Swimlane({ title, state, items, selectedId }) {
  return (
    <div className="swim">
      <div className="swim__head">
        <h4><StatusIcon state={state} />{title}<span className="count">{items.length}</span></h4>
        <div className="grow" />
        <button className="icon-btn">{Icon.plus()}</button>
      </div>
      <div className="swim__body">
        {items.map(i => <IssueCard key={i.id} issue={i} selected={i.id===selectedId} />)}
      </div>
    </div>
  );
}

function IssueCard({ issue, selected }) {
  const data = D();
  const running = issue.assignee === 'agent';
  return (
    <div className="card" data-selected={selected} style={
      running ? { boxShadow:'inset 2px 0 0 var(--accent)' } : null
    }>
      <div className="card__top">
        <span>{issue.id}</span>
        <Priority level={issue.priority} />
        <div className="grow" />
        {issue.pr ? <span style={{ display:'inline-flex', alignItems:'center', gap:4, color:'var(--link)' }}>
          <span style={{width:11, height:11, display:'inline-block'}}>{Icon.pr()}</span>
          {issue.pr}
        </span> : null}
      </div>
      <div className="card__title">{issue.title}</div>
      <div className="card__bottom">
        <div className="labels">
          {issue.labels.slice(0,2).map(l => <Label key={l} name={l} />)}
        </div>
        <div className="grow" />
        {running && (
          <span className="card__agent">
            <span className="pulse-dot" />{issue.agent}
          </span>
        )}
        <Avatar user={issue.assignee} />
      </div>
    </div>
  );
}

function DetailCol({ issue }) {
  const data = D();
  return (
    <div className="issues__col">
      <div className="colhead">
        <h3 style={{fontFamily:'var(--font-mono)', fontSize:11.5, color:'var(--text-3)'}}>{issue.id}</h3>
        <div className="grow" />
        <button className="icon-btn" title="Open in Linear">{Icon.link()}</button>
        <button className="icon-btn" title="More">{Icon.more()}</button>
        <button className="icon-btn" title="Close">{Icon.close()}</button>
      </div>
      <div className="detail">
        <div className="detail__head">
          <div className="detail__crumbs">
            <span>Symphony</span>
            <span style={{color:'var(--text-4)'}}>/</span>
            <span>{issue.project}</span>
            <span style={{color:'var(--text-4)'}}>/</span>
            <span>{issue.cycle}</span>
            <div className="grow" />
          </div>
          <h1 className="detail__title">{issue.title}</h1>
          <div className="detail__actions">
            <button className="btn"><StatusIcon state={issue.status} />{STATUS_LABEL[issue.status]}</button>
            <button className="btn"><Priority level={issue.priority} />High</button>
            <button className="btn"><Avatar user={issue.assignee} /> {data.users[issue.assignee]?.name}</button>
          </div>
        </div>
        <div className="detail__body">
          <div className="detail__section">
            <h4>Properties</h4>
            <div className="props">
              <span className="k">Status</span>
              <span className="v"><StatusIcon state={issue.status} />{STATUS_LABEL[issue.status]}</span>
              <span className="k">Priority</span>
              <span className="v"><Priority level={issue.priority} />High</span>
              <span className="k">Assignee</span>
              <span className="v"><Avatar user={issue.assignee} />{data.users[issue.assignee]?.name}</span>
              <span className="k">Labels</span>
              <span className="v">{issue.labels.map(l => <Label key={l} name={l} />)}</span>
              <span className="k">Project</span>
              <span className="v">{issue.project}</span>
              <span className="k">Cycle</span>
              <span className="v">{issue.cycle}</span>
            </div>
          </div>
          <div className="detail__section">
            <h4>Description</h4>
            <div className="markdown">
              {(issue.desc || ['No description.']).map((p,i) => <p key={i}>{p}</p>)}
              <h5>Acceptance</h5>
              <ul>
                <li>Backoff curve: <code>min(4_000 * 2^(attempt-1), 300_000)</code> ms.</li>
                <li>Apply full jitter via <code>:rand.uniform/1</code>.</li>
                <li>Cover with unit + property tests.</li>
                <li>Document the chosen curve in <code>WORKFLOW.md</code>.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   DASHBOARD VIEW
   variant: 'cards' (default — generous, panel-led)
            'command-center' (denser, terminal-feeling)
            'grid' (data-dense, more compact stats)
   ============================================================ */
function DashboardView({ variant = 'cards' }) {
  const data = D();
  const totals = computeTotals(data.issues);

  return (
    <div className="dashboard" style={ variant==='command-center' ? { gridTemplateColumns:'minmax(0,1fr) 480px' } : null }>
      <div className="dash__main" style={ variant==='command-center' ? { padding:'18px 22px 40px' } : null }>
        <div className="dash__header">
          <div>
            <h1 className="dash__title">Symphony · main</h1>
            <div className="dash__subtitle">
              <span>openai/symphony</span>
              <span className="sep">·</span>
              <span>WORKFLOW.md@main</span>
              <span className="sep">·</span>
              <span>poll 22s</span>
              <span className="sep">·</span>
              <span style={{color:'var(--accent)'}}>● 4/6 agents</span>
            </div>
          </div>
          <div className="dash__actions">
            <button className="btn">{Icon.filter()}Cycle 14</button>
            <button className="btn">{Icon.bolt()}Trigger poll</button>
            <button className="btn btn--primary">New issue</button>
          </div>
        </div>

        {variant === 'grid' ? <StatsGridDense totals={totals} /> : <StatsRow totals={totals} />}

        {variant === 'command-center'
          ? <BurndownCommandCenter totals={totals} />
          : <BurndownPanel totals={totals} />}

        <div className="section-head">
          <h2>Running agents</h2>
          <span className="right">{data.runningAgents.length} active · concurrency cap 6</span>
        </div>

        <div className="panels" style={ variant==='grid' ? { gridTemplateColumns:'1fr 1fr 1fr' } : null }>
          <div className="panel" style={ variant==='grid' ? null : { gridColumn:'1 / 2' } }>
            <div className="panel__head">
              <span>Active sessions</span>
              <span className="count">{data.runningAgents.length}</span>
            </div>
            <div className="panel__body">
              {data.runningAgents.map(a => <AgentRow key={a.id} a={a} />)}
            </div>
          </div>

          <div className="panel" style={ variant==='grid' ? null : { gridColumn:'2 / 3' } }>
            <div className="panel__head">
              <span>Activity feed</span>
              <span style={{display:'inline-flex', alignItems:'center', gap:6, fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)'}}>
                <span style={{
                  width:6, height:6, borderRadius:999, background:'var(--accent)',
                  animation:'pulse 1.6s ease-in-out infinite'
                }} />
                live
              </span>
            </div>
            <div className="panel__body">
              {data.activity.slice(0, variant==='grid' ? 10 : 8).map((a, i) => (
                <div className="activity-row" key={i}>
                  <span className="dot" style={{ background: dotColorForVerb(a.verb) }} />
                  <span className="text">
                    <span className="id">{a.who}</span>{' '}
                    <span className="verb">{a.verb}</span>{' '}
                    <span className="id">{a.id}</span>{' '}
                    <span className="verb">{a.extra}</span>
                  </span>
                  <span className="time">{a.t}</span>
                </div>
              ))}
            </div>
          </div>

          {variant === 'grid' && (
            <div className="panel">
              <div className="panel__head">
                <span>Velocity · last 14 days</span>
                <span className="count">+24</span>
              </div>
              <div style={{ padding:'14px 14px 18px' }}>
                <Sparkline />
              </div>
            </div>
          )}
        </div>
      </div>

      <OrchestratorChat />
    </div>
  );
}

function computeTotals(issues) {
  const by = { backlog:0, todo:0, progress:0, review:0, done:0, cancelled:0 };
  for (const i of issues) by[i.status]++;
  const open = by.backlog + by.todo + by.progress + by.review;
  const all = open + by.done + by.cancelled;
  const completeness = Math.round((by.done / all) * 100);
  return { ...by, open, all, completeness };
}

function dotColorForVerb(v) {
  if (v.includes('completed') || v.includes('finished') || v.includes('merged') || v.includes('reached')) return 'var(--st-done)';
  if (v.includes('retry') || v.includes('error')) return 'var(--pri-urgent)';
  if (v.includes('dispatched') || v.includes('started') || v.includes('opened')) return 'var(--accent)';
  return 'var(--text-3)';
}

function StatsRow({ totals }) {
  return (
    <div className="stats">
      <div className="stat">
        <div className="stat__label">Completeness</div>
        <div className="stat__value">{totals.completeness}<span className="suffix">%</span></div>
        <div className="completeness-bar"><div style={{ width: `${totals.completeness}%` }} /></div>
        <div className="stat__delta stat__delta--up">▲ 12% this cycle</div>
      </div>
      <div className="stat">
        <div className="stat__label">Running agents</div>
        <div className="stat__value">4<span className="suffix">/ 6</span></div>
        <div style={{ display:'flex', gap:3, marginTop:8 }}>
          {[1,1,1,1,0,0].map((on,i) =>
            <span key={i} style={{
              flex:1, height:4, borderRadius:2,
              background: on ? 'var(--accent)' : 'var(--elevated)'
            }} />
          )}
        </div>
        <div className="stat__delta">avg 18m / session</div>
      </div>
      <div className="stat">
        <div className="stat__label">Open issues</div>
        <div className="stat__value">{totals.open}</div>
        <div style={{display:'flex', gap:8, marginTop:8, fontSize:11, color:'var(--text-3)', fontFamily:'var(--font-mono)'}}>
          <span><span style={{color:'var(--st-todo)'}}>●</span> {totals.todo} todo</span>
          <span><span style={{color:'var(--st-progress)'}}>●</span> {totals.progress} prog</span>
          <span><span style={{color:'var(--st-review)'}}>●</span> {totals.review} review</span>
        </div>
        <div className="stat__delta">{totals.backlog} in backlog</div>
      </div>
      <div className="stat">
        <div className="stat__label">Velocity / ETA</div>
        <div className="stat__value">3.2<span className="suffix">PR/day</span></div>
        <div style={{ marginTop:8 }}><Sparkline tiny /></div>
        <div className="stat__delta stat__delta--warn">ETA: cycle ends ~3 days early</div>
      </div>
    </div>
  );
}

function StatsGridDense({ totals }) {
  return (
    <div className="stats" style={{ gridTemplateColumns:'repeat(6, 1fr)' }}>
      <DenseStat label="Done" value={totals.done} sub="this cycle" color="var(--st-done)" />
      <DenseStat label="In Review" value={totals.review} sub="awaiting" color="var(--st-review)" />
      <DenseStat label="In Progress" value={totals.progress} sub="running" color="var(--st-progress)" />
      <DenseStat label="Todo" value={totals.todo} sub="dispatchable" color="var(--st-todo)" />
      <DenseStat label="Backlog" value={totals.backlog} sub="" color="var(--st-backlog)" />
      <DenseStat label="Completeness" value={`${totals.completeness}%`} sub="cycle 14" color="var(--accent)" emphasis />
    </div>
  );
}

function DenseStat({ label, value, sub, color, emphasis }) {
  return (
    <div className="stat" style={{ minHeight: 78, padding:'10px 12px 9px' }}>
      <div className="stat__label" style={{ marginBottom:4 }}>
        <span style={{ width:7, height:7, borderRadius:2, background: color, display:'inline-block' }} />
        {label}
      </div>
      <div className="stat__value" style={{ fontSize: emphasis ? 24 : 20 }}>{value}</div>
      <div className="stat__delta">{sub}</div>
    </div>
  );
}

function BurndownPanel({ totals }) {
  // simple "burn-up" line — completed vs target over cycle days
  return (
    <div className="panel" style={{ marginBottom:0 }}>
      <div className="panel__head">
        <span>Burn-up · Cycle 14</span>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)' }}>
          {totals.done}/{totals.all} done · 7 days left
        </span>
      </div>
      <div style={{ padding:'14px 18px 18px' }}>
        <BurnupChart />
      </div>
    </div>
  );
}

function BurndownCommandCenter({ totals }) {
  return (
    <div className="panel" style={{ borderRadius:6, background:'#0a0a0c' }}>
      <div className="panel__head" style={{ padding:'8px 14px', borderBottom:'1px solid var(--border)' }}>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)', letterSpacing:'0.06em', textTransform:'uppercase' }}>
          ./symphony status --cycle 14
        </span>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--accent)' }}>
          ● live
        </span>
      </div>
      <div style={{ padding:'12px 16px 14px', fontFamily:'var(--font-mono)', fontSize:11.5, color:'var(--text-2)', lineHeight:1.65 }}>
        <div><span style={{color:'var(--text-3)'}}>cycle      </span> 14 · May 15 – May 29 · <span style={{color:'var(--text)'}}>7 days remaining</span></div>
        <div><span style={{color:'var(--text-3)'}}>completion </span> <span style={{color:'var(--st-done)'}}>{totals.completeness}%</span> ({totals.done}/{totals.all}) · projected <span style={{color:'var(--st-done)'}}>96%</span></div>
        <div><span style={{color:'var(--text-3)'}}>velocity   </span> <span style={{color:'var(--accent)'}}>3.2 PR/day</span> · 7d avg · 14d trend ↑</div>
        <div><span style={{color:'var(--text-3)'}}>agents     </span> <span style={{color:'var(--accent)'}}>4 running</span> / 6 cap · 0 queued · 0 retrying</div>
        <div><span style={{color:'var(--text-3)'}}>review     </span> 3 PRs in Human Review · oldest 24m</div>
        <div><span style={{color:'var(--text-3)'}}>health     </span> <span style={{color:'var(--st-done)'}}>nominal</span> · last poll 8s ago · 0 errors in 24h</div>
      </div>
    </div>
  );
}

function BurnupChart() {
  // SVG line chart — completed (solid amber) vs target (dashed)
  const W = 700, H = 160;
  const completed = [0, 2, 3, 5, 6, 8, 11, 13];
  const target    = [0, 2.4, 4.8, 7.2, 9.6, 12, 14.4, 16.8];
  const days = 14;
  const max = 17;
  const dx = (W - 30) / 13;
  const sy = (y) => H - 18 - (y / max) * (H - 36);
  const sx = (i) => 18 + i * dx;

  const pathC = completed.map((y,i) => `${i?'L':'M'}${sx(i)},${sy(y)}`).join(' ');
  const pathT = target.map((y,i) => `${i?'L':'M'}${sx(i)},${sy(y)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:160 }}>
      {/* grid */}
      {[0, 5, 10, 15].map(v =>
        <line key={v} x1="18" x2={W-12} y1={sy(v)} y2={sy(v)} stroke="var(--border-subtle)" strokeWidth="1" />
      )}
      {/* target */}
      <path d={pathT} fill="none" stroke="var(--text-3)" strokeWidth="1.3" strokeDasharray="3 3" opacity="0.7" />
      {/* completed */}
      <path d={pathC} fill="none" stroke="var(--accent)" strokeWidth="2" />
      {/* fill under completed */}
      <path d={`${pathC} L${sx(7)},${sy(0)} L${sx(0)},${sy(0)} Z`} fill="var(--accent-soft)" />
      {/* points */}
      {completed.map((y,i) => <circle key={i} cx={sx(i)} cy={sy(y)} r="2.5" fill="var(--accent)" />)}
      {/* projection (dashed continuation) */}
      <path d={`M${sx(7)},${sy(13)} L${sx(13)},${sy(17)}`} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2 3" opacity="0.55" />
      <circle cx={sx(13)} cy={sy(17)} r="3" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      {/* today marker */}
      <line x1={sx(7)} x2={sx(7)} y1="6" y2={H-12} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="2 3" />
      <text x={sx(7)+4} y="16" fill="var(--text-3)" fontSize="10" fontFamily="var(--font-mono)">today</text>
      {/* axes labels */}
      {['Day 1','','','','','','','Day 7','','','','','','Day 14'].map((l,i) =>
        l ? <text key={i} x={sx(i)} y={H-2} textAnchor="middle" fill="var(--text-4)" fontSize="9.5" fontFamily="var(--font-mono)">{l}</text> : null
      )}
      <text x={W-14} y={sy(17)+3} textAnchor="end" fill="var(--text-3)" fontSize="9.5" fontFamily="var(--font-mono)">target 17</text>
      <text x={W-14} y={sy(13)-6} textAnchor="end" fill="var(--accent)" fontSize="9.5" fontFamily="var(--font-mono)">completed 13</text>
    </svg>
  );
}

function Sparkline({ tiny }) {
  const pts = [1,3,2,4,3,5,4,6,5,7,6,3,8,5];
  const W = tiny ? 120 : 240, H = tiny ? 22 : 36;
  const max = Math.max(...pts);
  const dx = W / (pts.length - 1);
  const path = pts.map((y,i) => `${i?'L':'M'}${i*dx},${H - (y/max)*(H-3) - 1}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width:'100%', height:H }}>
      <path d={`${path} L${W},${H} L0,${H} Z`} fill="var(--accent-soft)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
    </svg>
  );
}

function AgentRow({ a }) {
  return (
    <div className="agent-row">
      <span className="left" />
      <div className="ttl">
        <div className="t">
          <span className="id">{a.issue}</span>
          <span>{a.title}</span>
        </div>
        <div className="meta">
          <span style={{display:'inline-flex', alignItems:'center', gap:5, color:'var(--accent)'}}>
            <span className="spinner" />{a.step}
          </span>
        </div>
      </div>
      <div className="right">
        <span>{a.duration}</span>
        <span style={{color:'var(--text-4)'}}>·</span>
        <span>{a.tokens}</span>
      </div>
    </div>
  );
}

/* ----- orchestrator chat panel (right side of dashboard) ----- */
function OrchestratorChat() {
  const data = D();
  return (
    <div className="dash__chat">
      <div className="chat__head">
        <div className="av">SY</div>
        <div style={{display:'flex', flexDirection:'column'}}>
          <h3>Symphony orchestrator</h3>
          <span className="sub">codex-1 · WORKFLOW.md@main · context: cycle 14</span>
        </div>
        <div style={{flex:1}} />
        <button className="icon-btn">{Icon.more()}</button>
      </div>
      <div className="chat__body">
        {data.dashChat.map((m,i) => (
          <div className="chat__msg" key={i}>
            <div className={`who ${m.who==='user' ? 'who--user' : ''}`}>
              <span className="av-tiny">{m.who==='user' ? 'You' : 'SY'}</span>
              {m.who==='user' ? 'You' : 'Orchestrator'}
              <span className="dot" style={{ width:3, height:3, borderRadius:999, background:'var(--text-4)', display:'inline-block' }} />
              <span style={{color:'var(--text-4)'}}>just now</span>
            </div>
            <div className="body">
              <p dangerouslySetInnerHTML={{ __html: inlineCode2(m.text) }} />
              {m.suggestions && (
                <div style={{ marginTop:4 }}>
                  {m.suggestions.map((s,j) => (
                    <button className="chat__suggestion" key={j}>
                      {j===0 ? Icon.bolt() : null}{s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="chat__input">
        <div className="box">
          <textarea placeholder="Ask about the project, or issue a command (e.g. 'pause SYM-42', 'show stalled agents')…" defaultValue="" />
          <div className="row">
            <button className="btn btn--ghost" style={{padding:'2px 6px'}}>@ context</button>
            <button className="btn btn--ghost" style={{padding:'2px 6px'}}>/ commands</button>
            <div className="grow" />
            <span style={{color:'var(--text-4)', fontFamily:'var(--font-mono)', fontSize:10.5}}>codex-1</span>
            <button className="btn btn--primary" style={{padding:'3px 9px'}}>{Icon.send()}Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function inlineCode2(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text);font-weight:600">$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

Object.assign(window, {
  ChatHistoryView, IssuesView, DashboardView,
  StatusBadgeDot, SessionStateChip
});
