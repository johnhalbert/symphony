/* The 8 chat message types — read-only renderers.
   types: system, user, assistant, thinking, tool_call, status, task, request */

function MsgGutter({ kind }) {
  const av = {
    system:   { cls:'av--system',  label:'S' },
    user:     { cls:'av--user',    label:'U' },
    assistant:{ cls:'av--assist',  label:'A' },
    thinking: { cls:'av--thinking',label:'…' },
    tool_call:{ cls:'av--tool',    label:'⚙' },
    status:   { cls:'av--status',  label:'•' },
    task:     { cls:'av--task',    label:'✓' },
    request:  { cls:'av--request', label:'?' },
  }[kind] || { cls:'av--status', label:'·' };
  return (
    <div className="msg__gutter">
      <span className={`av ${av.cls}`}>{av.label}</span>
      <span className="line" />
    </div>
  );
}

function MsgHead({ kind, ts, extra }) {
  const name = {
    system:'System', user:'User prompt', assistant:'Assistant',
    thinking:'Thinking', tool_call:'Tool call',
    status:'Status', task:'Task', request:'Request'
  }[kind];
  return (
    <div className="msg__head">
      <span className="name">{name}</span>
      {extra ? <><span className="dot" />{extra}</> : null}
      <span className="dot" />
      <span className="ts">{ts}</span>
    </div>
  );
}

/* ---------- individual renderers ---------- */

function SystemMsg({ m }) {
  return (
    <div className="msg">
      <MsgGutter kind="system" />
      <div>
        <MsgHead kind="system" ts={m.ts} extra="init" />
        <div className="sysblock">
          <h5>Session initialized</h5>
          <div className="grid">
            <span className="k">session_id</span><span className="v">{m.session}</span>
            <span className="k">workspace</span><span className="v">{m.workspace}</span>
            <span className="k">cwd</span><span className="v">{m.cwd}</span>
            <span className="k">model</span><span className="v">{m.model}</span>
            <span className="k">tools</span>
            <span className="v">
              <span className="tools">
                {m.tools.map(t => <span className="tool" key={t}>{t}</span>)}
              </span>
            </span>
          </div>
          <div style={{ marginTop:10, fontSize:11, color:'var(--text-3)', fontStyle:'italic' }}>
            {m.note}
          </div>
        </div>
      </div>
    </div>
  );
}

function UserMsg({ m }) {
  return (
    <div className="msg">
      <MsgGutter kind="user" />
      <div>
        <MsgHead kind="user" ts={m.ts} extra={`from ${m.from} · ${m.issue}`} />
        <div className="userblock">
          {m.text.split('\n\n').map((p, i) => <p key={i} style={{ margin:i? '8px 0 0':0, whiteSpace:'pre-wrap' }}>{p}</p>)}
        </div>
      </div>
    </div>
  );
}

function AssistantMsg({ m }) {
  return (
    <div className="msg">
      <MsgGutter kind="assistant" />
      <div>
        <MsgHead kind="assistant" ts={m.ts} />
        <div className="msg__body">
          {m.text.split('\n\n').map((p, i) =>
            <p key={i} dangerouslySetInnerHTML={{ __html: inlineCode(p) }} />
          )}
        </div>
      </div>
    </div>
  );
}

function ThinkingMsg({ m }) {
  return (
    <div className="msg">
      <MsgGutter kind="thinking" />
      <div>
        <MsgHead kind="thinking" ts={m.ts} extra="chain-of-thought" />
        <div className="thinkbox">{m.text}</div>
      </div>
    </div>
  );
}

function ToolCallMsg({ m, open }) {
  const argsPreview = JSON.stringify(m.args).replace(/[{}"]/g,'').replace(/,/g,', ');
  return (
    <div className="msg">
      <MsgGutter kind="tool_call" />
      <div>
        <MsgHead kind="tool_call" ts={m.ts} extra={
          <span style={{display:'inline-flex',gap:8,alignItems:'center'}}>
            <code style={{fontFamily:'var(--font-mono)',color:'var(--text-2)'}}>{m.name}</code>
            <StatusBadge state={m.status} />
          </span>
        } />
        <div className="toolcall" data-open={open}>
          <div className="toolcall__head">
            <span className="chev">{Icon.chevronRight()}</span>
            <span className="name">{m.name}</span>
            <span className="args-preview">({argsPreview})</span>
            <StatusBadge state={m.status} />
            <span className="cid">{m.call_id}</span>
          </div>
          {open && (
            <div className="toolcall__body">
              <div className="toolcall__sec">
                <div className="lbl">Arguments</div>
                <div>{JSON.stringify(m.args, null, 2)}</div>
              </div>
              {m.result !== null ? (
                <div className="toolcall__sec">
                  <div className="lbl">
                    Result
                    {m.truncated ? <span className="trunc">truncated</span> : null}
                  </div>
                  <div>{m.result}</div>
                </div>
              ) : (
                <div className="toolcall__sec">
                  <div className="lbl">Result</div>
                  <div style={{color:'var(--text-3)', fontStyle:'italic'}}>
                    <span className="spinner" style={{display:'inline-block', verticalAlign:'-1px', marginRight:6}} />
                    awaiting tool response…
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusMsg({ m }) {
  return (
    <div className="lifecycle">
      <StatusBadge state={m.state} />
      <span>{m.text}</span>
      <span style={{color:'var(--text-4)'}}>{m.ts}</span>
    </div>
  );
}

function TaskMsg({ m }) {
  return (
    <div className="msg">
      <MsgGutter kind="task" />
      <div>
        <MsgHead kind="task" ts={m.ts} extra="milestone" />
        <div className="task">
          <div className="head">
            <span className="lbl">Task complete</span>
          </div>
          <div className="title">{m.title}</div>
          <div className="desc">{m.desc}</div>
        </div>
      </div>
    </div>
  );
}

function RequestMsg({ m }) {
  return (
    <div className="msg">
      <MsgGutter kind="request" />
      <div>
        <MsgHead kind="request" ts={m.ts} extra={`reason: ${m.reason}`} />
        <div className="request">
          <div className="head">
            <span className="lbl">Awaiting input</span>
          </div>
          <div className="q">{m.q}</div>
          <div className="actions">
            {m.actions.map((a,i) =>
              <button key={i} className={`btn ${i===0?'btn--primary':''}`}>{a}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function inlineCode(s) {
  // very small markdown-ish: **bold** and `code`
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/* ---------- dispatcher ---------- */
function Message({ m, open }) {
  switch (m.kind) {
    case 'system':    return <SystemMsg m={m} />;
    case 'user':      return <UserMsg m={m} />;
    case 'assistant': return <AssistantMsg m={m} />;
    case 'thinking':  return <ThinkingMsg m={m} />;
    case 'tool_call': return <ToolCallMsg m={m} open={open} />;
    case 'status':    return <StatusMsg m={m} />;
    case 'task':      return <TaskMsg m={m} />;
    case 'request':   return <RequestMsg m={m} />;
    default:          return null;
  }
}

Object.assign(window, { Message });
