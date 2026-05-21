/* Narrow sidebar webview variants (at-a-glance) + agent state visual language cards. */

const D2 = () => window.SYM_DATA;

/* ============================================================
   Narrow sidebar — primary "at a glance" panel (380px wide)
   ============================================================ */
function SidebarPrimary() {
  const data = D2();
  return (
    <div style={{ height:'100%', display:'grid', gridTemplateRows:'40px auto 1fr auto', background:'var(--bg)' }}>
      {/* sidebar head */}
      <div style={{
        display:'flex', alignItems:'center', padding:'0 12px', gap:10,
        background:'var(--panel)', borderBottom:'1px solid var(--border)'
      }}>
        <span style={{
          width:8, height:8, borderRadius:999, background:'var(--accent)',
          boxShadow:'0 0 0 3px rgba(240,184,108,0.18)',
        }} />
        <span style={{ fontSize:12, fontWeight:500 }}>Symphony</span>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)' }}>main · poll 22s</span>
        <div style={{ flex:1 }} />
        <button className="icon-btn">{Icon.more()}</button>
      </div>

      {/* compact stats */}
      <div style={{ padding:'12px 12px 4px' }}>
        <div style={{
          display:'grid', gridTemplateColumns:'1fr 1fr', gap:8
        }}>
          <MiniStat label="Completeness" value="48%" bar="48%" accent />
          <MiniStat label="Running" value="4/6" sub="agents" />
          <MiniStat label="Open" value="11" sub="issues" />
          <MiniStat label="Velocity" value="3.2" sub="PR/day" />
        </div>
      </div>

      {/* live agents + reviews */}
      <div style={{ overflow:'auto' }}>
        <SidebarSection title="Running agents" count={data.runningAgents.length}>
          {data.runningAgents.map(a => (
            <div key={a.id} style={{
              display:'grid', gridTemplateColumns:'8px 1fr auto',
              gap:8, padding:'8px 12px',
              borderBottom:'1px solid var(--border-subtle)',
              alignItems:'center'
            }}>
              <span style={{
                width:6, height:6, borderRadius:999, background:'var(--accent)',
                boxShadow:'0 0 0 3px rgba(240,184,108,0.15)',
                animation:'pulse 1.6s ease-in-out infinite'
              }} />
              <div style={{ minWidth:0, display:'flex', flexDirection:'column', gap:2 }}>
                <div style={{ display:'flex', gap:6, alignItems:'center', fontSize:11.5 }}>
                  <span style={{fontFamily:'var(--font-mono)', color:'var(--text-3)', fontSize:10.5}}>{a.issue}</span>
                  <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', color:'var(--text)' }}>{a.title}</span>
                </div>
                <div style={{ fontSize:10.5, color:'var(--accent)', fontFamily:'var(--font-mono)',
                              display:'flex', alignItems:'center', gap:5 }}>
                  <span className="spinner" />
                  <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{a.step}</span>
                </div>
              </div>
              <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)' }}>{a.duration}</span>
            </div>
          ))}
        </SidebarSection>

        <SidebarSection title="Awaiting review" count="3">
          {data.issues.filter(i => i.status === 'review').slice(0,3).map(i => (
            <div key={i.id} style={{
              display:'grid', gridTemplateColumns:'13px 1fr auto',
              gap:8, padding:'8px 12px',
              borderBottom:'1px solid var(--border-subtle)',
              alignItems:'center'
            }}>
              <StatusIcon state="review" />
              <div style={{ minWidth:0, display:'flex', flexDirection:'column', gap:2 }}>
                <div style={{ display:'flex', gap:6, alignItems:'center', fontSize:11.5 }}>
                  <span style={{fontFamily:'var(--font-mono)', color:'var(--text-3)', fontSize:10.5}}>{i.id}</span>
                </div>
                <span style={{ fontSize:11.5, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{i.title}</span>
              </div>
              {i.pr && <span style={{ display:'inline-flex', alignItems:'center', gap:4, color:'var(--link)', fontSize:10.5, fontFamily:'var(--font-mono)' }}>
                <span style={{width:11, height:11}}>{Icon.pr()}</span>{i.pr}
              </span>}
            </div>
          ))}
        </SidebarSection>

        <SidebarSection title="Recent activity" count={null}>
          {data.activity.slice(0, 6).map((a, i) => (
            <div key={i} style={{
              display:'grid', gridTemplateColumns:'8px 1fr',
              gap:8, padding:'7px 12px', alignItems:'flex-start',
              borderBottom:'1px solid var(--border-subtle)',
              fontSize:11.5
            }}>
              <span style={{ width:5, height:5, borderRadius:999, marginTop:7, background: 'var(--text-3)' }} />
              <div style={{ minWidth:0 }}>
                <div style={{ color:'var(--text-2)', lineHeight:1.4 }}>
                  <span style={{ fontFamily:'var(--font-mono)', color:'var(--text)' }}>{a.who}</span>{' '}
                  <span style={{ color:'var(--text-3)' }}>{a.verb}</span>{' '}
                  <span style={{ fontFamily:'var(--font-mono)', color:'var(--text)' }}>{a.id}</span>
                </div>
                <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-4)', marginTop:1 }}>{a.t}</div>
              </div>
            </div>
          ))}
        </SidebarSection>
      </div>

      {/* footer / pulse */}
      <div style={{
        display:'flex', alignItems:'center', gap:10, padding:'8px 12px',
        background:'var(--panel)', borderTop:'1px solid var(--border)',
        fontSize:11, color:'var(--text-3)', fontFamily:'var(--font-mono)'
      }}>
        <span style={{
          width:6, height:6, borderRadius:999, background:'var(--accent)',
          animation:'pulse 1.6s ease-in-out infinite'
        }} />
        <span>poll in 8s</span>
        <div style={{ flex:1 }} />
        <span>0 errors · 24h</span>
      </div>
    </div>
  );
}

