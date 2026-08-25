'use client';

import { useState, useEffect, useRef } from 'react';
import Sidebar from '../components/Sidebar';
import SettingsModal from '../components/SettingsModal';
import FileBrowser from '../components/FileBrowser';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const ATT_ICONS = {
  pdf: '📕', xlsx: '📊', xls: '📊', csv: '📊', docx: '📘', doc: '📘',
  pptx: '📙', ppt: '📙', zip: '🗜️', png: '🖼️', jpg: '🖼️', jpeg: '🖼️',
};

function attIcon(att) {
  const ext = (att.name || '').split('.').pop().toLowerCase();
  return ATT_ICONS[ext] || (att.created ? '📄' : '📎');
}

export default function ChatPage() {
  const [settings, setSettings] = useState({ baseUrl: '', apiKey: '', modelName: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Halo! Ada yang bisa saya bantu hari ini?' }
  ]);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // Chat-mode extras: attachments queued for the next message, upload state,
  // image-generation mode, and the file browser for chat-workspaces.
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isUploading, setIsUploading] = useState(false);
  const [imageMode, setImageMode] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);

  const toolbarBtn = {
    background: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--surface-border)',
    padding: '0.35rem 0.7rem',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.8rem',
  };

  const fetchSessions = (autoLoadFirst = false) => {
    fetch(`/api/chat?type=chat&t=${Date.now()}`)
      .then(res => res.json())
      .then(data => {
        if (data.sessions) {
          setSessions(data.sessions);
          if (autoLoadFirst && data.sessions.length > 0) {
            handleSelectSession(data.sessions[0].id);
          }
        }
      })
      .catch(err => console.error("Failed to load sessions", err));
  };

  const handleSelectSession = (id) => {
    localStorage.setItem('chatSessionId', id);
    setSessionId(id);
    setIsLoading(true);
    fetch(`/api/chat?sessionId=${id}`)
      .then(res => res.json())
      .then(data => {
        if (data.messages && data.messages.length > 0) {
          const loaded = data.messages.map(m => ({
            role: m.role,
            content: m.content,
            attachments: parseAttachments(m.attachments),
          }));
          setMessages([{ role: 'assistant', content: 'Sesi sebelumnya berhasil dimuat!' }, ...loaded]);
        }
      })
      .catch(err => console.error("Failed to load history", err))
      .finally(() => setIsLoading(false));
  };

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => setSettings(data));

    fetchSessions();

    const savedSessionId = localStorage.getItem('chatSessionId');
    if (savedSessionId) {
      handleSelectSession(savedSessionId);
    }
  }, []);



  // Attachments come back from the DB as JSON (string) or already-parsed array.
  const parseAttachments = (att) => {
    if (!att) return [];
    if (Array.isArray(att)) return att;
    try { return JSON.parse(att); } catch { return []; }
  };

  const handleNewChat = () => {
    localStorage.removeItem('chatSessionId');
    setSessionId(null);
    setPendingAttachments([]);
    setMessages([{ role: 'assistant', content: 'Sesi obrolan baru dimulai. Ada yang bisa saya bantu?' }]);
  };

  // Upload selected files/images to the chat workspace, then queue them as
  // pending attachments for the next message.
  const handleUpload = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setIsUploading(true);
    try {
      const form = new FormData();
      if (sessionId) form.append('sessionId', sessionId);
      files.forEach(f => form.append('files', f));

      const res = await fetch('/api/chat/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload gagal');

      if (data.sessionId && !sessionId) {
        setSessionId(data.sessionId);
        localStorage.setItem('chatSessionId', data.sessionId);
        fetchSessions();
      }
      setPendingAttachments(prev => [...prev, ...(data.attachments || [])]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${e.message}` }]);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const removePendingAttachment = (idx) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  // Generate an image from the current text as a prompt.
  const handleGenerateImage = async () => {
    if (!message.trim() || isLoading) return;
    const prompt = message;
    setMessage('');
    setMessages(prev => [...prev, { role: 'user', content: `🎨 ${prompt}` }]);
    setIsLoading(true);
    try {
      const res = await fetch('/api/chat/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, sessionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${data.error || 'Gagal generate gambar'}` }]);
        return;
      }
      if (data.session && !sessionId) {
        setSessionId(data.session.id);
        localStorage.setItem('chatSessionId', data.session.id);
        fetchSessions();
      }
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.assistantMessage.content,
        attachments: parseAttachments(data.assistantMessage.attachments),
      }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal menghubungi server.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  // Edit/modify an uploaded image using a prompt (image-to-image).
  const handleEditImage = async (att) => {
    if (!sessionId) {
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ Kirim gambarnya dulu ke sesi ini sebelum diedit.' }]);
      return;
    }
    const prompt = window.prompt('Mau diedit jadi seperti apa? Deskripsikan perubahannya:');
    if (!prompt || !prompt.trim()) return;

    setMessages(prev => [...prev, { role: 'user', content: `✏️ Edit gambar (${att.name}): ${prompt}` }]);
    setIsLoading(true);
    try {
      const res = await fetch('/api/chat/image/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, sessionId, sourcePath: att.path }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${data.error || 'Gagal edit gambar'}` }]);
        return;
      }
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.assistantMessage.content,
        attachments: parseAttachments(data.assistantMessage.attachments),
      }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal menghubungi server.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteSession = async (id) => {
    if (!confirm("Hapus obrolan ini?")) return;
    // Files live outside the DB, so deleting them is a separate opt-in choice.
    const deleteFiles = confirm(
      'Hapus juga semua file (upload/generated) sesi ini dari server?\n\n' +
      'OK = hapus obrolan + file (permanen)\n' +
      'Cancel = hapus obrolan saja'
    );
    await fetch(`/api/chat?sessionId=${id}&deleteFiles=${deleteFiles}`, { method: 'DELETE' });
    if (sessionId === id) {
      handleNewChat();
    }
    fetchSessions();
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const saveSettings = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings)
    });
    setShowSettings(false);
  };

  const handleSend = async () => {
    if (isLoading) return;
    if (imageMode) return handleGenerateImage();

    const hasText = message.trim().length > 0;
    const hasAttachments = pendingAttachments.length > 0;
    if (!hasText && !hasAttachments) return;

    const userMsg = message;
    const attachments = pendingAttachments;
    setMessage('');
    setPendingAttachments([]);
    setMessages(prev => [...prev, { role: 'user', content: userMsg, attachments }]);
    setIsLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMsg, sessionId, attachments })
      });

      const data = await res.json();
      
      if (!res.ok) {
        const errorMsg = data.details ? `${data.error}: ${data.details}` : `Error: ${data.error}`;
        setMessages(prev => [...prev, { role: 'assistant', content: errorMsg }]);
        return;
      }

      if (data.session && !sessionId) {
        setSessionId(data.session.id);
        localStorage.setItem('chatSessionId', data.session.id);
        fetchSessions(); // Refresh sidebar list
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.assistantMessage.content,
        attachments: parseAttachments(data.assistantMessage.attachments),
      }]);
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Gagal menghubungi server.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="app-container">
      <Sidebar 
        setShowSettings={setShowSettings} 
        currentMode="chat" 
        sessions={sessions}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        currentSessionId={sessionId}
      />

      <div className="main-content">
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', padding: '1rem', borderBottom: '1px solid var(--surface-border)' }}>
          {sessionId && (
            <button onClick={() => setShowFiles(true)} style={{
              background: 'var(--input-bg)',
              color: 'white',
              border: '1px solid var(--surface-border)',
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              cursor: 'pointer'
            }}>
              📂 File Chat
            </button>
          )}
          <button onClick={handleNewChat} style={{
            background: 'var(--primary)',
            color: 'white',
            border: 'none',
            padding: '0.5rem 1rem',
            borderRadius: '6px',
            cursor: 'pointer'
          }}>
            + Sesi Baru
          </button>
        </div>
        <div className="chat-container">
          {messages.map((msg, idx) => (
            <div key={idx} className={`message animate-fade-in ${msg.role === 'user' ? 'user' : 'agent glass'}`}>
              {msg.content && <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>}
              {msg.attachments && msg.attachments.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: msg.content ? '0.5rem' : 0 }}>
                  {msg.attachments.map((att, i) => (
                    att.type === 'image' && att.dataUrl ? (
                      <img
                        key={i}
                        src={att.dataUrl}
                        alt={att.name}
                        style={{ maxWidth: '260px', maxHeight: '260px', borderRadius: '8px', border: '1px solid var(--surface-border)' }}
                      />
                    ) : att.path && sessionId ? (
                      <a
                        key={i}
                        href={`/api/chat/download?sessionId=${sessionId}&path=${encodeURIComponent(att.path)}`}
                        download
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                          background: 'var(--input-bg)', border: '1px solid var(--surface-border)',
                          padding: '0.3rem 0.6rem', borderRadius: '6px', fontSize: '0.8rem',
                          color: 'inherit', textDecoration: 'none'
                        }}
                        title="Klik untuk download"
                      >
                        {attIcon(att)} {att.name} <span style={{ opacity: 0.6 }}>⬇</span>
                      </a>
                    ) : (
                      <span key={i} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                        background: 'var(--input-bg)', border: '1px solid var(--surface-border)',
                        padding: '0.3rem 0.6rem', borderRadius: '6px', fontSize: '0.8rem'
                      }}>
                        📎 {att.name}
                      </span>
                    )
                  ))}
                </div>
              )}
            </div>
          ))}
          {isLoading && (
            <div className="message agent glass animate-fade-in" style={{ opacity: 0.7 }}>
              AI sedang mengetik...
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="input-area glass">
          {/* Hidden native pickers driven by the toolbar buttons. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => handleUpload(e.target.files)}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => handleUpload(e.target.files)}
          />

          {/* Pending attachment previews before sending. */}
          {pendingAttachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
              {pendingAttachments.map((att, i) => (
                <div key={i} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                  background: 'var(--input-bg)', border: '1px solid var(--surface-border)',
                  padding: '0.25rem 0.5rem', borderRadius: '6px', fontSize: '0.8rem'
                }}>
                  {att.type === 'image' && att.dataUrl
                    ? <img src={att.dataUrl} alt={att.name} style={{ width: '28px', height: '28px', objectFit: 'cover', borderRadius: '4px' }} />
                    : <span>📎</span>}
                  <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                  {att.type === 'image' && (
                    <button
                      onClick={() => handleEditImage(att)}
                      disabled={isLoading}
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.9rem', lineHeight: 1 }}
                      title="Edit / modifikasi gambar ini dengan prompt"
                    >✏️</button>
                  )}
                  <button
                    onClick={() => removePendingAttachment(i)}
                    style={{ background: 'none', border: 'none', color: '#ef5350', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
                    title="Hapus lampiran"
                  >×</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button
              onClick={() => imageInputRef.current?.click()}
              disabled={isUploading}
              title="Kirim gambar (untuk dibaca / dimodifikasi)"
              style={toolbarBtn}
            >🖼️ Gambar</button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              title="Kirim file (untuk dibaca / dianalisa)"
              style={toolbarBtn}
            >📎 File</button>
            <button
              onClick={() => setImageMode(v => !v)}
              title="Mode generate gambar dari teks"
              style={{ ...toolbarBtn, background: imageMode ? 'var(--primary)' : 'var(--input-bg)', color: imageMode ? '#fff' : undefined }}
            >🎨 Generate Gambar {imageMode ? 'ON' : 'OFF'}</button>
            {isUploading && <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Mengunggah...</span>}
          </div>

          <div className="input-box">
            <input 
              type="text" 
              placeholder={imageMode ? 'Deskripsikan gambar yang ingin dibuat...' : 'Ketik pesan Anda di sini...'} 
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            />
            <button onClick={handleSend} disabled={isLoading || isUploading}>
              {isLoading ? '...' : imageMode ? 'Generate' : 'Kirim'}
            </button>
          </div>
        </div>
      </div>

      {showSettings && (
        <SettingsModal 
          settings={settings}
          setSettings={setSettings}
          onSave={saveSettings}
          onCancel={() => setShowSettings(false)}
        />
      )}

      {showFiles && sessionId && (
        <FileBrowser
          sessionId={sessionId}
          apiBase="/api/chat/files"
          downloadBase="/api/chat/download"
          onClose={() => setShowFiles(false)}
        />
      )}
    </div>
  );
}
