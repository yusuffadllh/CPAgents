'use client';

import { useState } from 'react';

export default function SettingsModal({ settings, setSettings, onSave, onCancel }) {
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState(null); // { ok, msg }

  const handlePing = async () => {
    setPinging(true);
    setPingResult(null);
    try {
      const res = await fetch('/api/settings/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          modelName: settings.modelName,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setPingResult({ ok: true, msg: `✅ Terhubung! Model: ${data.model} · ${data.latencyMs}ms` });
      } else {
        setPingResult({ ok: false, msg: `❌ ${data.error || 'Gagal terhubung'}` });
      }
    } catch (e) {
      setPingResult({ ok: false, msg: `❌ ${e.message}` });
    } finally {
      setPinging(false);
    }
  };

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div className="glass" style={{ padding: '2rem', borderRadius: '16px', width: '400px', background: 'rgba(20, 22, 32, 0.95)' }}>
        <h2 style={{ marginBottom: '1.5rem' }}>Konfigurasi Gateway</h2>
        
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Base URL</label>
          <input 
            type="text" 
            style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
            value={settings.baseUrl || ''}
            onChange={e => setSettings({...settings, baseUrl: e.target.value})}
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>API Key</label>
          <input 
            type="password" 
            style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
            value={settings.apiKey || ''}
            onChange={e => setSettings({...settings, apiKey: e.target.value})}
          />
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Model AI</label>
          <input 
            type="text" 
            placeholder="e.g. google/gemini-2.5-pro"
            style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
            value={settings.modelName || ''}
            onChange={e => setSettings({...settings, modelName: e.target.value})}
          />
          <small style={{ display: 'block', marginTop: '0.5rem', opacity: 0.6 }}>Masukkan nama model dari OpenRouter</small>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <button
            onClick={handlePing}
            disabled={pinging}
            style={{
              width: '100%', padding: '0.6rem', borderRadius: '8px', cursor: pinging ? 'wait' : 'pointer',
              background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white',
            }}
          >
            {pinging ? '📡 Menguji koneksi...' : '📡 Ping AI (tes Base URL + Model + API Key)'}
          </button>
          {pingResult && (
            <div style={{
              marginTop: '0.6rem', fontSize: '0.82rem', lineHeight: 1.4, wordBreak: 'break-word',
              color: pingResult.ok ? '#66bb6a' : '#ef5350',
            }}>
              {pingResult.msg}
            </div>
          )}
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Model Gambar (Generate)</label>
          <input
            type="text"
            placeholder="e.g. gpt-image-1"
            style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
            value={settings.imageModelName || ''}
            onChange={e => setSettings({ ...settings, imageModelName: e.target.value })}
          />
          <small style={{ display: 'block', marginTop: '0.5rem', opacity: 0.6 }}>Model untuk fitur "Generate Gambar" di mode chat</small>
        </div>

        <div style={{ borderTop: '1px solid var(--surface-border)', margin: '0.5rem 0 1rem', paddingTop: '1rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem', opacity: 0.85 }}>🚀 Kredensial Deploy (opsional)</div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Vercel Token</label>
            <input
              type="password"
              placeholder="vercel token (untuk deploy Next.js/frontend)"
              style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
              value={settings.vercelToken || ''}
              onChange={e => setSettings({ ...settings, vercelToken: e.target.value })}
            />
          </div>

          <div style={{ marginBottom: '0.25rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Netlify Token</label>
            <input
              type="password"
              placeholder="netlify auth token"
              style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
              value={settings.netlifyToken || ''}
              onChange={e => setSettings({ ...settings, netlifyToken: e.target.value })}
            />
          </div>
          <small style={{ display: 'block', marginTop: '0.5rem', opacity: 0.6 }}>Diisi agar agent bisa deploy sendiri. Kosongkan bila tidak dipakai.</small>
        </div>

        <div style={{ borderTop: '1px solid var(--surface-border)', margin: '0.5rem 0 1rem', paddingTop: '1rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.75rem', opacity: 0.85 }}>🐙 GitHub (opsional)</div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Personal Access Token</label>
            <input
              type="password"
              placeholder="ghp_... (scope: repo)"
              style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
              value={settings.githubToken || ''}
              onChange={e => setSettings({ ...settings, githubToken: e.target.value })}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Username</label>
              <input
                type="text"
                placeholder="yusuffadllh"
                style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
                value={settings.githubUsername || ''}
                onChange={e => setSettings({ ...settings, githubUsername: e.target.value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Email commit</label>
              <input
                type="text"
                placeholder="kamu@email.com"
                style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
                value={settings.githubEmail || ''}
                onChange={e => setSettings({ ...settings, githubEmail: e.target.value })}
              />
            </div>
          </div>

          <div style={{ marginBottom: '0.25rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem' }}>Cara deploy</label>
            <select
              style={{ width: '100%', padding: '0.75rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white' }}
              value={settings.deployMode || 'cli'}
              onChange={e => setSettings({ ...settings, deployMode: e.target.value })}
            >
              <option value="cli">CLI langsung — upload dari server ini</option>
              <option value="git">Lewat GitHub — push, biar Vercel yang build</option>
            </select>
          </div>
          <small style={{ display: 'block', marginTop: '0.5rem', opacity: 0.6 }}>
            Token dipakai agar agent bisa <code>git push</code> tanpa error login. Pilih <b>Lewat GitHub</b> kalau repo-nya sudah tersambung ke Vercel — mencegah deployment dobel.
          </small>
        </div>

        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="btn-primary" style={{ flex: 1, margin: 0 }} onClick={onSave}>Simpan</button>
          <button className="btn-primary" style={{ flex: 1, margin: 0, background: 'transparent', border: '1px solid var(--surface-border)' }} onClick={onCancel}>Batal</button>
        </div>
      </div>
    </div>
  );
}