function MiniStat({ label, value, sub, bar, accent }) {
  return (
    <div style={{
      border:'1px solid var(--border)', borderRadius:6,
      padding:'9px 11px', background:'var(--panel)',
      display:'flex', flexDirection:'column', gap:3
    }}>
      <div style={{
        fontSize:9.5, textTransform:'uppercase', letterSpacing:'0.08em',
        color:'var(--text-3)'
      }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:500, lineHeight:1, fontFeatureSettings:'"tnum"',
                    color: accent ? 'var(--accent)' : 'var(--text)' }}>{value}</div>
      {bar ? (
        <div style={{ height:3, background:'var(--elevated)', borderRadius:999, marginTop:2 }}>
          <div style={{ width:bar, height:'100%', background:'var(--accent)', borderRadius:999 }} />
        </div>
      ) : (
        <div style={{ fontSize:10.5, color:'var(--text-3)' }}>{sub}</div>
      )}
    </div>
  );
}

function SidebarSection({ title, count, children }) {
  return (
    <div>
      <div style={{
        display:'flex', alignItems:'center', padding:'10px 12px 6px',
        fontSize:10, textTransform:'uppercase', letterSpacing:'0.08em',
        color:'var(--text-3)'
      }}>
        <span>{title}</span>
        {count !== null && (
          <span style={{ marginLeft:6, fontFamily:'var(--font-mono)', color:'var(--text-4)' }}>
            {count}
          </span>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ============================================================
   Narrow sidebar — orchestrator chat-focused
   ============================================================ */
function SidebarChat() {
  const data = D2();
  // truncated chat for the narrow view
  const recent = data.dashChat.slice(-3);
  return (
    <div style={{ height:'100%', display:'grid', gridTemplateRows:'40px 1fr auto', background:'var(--panel)' }}>
      <div style={{
        display:'flex', alignItems:'center', padding:'0 12px', gap:10,
        background:'var(--panel)', borderBottom:'1px solid var(--border)'
      }}>
        <div className="av" style={{
          width:22, height:22, borderRadius:5,
          background:'linear-gradient(135deg, var(--accent), #a85f2e)', color:'#1a1208',
          fontFamily:'var(--font-mono)', fontWeight:600, fontSize:10.5,
          display:'inline-flex', alignItems:'center', justifyContent:'center'
        }}>SY</div>
        <div style={{ display:'flex', flexDirection:'column', minWidth:0 }}>
          <span style={{ fontSize:12, fontWeight:500 }}>Orchestrator</span>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-3)',
                         overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>codex-1 · cycle 14</span>
        </div>
        <div style={{ flex:1 }} />
        <button className="icon-btn">{Icon.history()}</button>
      </div>

      <div style={{ overflow:'auto', padding:'14px 14px 6px',
                    display:'flex', flexDirection:'column', gap:14 }}>
        {recent.map((m, i) => (
          <div key={i} className="chat__msg">
            <div className={`who ${m.who==='user' ? 'who--user' : ''}`}>
              <span className="av-tiny">{m.who==='user' ? 'You' : 'SY'}</span>
              {m.who==='user' ? 'You' : 'Orchestrator'}
            </div>
            <div className="body">
              <p dangerouslySetInnerHTML={{ __html: m.text
                .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text);font-weight:600">$1</strong>')
                .replace(/`([^`]+)`/g, '<code>$1</code>') }} />
              {m.suggestions && (
                <div style={{ marginTop:4 }}>
                  {m.suggestions.map((s,j) => (
                    <button className="chat__suggestion" key={j} style={{ marginBottom:4 }}>
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
          <textarea placeholder="Ask or command…" defaultValue="" style={{ minHeight:34 }} />
          <div className="row">
            <button className="btn btn--ghost" style={{padding:'1px 6px', fontSize:10.5}}>@ context</button>
            <button className="btn btn--ghost" style={{padding:'1px 6px', fontSize:10.5}}>/</button>
            <div className="grow" />
            <button className="btn btn--primary" style={{padding:'2px 8px'}}>{Icon.send()}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Narrow sidebar — chat history list
   ============================================================ */
function SidebarHistory() {
  const data = D2();
  return (
    <div style={{ height:'100%', display:'grid', gridTemplateRows:'40px auto 1fr', background:'var(--bg)' }}>
      <div style={{
        display:'flex', alignItems:'center', padding:'0 12px', gap:10,
        background:'var(--panel)', borderBottom:'1px solid var(--border)'
      }}>
        <span style={{ fontSize:12, fontWeight:500 }}>Chat history</span>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)' }}>{data.sessions.length}</span>
        <div style={{ flex:1 }} />
        <button className="icon-btn">{Icon.search()}</button>
        <button className="icon-btn">{Icon.filter()}</button>
      </div>
      <div style={{ padding:'8px 10px 4px', display:'flex', gap:5, borderBottom:'1px solid var(--border-subtle)' }}>
        <button className="pill" data-active="true" style={{ fontSize:10.5, padding:'2px 8px', borderRadius:999, border:'1px solid var(--border-strong)', background:'var(--elevated)' }}>All</button>
        <button className="pill" style={{ fontSize:10.5, padding:'2px 8px', borderRadius:999, border:'1px solid var(--border)', background:'var(--panel)', color:'var(--text-3)' }}>Running</button>
        <button className="pill" style={{ fontSize:10.5, padding:'2px 8px', borderRadius:999, border:'1px solid var(--border)', background:'var(--panel)', color:'var(--text-3)' }}>Errors</button>
      </div>
      <div style={{ overflow:'auto' }}>
        {data.sessions.map(s => (
          <div className="session-row" key={s.id} style={{ gridTemplateColumns:'14px 1fr', padding:'9px 12px' }}>
            <span className="ico"><StatusBadgeDot state={s.state} /></span>
            <div className="info">
              <div className="top">
                <span className="id">{s.issue}</span>
                <SessionStateChip state={s.state} />
                <div style={{ flex:1 }} />
                <span style={{ fontSize:10, color:'var(--text-4)', fontFamily:'var(--font-mono)' }}>{s.updatedAt}</span>
              </div>
              <div className="t" style={{ fontSize:11.5 }}>{s.title}</div>
              <div className="meta" style={{ fontSize:10 }}>
                <span>{s.msgCount} msgs · {s.toolCount} tools</span>
              </div>
              <div style={{ fontFamily:'var(--font-mono)', fontSize:10, color:'var(--text-4)',
                            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginTop:2 }}>
                {s.lastEvent}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   Agent run-status — visual language cards
   Each shows the same "issue badge" in a different lifecycle state.
   ============================================================ */
function AgentStateCard({ state, title, sub, issue, agent, step, duration }) {
  const cfg = {
    running:   { dot:'var(--run-active)',  pulseShadow:'0 0 0 3px rgba(240,184,108,0.18)', label:'RUNNING',   labelBg:'var(--accent-soft)',                labelFg:'var(--accent)' },
    queued:    { dot:'var(--run-queued)',  pulseShadow:'none',                              label:'QUEUED',    labelBg:'var(--link-soft)',                  labelFg:'var(--link)' },
    creating:  { dot:'var(--run-queued)',  pulseShadow:'0 0 0 3px rgba(122,167,255,0.16)',  label:'CREATING',  labelBg:'var(--link-soft)',                  labelFg:'var(--link)' },
    review:    { dot:'var(--st-review)',   pulseShadow:'none',                              label:'HUMAN REVIEW', labelBg:'var(--link-soft)',               labelFg:'var(--link)' },
    finished:  { dot:'var(--run-done)',    pulseShadow:'none',                              label:'FINISHED',  labelBg:'rgba(127,194,139,0.10)',            labelFg:'var(--st-done)' },
    error:     { dot:'var(--run-error)',   pulseShadow:'0 0 0 3px rgba(226,106,106,0.16)',  label:'ERROR',     labelBg:'rgba(226,106,106,0.10)',            labelFg:'var(--pri-urgent)' },
    cancelled: { dot:'var(--text-3)',      pulseShadow:'none',                              label:'CANCELLED', labelBg:'var(--elevated)',                   labelFg:'var(--text-3)' },
    expired:   { dot:'var(--text-3)',      pulseShadow:'none',                              label:'EXPIRED',   labelBg:'var(--elevated)',                   labelFg:'var(--text-3)' },
  }[state];

  const isAnimated = state === 'running' || state === 'creating';

  return (
    <div style={{
      width:'100%', height:'100%',
      background:'var(--panel)',
      border:'1px solid var(--border)',
      borderRadius: 8,
      padding:'14px 16px 14px',
      display:'flex', flexDirection:'column', gap:10,
      fontFamily:'var(--font-sans)',
      position:'relative', overflow:'hidden'
    }}>
      {/* state stripe */}
      <div style={{
        position:'absolute', left:0, top:0, bottom:0, width:2,
        background: cfg.dot, opacity: state==='cancelled' || state==='expired' ? 0.4 : 1
      }} />

      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <span style={{
          width:8, height:8, borderRadius:999, background: cfg.dot,
          boxShadow: cfg.pulseShadow,
          animation: isAnimated ? 'pulse 1.6s ease-in-out infinite' : 'none'
        }} />
        <span className={`statbadge statbadge--${state==='review' ? 'creating' : (state==='creating' ? 'creating' : state)}`}
              style={{ background: cfg.labelBg, color: cfg.labelFg }}>
          {cfg.label}
        </span>
        <div style={{ flex:1 }} />
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, color:'var(--text-3)' }}>{duration}</span>
      </div>

      <div>
        <div style={{ display:'flex', gap:6, alignItems:'center', marginBottom:3 }}>
          <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-3)' }}>{issue}</span>
        </div>
        <div style={{ fontSize:13, color:'var(--text)', lineHeight:1.35,
                      display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden' }}>
          {title}
        </div>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:7, marginTop:'auto' }}>
        <span style={{
          fontFamily:'var(--font-mono)', fontSize:10.5,
          color: isAnimated ? cfg.labelFg : 'var(--text-3)',
          display:'inline-flex', alignItems:'center', gap:5,
          minWidth:0, overflow:'hidden'
        }}>
          {state==='running' && <span className="spinner" />}
          {state==='creating' && <span className="spinner" style={{ borderTopColor:'var(--link)' }} />}
          {state==='finished' && <span style={{
            width:11, height:11, display:'inline-flex', alignItems:'center', justifyContent:'center',
            background:'var(--st-done)', borderRadius:999, color:'#0c0c0e'
          }}>
            <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="#0c0c0e" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6.2 L5 8 L9 4" />
            </svg>
          </span>}
          {state==='error' && <span style={{ color:'var(--pri-urgent)' }}>⚠</span>}
          {state==='cancelled' && <span style={{ color:'var(--text-3)' }}>○</span>}
          {state==='expired' && <span style={{ color:'var(--text-3)' }}>◌</span>}
          {state==='queued' && <span style={{ color:'var(--link)' }}>⏳</span>}
          {state==='review' && <span style={{ color:'var(--link)' }}>👤</span>}
          <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{step}</span>
        </span>
        <div style={{ flex:1 }} />
        <span className="avatar" style={{ background: state==='running'||state==='creating' ? 'var(--accent)' : 'var(--elevated)',
                                          color: state==='running'||state==='creating' ? '#0c0c0e' : 'var(--text-3)',
                                          border: state==='running'||state==='creating' ? 'none' : '1px solid var(--border)' }}>
          {agent ? agent.slice(-2) : '—'}
        </span>
      </div>
    </div>
  );
}

Object.assign(window, { SidebarPrimary, SidebarChat, SidebarHistory, AgentStateCard });
