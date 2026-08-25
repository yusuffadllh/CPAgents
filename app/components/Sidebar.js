'use client';

import Link from 'next/link';

export default function Sidebar({ setShowSettings, currentMode, sessions = [], onSelectSession, onDeleteSession, currentSessionId }) {
  return (
    <div className="sidebar glass" style={{ display: 'flex', flexDirection: 'column', maxHeight: '100vh' }}>
      <h2 style={{ marginBottom: '2rem', fontSize: '1.25rem', fontWeight: 'bold' }}>AI Agent</h2>
      
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <Link href="/" style={{
          padding: '0.75rem',
          borderRadius: '8px',
          background: currentMode === 'agent' ? 'var(--surface)' : 'transparent',
          border: currentMode === 'agent' ? '1px solid var(--surface-border)' : '1px solid transparent',
          textDecoration: 'none',
          color: 'inherit'
        }}>
          🤖 Agent Mode
        </Link>
        <Link href="/chat" style={{
          padding: '0.75rem',
          borderRadius: '8px',
          background: currentMode === 'chat' ? 'var(--surface)' : 'transparent',
          border: currentMode === 'chat' ? '1px solid var(--surface-border)' : '1px solid transparent',
          textDecoration: 'none',
          color: 'inherit'
        }}>
          💬 Chat Mode
        </Link>
      </div>

      {currentMode === 'agent' && sessions.length > 0 && (
        <div style={{ marginTop: '2rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ fontSize: '0.9rem', marginBottom: '1rem', opacity: 0.7 }}>📂 Projek</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {sessions.map(session => {
              const tasks = session.tasks || [];
              const total = tasks.length;
              const done = tasks.filter(t => t.status === 'COMPLETED').length;
              const running = tasks.some(t => t.status === 'RUNNING');
              const pending = tasks.some(t => t.status === 'PENDING');
              const failed = tasks.some(t => t.status === 'FAILED');
              const allDone = total > 0 && done === total;
              const pct = total ? Math.round((done / total) * 100) : 0;

              const badge = running
                ? { text: 'Berjalan', color: '#90caf9', bg: 'rgba(144,202,249,0.15)' }
                : allDone
                ? { text: 'Selesai', color: '#81c784', bg: 'rgba(129,199,132,0.15)' }
                : pending
                ? { text: 'Belum kelar', color: '#ffb74d', bg: 'rgba(255,183,77,0.15)' }
                : failed
                ? { text: 'Ada yang gagal', color: '#ef5350', bg: 'rgba(239,83,80,0.15)' }
                : { text: 'Baru', color: '#bb86fc', bg: 'rgba(187,134,252,0.15)' };

              const isActive = session.id === currentSessionId;

              return (
                <div
                  key={session.id}
                  onClick={() => onSelectSession && onSelectSession(session.id)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.4rem',
                    padding: '0.6rem 0.65rem',
                    borderRadius: '10px',
                    background: isActive ? 'var(--surface)' : 'rgba(255,255,255,0.02)',
                    border: isActive ? '1px solid var(--surface-border)' : '1px solid transparent',
                    cursor: 'pointer',
                    fontSize: '0.85rem'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <div style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: isActive ? 600 : 400 }}>
                      🤖 {session.goal || session.messages?.[0]?.content || 'Sesi Agent'}
                    </div>
                    {onDeleteSession && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(session.id);
                        }}
                        style={{ background: 'transparent', border: 'none', color: '#ff4444', cursor: 'pointer', padding: '0 0.25rem', fontSize: '1rem', lineHeight: 1 }}
                        title="Hapus Projek"
                      >
                        ×
                      </button>
                    )}
                  </div>

                  {session.slug && (
                    <div style={{ fontSize: '0.7rem', opacity: 0.5, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={`workspaces/${session.slug}`}>
                      📁 {session.slug}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.65rem', padding: '0.1rem 0.45rem', borderRadius: '999px', background: badge.bg, color: badge.color, whiteSpace: 'nowrap' }}>
                      {badge.text}
                    </span>
                    {total > 0 && (
                      <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>{done}/{total} task</span>
                    )}
                  </div>

                  {total > 0 && (
                    <div style={{ height: '4px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: allDone ? '#81c784' : running ? '#90caf9' : '#bb86fc', transition: 'width 0.3s' }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {currentMode === 'chat' && sessions.length > 0 && (
        <div style={{ marginTop: '2rem', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          <h3 style={{ fontSize: '0.9rem', marginBottom: '1rem', opacity: 0.7 }}>Riwayat Obrolan</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {sessions.map(session => (
              <div 
                key={session.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0.5rem',
                  borderRadius: '8px',
                  background: session.id === currentSessionId ? 'var(--surface)' : 'transparent',
                  border: session.id === currentSessionId ? '1px solid var(--surface-border)' : '1px solid transparent',
                  cursor: 'pointer',
                  fontSize: '0.85rem'
                }}
              >
                <div onClick={() => onSelectSession && onSelectSession(session.id)} style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {session.messages?.[0]?.content || "Sesi Obrolan"}
                </div>
                {onDeleteSession && (
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(session.id);
                    }}
                    style={{ background: 'transparent', border: 'none', color: '#ff4444', cursor: 'pointer', padding: '0 0.5rem' }}
                    title="Hapus Sesi"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button className="btn-primary" onClick={() => setShowSettings(true)} style={{ marginTop: currentMode === 'chat' && sessions.length > 0 ? '1rem' : 'auto' }}>
        ⚙️ Konfigurasi API
      </button>
      
      <div style={{ marginTop: 'auto', fontSize: '0.8rem', opacity: 0.6 }}>
        Antigravity UI Clone
      </div>
    </div>
  );
}
