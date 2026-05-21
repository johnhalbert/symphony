/* Shared icons + small primitives.
   All icons sized via parent (currentColor / em units). */

const Icon = {
  // Linear-style status icons (filled circle progress)
  status(state) {
    switch (state) {
      case 'backlog':
        return (
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.6">
            <circle cx="7" cy="7" r="5.5" />
          </svg>
        );
      case 'todo':
        return (
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <circle cx="7" cy="7" r="5.5" />
          </svg>
        );
      case 'progress':
        return (
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 7 L7 2 A5 5 0 0 1 12 7 Z" fill="currentColor" stroke="none" />
          </svg>
        );
      case 'review':
        return (
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 7 L7 2 A5 5 0 0 1 11.33 9.5 Z" fill="currentColor" stroke="none" />
          </svg>
        );
      case 'done':
        return (
          <svg viewBox="0 0 14 14" fill="currentColor">
            <circle cx="7" cy="7" r="6" />
            <path d="M4.4 7.2 L6.2 9 L9.6 5.6" stroke="#0c0c0e" strokeWidth="1.3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case 'cancelled':
        return (
          <svg viewBox="0 0 14 14" fill="currentColor">
            <circle cx="7" cy="7" r="6" />
            <path d="M5 5 L9 9 M9 5 L5 9" stroke="#0c0c0e" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          </svg>
        );
      default:
        return null;
    }
  },

  chevronRight: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4 L10 8 L6 12" />
    </svg>
  ),
  chevronDown: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6 L8 10 L12 6" />
    </svg>
  ),
  close: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M4 4 L12 12 M12 4 L4 12" />
    </svg>
  ),
  search: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 L13.5 13.5" />
    </svg>
  ),
  plus: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M8 3 V13 M3 8 H13" />
    </svg>
  ),
  filter: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M2.5 4 H13.5 M4.5 8 H11.5 M6.5 12 H9.5" />
    </svg>
  ),
  sort: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M4 4 V12 M4 12 L2 10 M4 12 L6 10 M11 12 V4 M11 4 L9 6 M11 4 L13 6" />
    </svg>
  ),
  more: () => (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  ),
  message: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4 a1.5 1.5 0 0 1 1.5 -1.5 h8 a1.5 1.5 0 0 1 1.5 1.5 v6 a1.5 1.5 0 0 1 -1.5 1.5 h-5 l-3 2.5 v-2.5 h-0 a1.5 1.5 0 0 1 -1.5 -1.5 z" />
    </svg>
  ),
  layout: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6 H14 M6 6 V13.5" />
    </svg>
  ),
  dashboard: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="2.5" width="5" height="5" rx="1" />
      <rect x="9" y="2.5" width="5" height="3" rx="1" />
      <rect x="9" y="7" width="5" height="6.5" rx="1" />
      <rect x="2" y="9" width="5" height="4.5" rx="1" />
    </svg>
  ),
  history: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M2.5 8 A5.5 5.5 0 1 0 4.5 4" />
      <path d="M2.2 2.5 V4.8 H4.5" />
      <path d="M8 5 V8 L10.2 9.5" />
    </svg>
  ),
  arrowUp: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 12 V4 M5 7 L8 4 L11 7" />
    </svg>
  ),
  branch: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="4" cy="3.5" r="1.4" />
      <circle cx="4" cy="12.5" r="1.4" />
      <circle cx="12" cy="6" r="1.4" />
      <path d="M4 4.9 V11.1" />
      <path d="M4 6.5 A4 4 0 0 0 8 10.5 H10.5" />
    </svg>
  ),
  pr: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="4" cy="3.5" r="1.4" />
      <circle cx="4" cy="12.5" r="1.4" />
      <circle cx="12" cy="12.5" r="1.4" />
      <path d="M4 4.9 V11.1" />
      <path d="M12 4 V11.1 M10 6 L12 4 L14 6" />
    </svg>
  ),
  link: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M6.5 9.5 L9.5 6.5" />
      <path d="M7 4 L8.5 2.5 A2.1 2.1 0 0 1 13.5 7.5 L12 9" />
      <path d="M9 12 L7.5 13.5 A2.1 2.1 0 0 1 2.5 8.5 L4 7" />
    </svg>
  ),
  send: () => (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M2.5 7.5 L13.5 3 L9.8 14 L8 9 L2.5 7.5 Z" />
    </svg>
  ),
  bolt: () => (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M9 1 L3 9 L7 9 L6 15 L13 6 L9 6 L10 1 Z" />
    </svg>
  ),
  agent: () => (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="3" y="5" width="10" height="7" rx="2" />
      <path d="M8 2 V5" strokeLinecap="round" />
      <circle cx="8" cy="2" r="0.9" fill="currentColor" />
      <circle cx="6.4" cy="8.5" r="0.8" fill="currentColor" />
      <circle cx="9.6" cy="8.5" r="0.8" fill="currentColor" />
    </svg>
  ),
};

function StatusIcon({ state }) {
  const color = {
    backlog:'var(--st-backlog)', todo:'var(--st-todo)',
    progress:'var(--st-progress)', review:'var(--st-review)',
    done:'var(--st-done)', cancelled:'var(--st-cancelled)'
  }[state] || 'var(--text-3)';
  return <span className="status-icon" style={{ color }}>{Icon.status(state)}</span>;
}

const STATUS_LABEL = {
  backlog:'Backlog', todo:'Todo', progress:'In Progress',
  review:'In Review', done:'Done', cancelled:'Cancelled'
};

function Priority({ level }) {
  return <span className="pri-bars" data-level={level}><span /><span /><span /></span>;
}

function Avatar({ user, size }) {
  const u = window.SYM_DATA.users[user] || { name:user, color:'#5a5a62' };
  const initials = u.name.split(/\s+/).map(s=>s[0]).slice(0,2).join('').toUpperCase();
  const cls = size === 'md' ? 'avatar avatar--md' : size === 'lg' ? 'avatar avatar--lg' : 'avatar';
  return <span className={cls} style={{ background:u.color, color:'#0c0c0e' }}>{initials}</span>;
}

function Label({ name }) {
  const l = window.SYM_DATA.labels[name] || { name, color:'#5a5a62' };
  return (
    <span className="label">
      <span className="swatch" style={{ background:l.color }} />
      {l.name}
    </span>
  );
}

function StatusBadge({ state }) {
  const k = state.toLowerCase();
  return (
    <span className={`statbadge statbadge--${k}`}>
      <span className="d" />{state}
    </span>
  );
}

Object.assign(window, { Icon, StatusIcon, STATUS_LABEL, Priority, Avatar, Label, StatusBadge });
