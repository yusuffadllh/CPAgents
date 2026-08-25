'use client';

import { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import SettingsModal from './components/SettingsModal';
import FileBrowser from './components/FileBrowser';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { cleanGoalInput } from '../lib/context';

// Matches the auto-appended deploy task (see app/api/agent/route.js). Such a
// task is a marker for the manual Deploy button, not work for the OpenCode loop.
const DEPLOY_TASK_RE = /deploy|publish|luncurkan|terbitkan|online|go.?live|hosting/i;

export default function Home() {
  const [settings, setSettings] = useState({ baseUrl: '', apiKey: '', modelName: '', vercelToken: '', netlifyToken: '' });
  const [showSettings, setShowSettings] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [goal, setGoal] = useState('');
  const [tasks, setTasks] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  
  // To allow multiple sessions to run concurrently, we track executing sessions
  const [executingSessions, setExecutingSessions] = useState({});
  const abortControllersRef = useRef({});

  // Auto-retry budget for FAILED tasks (e.g. transient gateway errors). When
  // exhausted we pause the loop so the user can fix the gateway, instead of
  // spinning forever re-failing every task.
  const MAX_AUTO_RETRIES = 3;
  const autoRetriesRef = useRef(0);

  // Set when the user explicitly clicks "Lanjutkan": lets the loop run a review
  // pass even when a deploy task is still pending, so the button always does
  // something visible instead of instantly re-pausing.
  const forceLoopRef = useRef(false);

  const [maxLoops, setMaxLoops] = useState(3);
  const [loopCount, setLoopCount] = useState(0);
  const [isReviewing, setIsReviewing] = useState(false);
  const [isStopped, setIsStopped] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [projectName, setProjectName] = useState('');

  const [showRevise, setShowRevise] = useState(false);
  const [reviseText, setReviseText] = useState('');
  const [isRevising, setIsRevising] = useState(false);

  // Live Logs for the current session
  const [liveLogs, setLiveLogs] = useState('');

  const fetchSessions = (autoLoadFirst = false) => {
    fetch(`/api/chat?type=agent&t=${Date.now()}`)
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

  const handleStop = () => {
    setIsStopped(true);
    if (sessionId && abortControllersRef.current[sessionId]) {
      abortControllersRef.current[sessionId].abort();
      delete abortControllersRef.current[sessionId];
      setExecutingSessions(prev => ({ ...prev, [sessionId]: false }));
    }
  };

  const handleResume = () => {
    setIsStopped(false);
  };

  const executeNextTask = async () => {
    if (!sessionId || !tasks.length || isStopped || executingSessions[sessionId]) return;
    
    // Also pick up FAILED tasks so "mulai lagi" actually retries them. Skip the
    // deploy marker task — that only runs via the manual Deploy button.
    const nextTask = tasks.find(t =>
      !DEPLOY_TASK_RE.test(t.description || '') &&
      (t.status === 'PENDING' || t.status === 'RUNNING' || t.status === 'FAILED')
    );
    if (!nextTask) return;

    const currentSessionId = sessionId;

    setExecutingSessions(prev => ({ ...prev, [currentSessionId]: true }));
    setLiveLogs('Menghubungkan ke server...\n');
    setIsAtLogBottom(true);
    abortControllersRef.current[currentSessionId] = new AbortController();
    
    try {
      setTasks(prev => prev.map(t => t.id === nextTask.id ? { ...t, status: 'RUNNING' } : t));
      
      const res = await fetch('/api/agent/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, taskId: nextTask.id }),
        signal: abortControllersRef.current[currentSessionId].signal
      });

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }

      // Read SSE Stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let isDone = false;
      let finalTasks = null;
      let buffer = '';

      while (!isDone) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'log') {
                setSessionId(currentView => {
                  if (currentView === currentSessionId) {
                    setLiveLogs(prev => prev + data.message + '\n');
                  }
                  return currentView;
                });
              } else if (data.type === 'done') {
                finalTasks = data.tasks;
                isDone = true;
              } else if (data.type === 'error') {
                console.error("API Error:", data);
                if (sessionId === currentSessionId) {
                  alert(`Error: ${data.error}\n${data.details || ''}`);
                }
                isDone = true;
              }
            } catch (e) {
              console.error("Parse error on SSE line:", line, e);
            }
          }
        }
      }

      // Update tasks if we finished successfully
      if (finalTasks) {
        setSessionId(currentView => {
          if (currentView === currentSessionId) {
            setTasks(finalTasks);
          }
          return currentView;
        });
        fetchSessions(); // keep sidebar project progress in sync
      } else {
        // Stream ended without a 'done' event (server maxDuration cut it, or the
        // connection dropped). Re-fetch task state from the DB so the loop can
        // continue instead of getting stuck on a RUNNING task forever.
        try {
          const check = await fetch(`/api/agent?sessionId=${currentSessionId}`);
          const checkData = await check.json();
          if (check.ok && checkData.tasks) {
            setSessionId(currentView => {
              if (currentView === currentSessionId) {
                setTasks(checkData.tasks);
              }
              return currentView;
            });
          }
        } catch (e) {
          console.error('Fallback task re-fetch failed:', e);
        }
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        console.log("Execution aborted by user.");
      } else {
        console.error("Execute error:", err);
      }
      setSessionId(currentView => {
        if (currentView === currentSessionId) {
          setTasks(prev => prev.map(t => t.id === nextTask.id ? { ...t, status: 'PENDING' } : t));
          setIsStopped(true);
        }
        return currentView;
      });
    } finally {
      setExecutingSessions(prev => ({ ...prev, [currentSessionId]: false }));
      if (abortControllersRef.current[currentSessionId]) {
        delete abortControllersRef.current[currentSessionId];
      }
    }
  };

  const executeReview = async () => {
    if (isStopped || isReviewing) return;
    setIsReviewing(true);
    setLiveLogs(prev => prev + '🔍 Mengevaluasi hasil untuk mencari task lanjutan...\n');
    try {
      const res = await fetch('/api/agent/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      const data = await res.json();
      if (res.ok && data.tasks) {
        setTasks(data.tasks);
        fetchSessions(); // keep sidebar project progress in sync
        if (data.newTasksAdded) {
          setLiveLogs(prev => prev + '➕ Evaluasi menambah task baru.\n');
          setLoopCount(prev => prev + 1);
        } else {
          // No new work: stop the loop and say so, otherwise the button appears
          // to do nothing at all.
          setLiveLogs(prev => prev + 'ℹ️ Evaluasi tidak menemukan task baru — project dianggap selesai.\n');
          setLoopCount(Infinity);
          setIsStopped(true);
        }
      } else if (!res.ok) {
        setIsStopped(true);
        setLiveLogs(prev => prev + `❌ Evaluasi gagal: ${data.error || 'unknown'}\n`);
        alert(data.details ? `Gagal mengevaluasi: ${data.error}\n\n${data.details}` : `Gagal mengevaluasi: ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      setLiveLogs(prev => prev + `❌ Evaluasi error: ${err.message}\n`);
      setIsStopped(true);
    } finally {
      setIsReviewing(false);
    }
  };

  const handleSend = async () => {
    if (!goal.trim() || isLoading) return;
    setIsLoading(true);
    setHasSubmitted(true);
    setIsStopped(false);
    setLoopCount(0);
    setLiveLogs('');

    // Strip web-paste junk (e.g. GitHub "Public / Updated X ago") before sending.
    const cleanedGoal = cleanGoalInput(goal);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: cleanedGoal, sessionId })
      });
      
      const data = await res.json();
      
      if (res.ok && data.tasks) {
        setTasks(data.tasks);
        setSessionId(data.session.id);
        fetchSessions();
      } else if (!res.ok) {
        alert(data.details ? `${data.error}\n\nDetails: ${data.details}` : `Error: ${data.error}`);
        setHasSubmitted(false);
      }
    } catch (error) {
      console.error(error);
      setHasSubmitted(false);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectSession = async (id) => {
    setSessionId(id);
    setLiveLogs(''); // Reset logs for the new view
    // Reset the loop counter so a resumed project can loop again from scratch.
    setLoopCount(0);

    // Check if the new session is currently executing in background
    if (executingSessions[id]) {
      setIsStopped(false);
      setLiveLogs('Sedang berjalan di latar belakang... (Log live mungkin terlewat sebagian)\n');
    } else {
      // Pause by default when opening a project; the user explicitly clicks
      // "Lanjutkan" to resume the loop for unfinished tasks.
      setIsStopped(true);
    }

    try {
      const res = await fetch(`/api/agent?sessionId=${id}`);
      const data = await res.json();
      if (res.ok) {
        if (data.session) {
          setGoal(data.session.goal);
          // If a task is stuck in RUNNING but this browser isn't actively
          // executing the session, the previous run died mid-task. Reset it to
          // PENDING so the loop can pick it up again on "Lanjutkan".
          const rawTasks = data.tasks || [];
          const tasksToShow = executingSessions[id]
            ? rawTasks
            : rawTasks.map(t => (t.status === 'RUNNING' ? { ...t, status: 'PENDING' } : t));
          setTasks(tasksToShow);
          setHasSubmitted(true);
        } else {
          setTasks([]);
          setGoal('');
          setHasSubmitted(false);
        }
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Resume the loop for the currently open project: reset any FAILED/stuck
  // RUNNING tasks back to PENDING, clear the auto-retry budget + loop counter,
  // then unpause so the loop actually picks work up again. Without resetting the
  // retry budget, a project that already exhausted its retries would immediately
  // re-pause (Stop flickers back to "Lanjutkan" and nothing runs).
  const handleContinueProject = async () => {
    const toReset = tasks.filter(t => t.status === 'FAILED' || t.status === 'RUNNING');
    if (toReset.length > 0) {
      try {
        await Promise.all(
          toReset.map(t =>
            fetch('/api/agent/retry', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ taskId: t.id }),
            })
          )
        );
      } catch (e) {
        console.error('Gagal mereset task sebelum lanjut', e);
      }
      setTasks(prev => prev.map(t =>
        (t.status === 'FAILED' || t.status === 'RUNNING') ? { ...t, status: 'PENDING', result: null } : t
      ));
    }
    autoRetriesRef.current = 0;
    forceLoopRef.current = true;
    setLoopCount(0);
    setIsStopped(false);
  };

  // Reset a FAILED task back to PENDING so the loop picks it up and runs it again.
  const handleRetryTask = async (taskId) => {
    try {
      await fetch('/api/agent/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });
      setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, status: 'PENDING', result: null } : t)));
      autoRetriesRef.current = 0;
      setLoopCount(0);
      setIsStopped(false);
    } catch (e) {
      console.error('Gagal retry task', e);
    }
  };

  // Reset ALL failed tasks and resume the loop (used after fixing the gateway).
  const handleRetryAllFailed = async () => {
    const failed = tasks.filter(t => t.status === 'FAILED');
    if (failed.length === 0) return;
    try {
      await Promise.all(
        failed.map(t =>
          fetch('/api/agent/retry', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: t.id }),
          })
        )
      );
    } catch (e) {
      console.error('Gagal reset task gagal', e);
    }
    setTasks(prev => prev.map(t => (t.status === 'FAILED' ? { ...t, status: 'PENDING', result: null } : t)));
    autoRetriesRef.current = 0;
    setLoopCount(0);
    setIsStopped(false);
  };

  // Turn the user's feedback on the deployed result into a fresh plan. The old
  // unfinished backlog is dropped server-side so the revision runs first.
  const handleRevise = async () => {
    if (!sessionId || isRevising || !reviseText.trim()) return;

    handleStop();
    setIsRevising(true);
    try {
      const res = await fetch('/api/agent/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, feedback: reviseText }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.details ? `${data.error}\n\n${data.details}` : `Error: ${data.error}`);
        return;
      }

      setTasks(data.tasks || []);
      setReviseText('');
      setShowRevise(false);
      setLiveLogs(`📝 Revisi diterima: ${data.removed} task lama dibuang, ${data.added} task revisi dibuat.\n`);

      autoRetriesRef.current = 0;
      forceLoopRef.current = true;
      setLoopCount(0);
      setIsStopped(false);
    } catch (e) {
      console.error('Gagal mengirim revisi', e);
      alert(`Gagal mengirim revisi: ${e.message}`);
    } finally {
      setIsRevising(false);
    }
  };

  const handleDeploy = async () => {
    if (!sessionId || isDeploying) return;

    // Always re-read settings from the DB so a token added mid-run is picked up,
    // even if the local React state is stale. The deploy API reads the DB too,
    // so this only guards the pre-check + keeps the badges in sync.
    let liveSettings = settings;
    try {
      const sRes = await fetch('/api/settings');
      if (sRes.ok) {
        const data = await sRes.json();
        if (data) {
          liveSettings = { ...settings, ...data };
          setSettings(liveSettings);
        }
      }
    } catch { /* fall back to current state */ }

    if (!liveSettings.vercelToken && !liveSettings.netlifyToken) {
      alert('Belum ada kredensial deploy. Isi Vercel/Netlify token dulu di Settings.');
      setShowSettings(true);
      return;
    }

    const currentSessionId = sessionId;
    setIsDeploying(true);
    // Pause the auto-loop while deploying.
    setIsStopped(true);
    setLiveLogs('🚀 Memulai deploy...\n');
    abortControllersRef.current[currentSessionId] = new AbortController();

    try {
      const res = await fetch('/api/agent/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, projectName }),
        signal: abortControllersRef.current[currentSessionId].signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let isDone = false;
      let buffer = '';

      while (!isDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'log') {
                setLiveLogs(prev => prev + data.message + '\n');
              } else if (data.type === 'done') {
                if (data.liveUrl) {
                  setLiveLogs(prev => prev + `\n🌐 Live URL: ${data.liveUrl}${data.urlStatus ? ` (HTTP ${data.urlStatus})` : ''}\n`);
                }
                // Only close the deploy marker when the URL actually serves content;
                // a green build with a 404 URL must stay open so the user can retry.
                if (data.ok !== false) {
                  setTasks(prev => prev.map(t =>
                    DEPLOY_TASK_RE.test(t.description || '') ? { ...t, status: 'COMPLETED' } : t
                  ));
                } else {
                  setLiveLogs(prev => prev + `⚠️ Deploy belum benar-benar live. Perbaiki konfigurasi lalu klik Deploy lagi.\n`);
                }
                isDone = true;
              } else if (data.type === 'error') {
                setLiveLogs(prev => prev + `❌ ${data.error}: ${data.details || ''}\n`);
                isDone = true;
              }
            } catch (e) {
              console.error('Parse error on deploy SSE line:', line, e);
            }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setLiveLogs(prev => prev + `❌ Deploy gagal: ${e.message}\n`);
      }
    } finally {
      setIsDeploying(false);
      fetchSessions();
    }
  };

  const pendingCount = tasks.filter(t => t.status === 'PENDING' || t.status === 'RUNNING').length;
  const failedCount = tasks.filter(t => t.status === 'FAILED').length;
  // "Done" only when nothing is pending AND nothing failed.
  const allTasksDone = tasks.length > 0 && pendingCount === 0 && failedCount === 0;

  const handleDeleteSession = async (id) => {
    if (abortControllersRef.current[id]) {
      abortControllersRef.current[id].abort();
      delete abortControllersRef.current[id];
    }
    
    if (sessionId === id) {
      setIsStopped(true);
      setTasks([]);
      setGoal('');
      setSessionId(null);
      setHasSubmitted(false);
      setLiveLogs('');
    }
    
    try {
      await fetch(`/api/chat?sessionId=${id}`, { method: 'DELETE' });
      fetchSessions();
    } catch (e) {
      console.error("Gagal menghapus sesi", e);
    }
  };

  const exportAsZip = async () => {
    const zip = new JSZip();
    const markdownContent = tasks.map((t, i) => `## Task ${i + 1}: ${t.description}\n\n**Status:** ${t.status}\n\n### Result\n${t.result || 'No output'}`).join('\n\n---\n\n');
    zip.file("execution_report.md", `# AI Agent Execution Report\n\n**Goal:** ${goal}\n\n---\n\n${markdownContent}`);
    const blob = await zip.generateAsync({ type: "blob" });
    saveAs(blob, "agent-output.zip");
  };

  const saveSettings = async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setShowSettings(false);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchSessions(true);
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (res.ok) {
          const data = await res.json();
          if (data) setSettings((prev) => ({ ...prev, ...data }));
        }
      } catch (e) {
        console.error('Gagal memuat settings', e);
      }
    })();
  }, []);

  useEffect(() => {
    if (hasSubmitted && tasks.length > 0 && !isStopped && sessionId) {
      // A deploy task is a marker, not real work: it must NOT run through the
      // OpenCode loop. It's satisfied only by the manual Deploy button.
      const isDeployTask = (t) => DEPLOY_TASK_RE.test(t.description || '');
      const workTasks = tasks.filter(t => !isDeployTask(t));
      const deployTasks = tasks.filter(isDeployTask);

      const hasPending = workTasks.some(t => t.status === 'PENDING');
      const hasRunning = workTasks.some(t => t.status === 'RUNNING');
      const hasFailed = workTasks.some(t => t.status === 'FAILED');
      const isExecuting = executingSessions[sessionId];
      const pendingDeploy = deployTasks.some(t => t.status !== 'COMPLETED');

      if ((hasPending || hasRunning) && !isExecuting && !isReviewing) {
        // Normal work still queued — reset the retry budget and run it.
        autoRetriesRef.current = 0;
        executeNextTask();
      } else if (hasFailed && !isExecuting && !isReviewing) {
        // Only failed tasks left: auto-retry a limited number of times so a
        // transient gateway error recovers on its own, but a persistent outage
        // pauses the loop instead of failing forever.
        if (autoRetriesRef.current < MAX_AUTO_RETRIES) {
          autoRetriesRef.current += 1;
          setLiveLogs(prev => prev + `↻ Mencoba ulang task yang gagal (percobaan ${autoRetriesRef.current}/${MAX_AUTO_RETRIES})...\n`);
          executeNextTask();
        } else {
          setLiveLogs(prev => prev + `⏸ Task masih gagal setelah ${MAX_AUTO_RETRIES}x. Loop dihentikan — cek koneksi gateway (pakai Ping AI di Settings), lalu klik "Coba Lagi".\n`);
          setIsStopped(true);
        }
      } else if (!hasPending && !hasRunning && !hasFailed && !isExecuting && !isReviewing) {
        autoRetriesRef.current = 0;
        // All real work is done. A waiting deploy task normally pauses the loop
        // so the user can click Deploy — but if they explicitly asked to keep
        // looping, honour that instead of immediately re-pausing (which looked
        // like the button did nothing).
        if (pendingDeploy && !forceLoopRef.current) {
          setLiveLogs(prev => prev + `✅ Semua task selesai. Siap deploy — klik tombol "🚀 Deploy" untuk menerbitkan.\n`);
          setIsStopped(true);
        } else {
          const limit = parseInt(maxLoops, 10);
          if (isNaN(limit) || loopCount < limit) {
            forceLoopRef.current = false;
            executeReview();
          } else {
            forceLoopRef.current = false;
            setLiveLogs(prev => prev + `⏹ Batas looping (${limit}) sudah tercapai. Naikkan "Max Loop" bila ingin agent terus menambah task.\n`);
            setIsStopped(true);
          }
        }
      }
    }
  }, [tasks, executingSessions, isReviewing, hasSubmitted, isStopped, maxLoops, loopCount, sessionId]);

  // Tampilkan API key tersensor: 4 char pertama + 4 char terakhir saja.
  const maskApiKey = (key) => {
    if (!key) return 'API key belum diatur';
    if (key.length <= 8) return '••••••••';
    return `${key.slice(0, 4)}••••${key.slice(-4)}`;
  };

  // Auto-scroll live logs, but only when the user is already near the bottom.
  // If they scrolled up to read earlier output, don't yank them back down;
  // instead show a "jump to latest" button (isAtLogBottom === false).
  const logsEndRef = useRef(null);
  const logsContainerRef = useRef(null);
  const [isAtLogBottom, setIsAtLogBottom] = useState(true);

  const handleLogsScroll = () => {
    const el = logsContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtLogBottom(distanceFromBottom < 40);
  };

  const scrollLogsToBottom = () => {
    const el = logsContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setIsAtLogBottom(true);
  };

  useEffect(() => {
    if (isAtLogBottom && logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [liveLogs, isAtLogBottom]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: 'var(--bg-gradient)', color: 'var(--foreground)' }}>
      <div style={{ width: '280px', flexShrink: 0, borderRight: '1px solid var(--surface-border)', zIndex: 10 }}>
        <Sidebar 
          setShowSettings={setShowSettings} 
          currentMode="agent" 
          sessions={sessions}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          currentSessionId={sessionId}
        />
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', position: 'relative' }}>
        <div className="blob" style={{ top: '-10%', left: '-10%', animationDelay: '0s' }}></div>
        <div className="blob" style={{ bottom: '-10%', right: '-10%', animationDelay: '2s', background: 'radial-gradient(circle, rgba(144,202,249,0.15) 0%, rgba(144,202,249,0) 70%)' }}></div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 1 }}>
          <div style={{ width: '100%', maxWidth: '1200px', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            
            <div className="glass" style={{ padding: '2rem', borderRadius: '16px', display: 'flex', flexDirection: 'column', gap: '1.5rem', width: '100%' }}>
              <h1 style={{ fontSize: '1.8rem', fontWeight: '800', textAlign: 'center', background: 'linear-gradient(90deg, #bb86fc, #90caf9)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                Antigravity Agent
              </h1>

              {/* Config aktif: berubah otomatis saat baseURL / model / API key diganti. */}
              <div
                onClick={() => setShowSettings(true)}
                title="Klik untuk mengubah konfigurasi"
                style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.5rem', marginTop: '-0.5rem', cursor: 'pointer' }}
              >
                <span style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(144,202,249,0.12)', border: '1px solid rgba(144,202,249,0.3)', color: '#90caf9' }}>
                  🔗 {settings.baseUrl || 'baseURL belum diatur'}
                </span>
                <span style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(187,134,252,0.12)', border: '1px solid rgba(187,134,252,0.3)', color: '#bb86fc' }}>
                  🤖 {settings.modelName || 'model belum diatur'}
                </span>
                <span style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(129,199,132,0.12)', border: '1px solid rgba(129,199,132,0.3)', color: '#81c784' }}>
                  🔑 {maskApiKey(settings.apiKey)}
                </span>
                {settings.vercelToken ? (
                  <span title="Token Vercel tersimpan — siap deploy" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.35)', color: '#fff' }}>
                    ▲ Vercel ✓
                  </span>
                ) : (
                  <span title="Token Vercel belum diatur" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(255,255,255,0.04)', border: '1px dashed rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.5)' }}>
                    ▲ Vercel —
                  </span>
                )}
                {settings.netlifyToken ? (
                  <span title="Token Netlify tersimpan — siap deploy" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(45,204,211,0.12)', border: '1px solid rgba(45,204,211,0.4)', color: '#2dccd3' }}>
                    ◈ Netlify ✓
                  </span>
                ) : (
                  <span title="Token Netlify belum diatur" style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', borderRadius: '999px', background: 'rgba(45,204,211,0.04)', border: '1px dashed rgba(45,204,211,0.25)', color: 'rgba(45,204,211,0.5)' }}>
                    ◈ Netlify —
                  </span>
                )}
              </div>

              {!hasSubmitted ? (
                <div style={{ width: '100%', maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="input-box" style={{ borderRadius: '24px', padding: '0.5rem', display: 'flex', alignItems: 'center' }}>
                    <textarea 
                      placeholder="Apa yang ingin Anda capai hari ini?"
                      value={goal}
                      onChange={(e) => {
                        setGoal(e.target.value);
                        e.target.style.height = 'auto';
                        e.target.style.height = (e.target.scrollHeight) + 'px';
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSend();
                        }
                      }}
                      style={{ flex: 1, padding: '1rem', border: 'none', background: 'transparent', color: 'white', resize: 'none', minHeight: '60px', maxHeight: '200px', outline: 'none' }}
                    />
                    <button onClick={handleSend} disabled={isLoading || !goal.trim()} style={{ width: '50px', height: '50px', borderRadius: '50%', background: 'var(--accent)', marginLeft: '0.5rem', padding: 0 }}>
                      {isLoading ? '⏳' : '↑'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                    <label htmlFor="maxLoops" style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)' }}>
                      🔄 Max loop review
                    </label>
                    <input
                      id="maxLoops"
                      type="number"
                      min="0"
                      value={maxLoops}
                      onChange={(e) => setMaxLoops(e.target.value)}
                      style={{ width: '70px', padding: '0.35rem 0.5rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white', outline: 'none' }}
                    />
                    <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.45)' }}>
                      {String(maxLoops).trim() === '' ? 'kosong = tanpa batas' : parseInt(maxLoops, 10) === 0 ? '0 = tanpa review tambahan' : `agent menambah task maks. ${parseInt(maxLoops, 10)}x`}
                    </span>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div style={{ padding: '1rem', background: 'var(--input-bg)', borderRadius: '12px', border: '1px solid var(--surface-border)' }}>
                    <strong>Goal:</strong> {goal}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'rgba(255,255,255,0.7)' }}>
                    <label htmlFor="maxLoopsRunning">🔄 Max loop review</label>
                    <input
                      id="maxLoopsRunning"
                      type="number"
                      min="0"
                      value={maxLoops}
                      onChange={(e) => setMaxLoops(e.target.value)}
                      title="Berapa kali agent boleh mengevaluasi hasil lalu menambah task baru. Kosongkan untuk tanpa batas."
                      style={{ width: '70px', padding: '0.3rem 0.5rem', borderRadius: '8px', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', color: 'white', outline: 'none' }}
                    />
                    <span style={{ color: 'rgba(255,255,255,0.45)' }}>
                      terpakai {loopCount === Infinity ? '∞' : loopCount}
                      {String(maxLoops).trim() === '' ? ' / ∞' : ` / ${parseInt(maxLoops, 10)}`}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                    <button onClick={() => {
                      if (sessionId && abortControllersRef.current[sessionId]) abortControllersRef.current[sessionId].abort();
                      setHasSubmitted(false);
                      setGoal('');
                      setTasks([]);
                      setSessionId(null);
                      setIsStopped(false);
                      setLiveLogs('');
                    }} style={{ background: 'var(--input-bg)', color: 'white', border: '1px solid var(--surface-border)', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}>
                      ✨ Mulai Tujuan Baru
                    </button>
                    {!isStopped && (
                      <button onClick={handleStop} style={{ background: '#f44336', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}>
                        ⏹ Stop
                      </button>
                    )}
                    {isStopped && failedCount > 0 && (
                      <button onClick={handleRetryAllFailed} style={{ background: '#ff9800', color: '#000', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }} title="Reset task gagal ke antrean dan jalankan loop lagi">
                        ↻ Coba Lagi ({failedCount} gagal)
                      </button>
                    )}
                    {isStopped && pendingCount > 0 && failedCount === 0 && (
                      <button onClick={handleContinueProject} style={{ background: '#4CAF50', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}>
                        ▶ Lanjutkan Task ({pendingCount} tersisa)
                      </button>
                    )}
                    {isStopped && allTasksDone && (
                      <button onClick={handleContinueProject} style={{ background: '#4CAF50', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }} title="Jalankan evaluasi ulang untuk menambah task lanjutan">
                        🔁 Lanjutkan Looping
                      </button>
                    )}
                    <button
                      onClick={() => setShowRevise(v => !v)}
                      title="Sudah lihat hasilnya? Tulis apa yang perlu diperbaiki — task lama yang belum jalan akan dibuang."
                      style={{ background: showRevise ? '#c2185b' : '#e91e63', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}
                    >
                      📝 Revisi
                    </button>
                    <button
                      onClick={() => setShowFiles(true)}
                      title="Lihat isi folder project ini"
                      style={{ background: '#2196f3', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}
                    >
                      📂 Lihat File
                    </button>
                    <input
                      type="text"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder="nama-web (opsional)"
                      title="Nama project di Vercel → jadi nama-web.vercel.app. Kosongkan untuk otomatis."
                      style={{ background: 'var(--input-bg)', color: 'inherit', border: '1px solid var(--surface-border)', padding: '0.5rem 0.6rem', borderRadius: '6px', fontSize: '0.85rem', width: '160px' }}
                    />
                    <button
                      onClick={handleDeploy}
                      disabled={isDeploying}
                      title="Publish project ini online (Vercel/Netlify)"
                      style={{ background: isDeploying ? '#9e9e9e' : '#673ab7', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: isDeploying ? 'not-allowed' : 'pointer' }}
                    >
                      {isDeploying ? '🚀 Deploying...' : '🚀 Deploy'}
                    </button>
                    <button onClick={exportAsZip} style={{ background: 'var(--surface-border)', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}>
                      💾 Export MD
                    </button>
                    <a href={`/api/export?sessionId=${sessionId}`} target="_blank" rel="noopener noreferrer" style={{ background: 'var(--accent)', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', textDecoration: 'none', display: 'flex', alignItems: 'center' }}>
                      📦 Export Workspace ZIP
                    </a>
                  </div>

                  {showRevise && (
                    <div className="animate-fade-in" style={{ marginTop: '0.75rem', padding: '1rem', background: 'var(--input-bg)', border: '1px solid var(--surface-border)', borderRadius: '10px' }}>
                      <div style={{ fontSize: '0.85rem', opacity: 0.8, marginBottom: '0.5rem' }}>
                        Tulis apa yang kurang dari hasil yang sudah kamu lihat. Sertakan data asli (link GitHub/LinkedIn, nama, bio) supaya agent tidak mengarang.
                        Task yang belum jalan akan dibuang, lalu revisi ini dikerjakan lebih dulu.
                      </div>
                      <textarea
                        value={reviseText}
                        onChange={(e) => setReviseText(e.target.value)}
                        placeholder={'Contoh:\n- Ganti semua placeholder dengan data asli saya:\n  GitHub: https://github.com/yusuffadllh\n  LinkedIn: https://linkedin.com/in/...\n- Hero section masih polos, bikin lebih menarik\n- Di HP layoutnya rusak, bagian project kepotong'}
                        rows={7}
                        style={{ width: '100%', background: 'var(--surface-bg, rgba(0,0,0,0.2))', color: 'inherit', border: '1px solid var(--surface-border)', borderRadius: '8px', padding: '0.75rem', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
                        <button
                          onClick={handleRevise}
                          disabled={isRevising || !reviseText.trim()}
                          style={{ background: isRevising || !reviseText.trim() ? '#9e9e9e' : '#e91e63', color: 'white', border: 'none', padding: '0.5rem 1.2rem', borderRadius: '6px', cursor: isRevising || !reviseText.trim() ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                        >
                          {isRevising ? '⏳ Menyusun task revisi...' : '✅ Kirim Revisi'}
                        </button>
                        <button
                          onClick={() => setShowRevise(false)}
                          style={{ background: 'transparent', color: 'inherit', border: '1px solid var(--surface-border)', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}
                        >
                          Batal
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {isLoading && (
              <div className="animate-fade-in" style={{ padding: '1rem', textAlign: 'center', opacity: 0.7 }}>
                Agent sedang merencanakan tugas awal...
              </div>
            )}
            
            {isReviewing && (
              <div className="animate-fade-in" style={{ padding: '1rem', textAlign: 'center', color: '#ff9800' }}>
                🔍 Agent sedang mengevaluasi hasil (Loop {loopCount + 1})...
              </div>
            )}

            {tasks.length > 0 && (
              <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'stretch', width: '100%', overflow: 'hidden' }}>
                
                {/* Left Column: To Do List */}
                <div className="glass animate-fade-in" style={{ width: '35%', flexShrink: 0, padding: '1.5rem', borderRadius: '12px', overflowY: 'auto', maxHeight: '70vh' }}>
                  <h3 style={{ marginBottom: '1rem', color: 'var(--accent)' }}>To Do List (Plan)</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {tasks.map((task, idx) => (
                      <div key={idx} style={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        gap: '0.75rem',
                        padding: '0.6rem 0.75rem',
                        background: 'var(--input-bg)',
                        border: '1px solid var(--surface-border)',
                        borderRadius: '8px',
                        opacity: task.status === 'PENDING' ? 0.7 : 1
                      }}>
                        <div style={{ 
                          width: '22px', 
                          height: '22px', 
                          borderRadius: '50%', 
                          border: '2px solid var(--accent)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.7rem',
                          flexShrink: 0
                        }}>
                          {task.status === 'COMPLETED' ? '✓' : (task.status === 'FAILED' ? '✗' : (task.status === 'RUNNING' ? '⚙' : idx + 1))}
                        </div>
                        <div style={{ flex: 1, fontWeight: task.status === 'RUNNING' ? 'bold' : 'normal', fontSize: '0.85rem', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                          {task.description}
                        </div>
                        <div style={{ 
                          fontSize: '0.65rem', 
                          padding: '0.15rem 0.4rem', 
                          borderRadius: '4px',
                          flexShrink: 0,
                          background: task.status === 'PENDING' ? 'rgba(255,255,255,0.1)' : (task.status === 'RUNNING' ? '#ff9800' : (task.status === 'FAILED' ? '#f44336' : 'var(--accent)')),
                          color: task.status === 'RUNNING' ? '#000' : '#fff'
                        }}>
                          {task.status}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Right Column: Execution Results */}
                <div className="glass animate-fade-in" style={{ flex: 1, minWidth: 0, padding: '1.5rem', borderRadius: '12px', overflowY: 'auto', maxHeight: '70vh' }}>
                  <h3 style={{ marginBottom: '1rem', color: 'var(--accent)' }}>Hasil Eksekusi</h3>

                  {/* Live log for activity that isn't tied to a RUNNING task
                      (review/looping, deploy, pause messages) — without this the
                      UI looks frozen when those run. */}
                  {liveLogs && !tasks.some(t => t.status === 'RUNNING') && (
                    <div style={{ position: 'relative', marginBottom: '1.5rem' }}>
                      <div
                        ref={logsContainerRef}
                        onScroll={handleLogsScroll}
                        style={{
                          background: '#0d1117',
                          color: '#00ff00',
                          padding: '1rem',
                          borderRadius: '8px',
                          fontFamily: 'monospace',
                          fontSize: '0.85rem',
                          whiteSpace: 'pre-wrap',
                          maxHeight: '220px',
                          overflowY: 'auto',
                          border: '1px solid #30363d'
                        }}>
                        {liveLogs}
                        <div ref={logsEndRef} />
                      </div>
                      {!isAtLogBottom && (
                        <button
                          onClick={scrollLogsToBottom}
                          title="Ke log terbaru"
                          style={{
                            position: 'absolute',
                            bottom: '0.75rem',
                            right: '0.75rem',
                            padding: '0.35rem 0.75rem',
                            borderRadius: '999px',
                            background: 'var(--accent)',
                            color: '#000',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: '0.75rem',
                            fontWeight: 'bold',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
                          }}>
                          ↓ Ke bawah
                        </button>
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                    {tasks.filter(t => t.result || t.status === 'RUNNING').map((task) => (
                      <div key={task.id} style={{
                        padding: '1rem',
                        background: 'var(--input-bg)',
                        border: '1px solid var(--surface-border)',
                        borderRadius: '8px',
                        overflow: 'hidden'
                      }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.5rem', color: 'var(--accent)', borderBottom: '1px solid var(--surface-border)', paddingBottom: '0.5rem' }}>
                          {task.description}
                        </div>
                        
                        {task.status === 'RUNNING' && (
                          <div style={{ position: 'relative', marginTop: '0.5rem' }}>
                            <div
                              ref={logsContainerRef}
                              onScroll={handleLogsScroll}
                              style={{
                                background: '#0d1117',
                                color: '#00ff00',
                                padding: '1rem',
                                borderRadius: '8px',
                                fontFamily: 'monospace',
                                fontSize: '0.85rem',
                                whiteSpace: 'pre-wrap',
                                maxHeight: '300px',
                                overflowY: 'auto',
                                border: '1px solid #30363d'
                              }}>
                              {liveLogs || 'Menunggu AI...'}
                              <div ref={logsEndRef} />
                            </div>
                            {!isAtLogBottom && (
                              <button
                                onClick={scrollLogsToBottom}
                                title="Ke log terbaru"
                                style={{
                                  position: 'absolute',
                                  bottom: '0.75rem',
                                  right: '0.75rem',
                                  padding: '0.35rem 0.75rem',
                                  borderRadius: '999px',
                                  background: 'var(--accent)',
                                  color: '#000',
                                  border: 'none',
                                  cursor: 'pointer',
                                  fontSize: '0.75rem',
                                  fontWeight: 'bold',
                                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '0.25rem'
                                }}>
                                ↓ Ke bawah
                              </button>
                            )}
                          </div>
                        )}

                        {task.result && (task.status === 'COMPLETED' || task.status === 'FAILED') && (
                          <>
                            {task.status === 'FAILED' && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                <span style={{ fontSize: '0.7rem', padding: '0.15rem 0.5rem', borderRadius: '4px', background: '#f44336', color: '#fff', fontWeight: 'bold' }}>GAGAL</span>
                                <button onClick={() => handleRetryTask(task.id)} style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem', borderRadius: '4px', background: '#ff9800', color: '#000', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                                  🔄 Mulai ulang task
                                </button>
                              </div>
                            )}
                            <div className="markdown-content" style={{ fontSize: '0.95rem', lineHeight: '1.6', overflowWrap: 'break-word', wordBreak: 'break-word' }}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.result}</ReactMarkdown>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                    {tasks.filter(t => t.result || t.status === 'RUNNING').length === 0 && (
                      <div style={{ opacity: 0.5, fontStyle: 'italic' }}>Belum ada hasil eksekusi.</div>
                    )}
                  </div>
                </div>

              </div>
            )}
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
        <FileBrowser sessionId={sessionId} onClose={() => setShowFiles(false)} />
      )}
    </div>
  );
}
