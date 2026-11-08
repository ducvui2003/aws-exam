import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BookOpen,
  Clock,
  CheckCircle2,
  XCircle,
  Flag,
  HelpCircle,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  Eye,
  Play,
  Award,
  Layers,
  Shuffle,
  Moon,
  Sun,
  Upload,
  Filter,
  CheckSquare,
  Sparkles,
  ArrowLeft,
  Pause,
  Maximize2,
  LayoutGrid,
  History,
  Trash2,
  Save,
  Settings,
  Database,
  RefreshCw,
  Lock,
  LogOut,
  FolderArchive,
  ShieldCheck,
  X
} from 'lucide-react';

const STORAGE_KEY = 'aws_saa_exam_progress_v1';
const HISTORY_STORAGE_KEY = 'aws_saa_exam_history_v1';
const ADMIN_TOKEN_KEY = 'aws_saa_admin_token';
const ADMIN_USER_KEY = 'aws_saa_admin_user';
const EXAM_DURATION_SECONDS = 130 * 60; // 130 minutes

function loadSavedProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveProgressToStorage(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save progress:', e);
  }
}

function loadSavedHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveHistoryToStorage(data) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error('Failed to save history:', e);
  }
}

// SQLite API helpers
async function apiSyncProgress(examId, state) {
  try {
    await fetch('/api/progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examId, state }),
    });
  } catch {
    // Fallback to localStorage
  }
}

async function apiSaveAttempt(examId, attempt) {
  try {
    await fetch('/api/attempts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ examId, attempt }),
    });
  } catch {
    // Fallback to localStorage
  }
}

async function apiDeleteAttempt(attemptId) {
  try {
    await fetch(`/api/attempts?id=${encodeURIComponent(attemptId)}`, {
      method: 'DELETE',
    });
  } catch {
    // Fallback to localStorage
  }
}

function isAnswerSetCorrect(correctAnswers = [], selectedAnswers = []) {
  if (!selectedAnswers || selectedAnswers.length === 0) return false;
  if (correctAnswers.length !== selectedAnswers.length) return false;
  const setA = new Set(correctAnswers.map((s) => s.trim()));
  return selectedAnswers.every((s) => setA.has(s.trim()));
}

function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatDateTime(isoString) {
  if (!isoString) return 'Recorded in JSON';
  try {
    const d = new Date(isoString);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function buildOriginalJsonAttempt(examId, json) {
  const questions = json?.attemptAnswers || [];
  if (questions.length === 0) return null;

  const answers = {};
  const flagged = {};
  let answered = 0;
  let correct = 0;
  let incorrect = 0;
  let flaggedCount = 0;

  questions.forEach((q) => {
    const qKey = String(q.questionId);
    if (Array.isArray(q.selectedAnswers) && q.selectedAnswers.length > 0) {
      answers[qKey] = q.selectedAnswers;
      answered++;
      if (isAnswerSetCorrect(q.correctAnswer, q.selectedAnswers)) {
        correct++;
      } else {
        incorrect++;
      }
    }
    if (q.isFlagged) {
      flagged[qKey] = true;
      flaggedCount++;
    }
  });

  if (answered === 0) return null;

  const total = questions.length;
  const pct = Math.round((correct / total) * 100);
  const scaledScore = Math.round(100 + (correct / total) * 900);

  return {
    id: `${examId}-json-original`,
    examId,
    label: 'Original JSON Attempt',
    isOriginalJson: true,
    submittedAt: null,
    mode: 'exam',
    durationSeconds: null,
    total,
    answered,
    unanswered: total - answered,
    correct,
    incorrect,
    flaggedCount,
    pct,
    scaledScore,
    passed: scaledScore >= 720,
    answers,
    flagged,
  };
}

export default function App() {
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('aws_saa_theme') === 'dark';
  });

  // Home page navigation tab: 'exams' (public) | 'settings' (admin protected)
  const [homeTab, setHomeTab] = useState('exams');
  const [settingsExamFilter, setSettingsExamFilter] = useState('all');

  // Admin authentication state for Settings tab
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem(ADMIN_TOKEN_KEY) || '');
  const [adminUsername, setAdminUsername] = useState(
    () => sessionStorage.getItem(ADMIN_USER_KEY) || ''
  );
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // SQLite backend metadata
  const [sqliteInfo, setSqliteInfo] = useState({
    connected: false,
    backupCount: 6,
    examsCount: 6,
    questionsCount: 390,
    progressCount: 0,
    attemptsCount: 0,
  });

  // Catalog loaded from SQLite `exams` & `questions` tables
  const [examCatalog, setExamCatalog] = useState({});
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  // Active exam state
  const [activeExamId, setActiveExamId] = useState(null);
  const [activeExamData, setActiveExamData] = useState(null);
  const [mode, setMode] = useState('practice'); // 'practice' | 'exam' | 'review'
  const [currentIdx, setCurrentIdx] = useState(0);

  // Previewing a specific submitted attempt object
  const [previewAttempt, setPreviewAttempt] = useState(null);
  const [historyModalExamId, setHistoryModalExamId] = useState(null);

  // Mobile Question Navigator Bottom Sheet
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  // User in-progress state & multi-submission history
  const [allProgress, setAllProgress] = useState(() => loadSavedProgress());
  const [examHistory, setExamHistory] = useState(() => loadSavedHistory());

  // Practice/Exam options
  const [instantCheck, setInstantCheck] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [onlyRetryWrongIds, setOnlyRetryWrongIds] = useState(null);
  const [questionOrder, setQuestionOrder] = useState([]);

  // Timer & Pause state for Exam Mode (130 minutes = 7800 seconds)
  const [timeLeft, setTimeLeft] = useState(EXAM_DURATION_SECONDS);
  const [timerRunning, setTimerRunning] = useState(false);
  const [examPausedModal, setExamPausedModal] = useState(false);
  const [examSubmitted, setExamSubmitted] = useState(false);
  const autoSubmitTriggeredRef = useRef(false);

  // Lightbox for explanation images
  const [lightboxSrc, setLightboxSrc] = useState(null);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('aws_saa_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('aws_saa_theme', 'light');
    }
  }, [darkMode]);

  // Fetch exams from SQLite (`exams` + `questions` tables)
  const fetchExamsCatalogFromSqlite = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const res = await fetch('/api/exams');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.ok && data.catalog) {
        setExamCatalog(data.catalog);
      }
    } catch (err) {
      console.error('Failed to load exams from SQLite API:', err);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);

  // Fetch state from SQLite database (/api/state)
  const fetchSqliteState = useCallback(async () => {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) throw new Error('SQLite API unavailable');
      const data = await res.json();
      if (data.ok) {
        setSqliteInfo({
          connected: true,
          backupCount: data.backupCount ?? 6,
          examsCount: data.examsCount ?? 6,
          questionsCount: data.questionsCount ?? 390,
          progressCount: data.progressCount || 0,
          attemptsCount: data.attemptsCount || 0,
        });

        const hasSqliteProgress = Object.keys(data.progress || {}).length > 0;
        const hasSqliteHistory = Object.keys(data.history || {}).length > 0;

        if (hasSqliteProgress) {
          setAllProgress(data.progress);
          saveProgressToStorage(data.progress);
        }

        if (hasSqliteHistory) {
          setExamHistory(data.history);
          saveHistoryToStorage(data.history);
        }
      }
    } catch {
      setSqliteInfo((prev) => ({ ...prev, connected: false }));
    }
  }, []);

  useEffect(() => {
    fetchExamsCatalogFromSqlite();
    fetchSqliteState();
  }, [fetchExamsCatalogFromSqlite, fetchSqliteState]);

  // Admin Login handler
  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUser, password: loginPass }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setLoginError(data.error || 'Invalid credentials');
      } else {
        setAdminToken(data.token);
        setAdminUsername(data.username);
        sessionStorage.setItem(ADMIN_TOKEN_KEY, data.token);
        sessionStorage.setItem(ADMIN_USER_KEY, data.username);
        setLoginPass('');
        fetchSqliteState();
      }
    } catch {
      setLoginError('Failed to connect to authentication server');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleAdminLogout = async () => {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    } catch {
      // ignore
    }
    setAdminToken('');
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  };

  const handleRestoreFromBackup = async () => {
    try {
      const res = await fetch('/api/admin/restore-backup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 401) {
        handleAdminLogout();
        return;
      }
      const data = await res.json();
      if (data.ok) {
        await fetchExamsCatalogFromSqlite();
        await fetchSqliteState();
        alert(
          `Synced ${data.importedExams} exams (${data.totalQuestions} questions) from backup into SQLite!`
        );
      }
    } catch (err) {
      alert('Failed to sync from backup: ' + err.message);
    }
  };

  // Active state source
  const currentExamProgress = useMemo(() => {
    if (previewAttempt) {
      return {
        answers: previewAttempt.answers || {},
        revealed: {},
        flagged: previewAttempt.flagged || {},
        session: null,
      };
    }
    if (!activeExamId) return { answers: {}, revealed: {}, flagged: {}, session: null };
    return (
      allProgress[activeExamId] || {
        answers: {},
        revealed: {},
        flagged: {},
        session: null,
      }
    );
  }, [previewAttempt, allProgress, activeExamId]);

  const updateExamProgress = useCallback(
    (updater) => {
      if (!activeExamId || previewAttempt) return;
      setAllProgress((prev) => {
        const current = prev[activeExamId] || {
          answers: {},
          revealed: {},
          flagged: {},
          session: null,
        };
        const nextExamState = typeof updater === 'function' ? updater(current) : updater;
        const nextAll = { ...prev, [activeExamId]: nextExamState };
        saveProgressToStorage(nextAll);
        apiSyncProgress(activeExamId, nextExamState);
        return nextAll;
      });
    },
    [activeExamId, previewAttempt]
  );

  // Save current session snapshot (mode, timeLeft, currentIdx, questionOrder, isPaused)
  const persistCurrentSession = useCallback(
    (overrides = {}) => {
      if (!activeExamId || previewAttempt || examSubmitted || mode === 'review') return;
      const sessionSnapshot = {
        mode,
        timeLeft,
        currentIdx,
        questionOrder,
        isPaused: true,
        updatedAt: new Date().toISOString(),
        ...overrides,
      };
      updateExamProgress((prev) => ({
        ...prev,
        session: sessionSnapshot,
      }));
    },
    [
      activeExamId,
      previewAttempt,
      examSubmitted,
      mode,
      timeLeft,
      currentIdx,
      questionOrder,
      updateExamProgress,
    ]
  );

  // Scroll to top smoothly when changing questions
  const goToQuestion = useCallback(
    (idx) => {
      setCurrentIdx(idx);
      setMobileDrawerOpen(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (activeExamId && !previewAttempt && !examSubmitted && mode !== 'review') {
        updateExamProgress((prev) => ({
          ...prev,
          session: {
            mode,
            timeLeft,
            currentIdx: idx,
            questionOrder,
            isPaused: true,
            updatedAt: new Date().toISOString(),
          },
        }));
      }
    },
    [
      activeExamId,
      previewAttempt,
      examSubmitted,
      mode,
      timeLeft,
      questionOrder,
      updateExamProgress,
    ]
  );

  // Ordered questions list
  const orderedQuestions = useMemo(() => {
    if (!activeExamData?.attemptAnswers) return [];
    const raw = activeExamData.attemptAnswers;
    const order =
      questionOrder.length === raw.length ? questionOrder : raw.map((_, i) => i);
    return order.map((origIndex, displayIndex) => ({
      ...raw[origIndex],
      origIndex,
      displayNumber: displayIndex + 1,
    }));
  }, [activeExamData, questionOrder]);

  // Compute live statistics
  const activeStats = useMemo(() => {
    const total = orderedQuestions.length;
    let answered = 0;
    let correct = 0;
    let incorrect = 0;
    let flagged = 0;

    orderedQuestions.forEach((q) => {
      const qKey = String(q.questionId);
      const sel = currentExamProgress.answers[qKey] || [];
      if (currentExamProgress.flagged[qKey]) flagged++;
      if (sel.length > 0) {
        answered++;
        if (isAnswerSetCorrect(q.correctAnswer, sel)) {
          correct++;
        } else {
          incorrect++;
        }
      }
    });

    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
    const progressPct = total > 0 ? Math.round((answered / total) * 100) : 0;
    const scaledScore = total > 0 ? Math.round(100 + (correct / total) * 900) : 100;
    return {
      total,
      answered,
      unanswered: total - answered,
      correct,
      incorrect,
      flagged,
      pct,
      progressPct,
      scaledScore,
      passed: scaledScore >= 720,
    };
  }, [orderedQuestions, currentExamProgress]);

  // Save current progress as a new submitted attempt in SQLite and clear active paused session
  const saveSubmissionToHistory = useCallback(
    async (submissionMode = mode) => {
      if (!activeExamId || !activeExamData) return;
      const currentState = allProgress[activeExamId] || { answers: {}, flagged: {} };
      const questions = activeExamData.attemptAnswers || [];
      const total = questions.length;

      let answered = 0;
      let correct = 0;
      let incorrect = 0;
      let flaggedCount = 0;

      questions.forEach((q) => {
        const qKey = String(q.questionId);
        const sel = currentState.answers?.[qKey] || [];
        if (currentState.flagged?.[qKey]) flaggedCount++;
        if (sel.length > 0) {
          answered++;
          if (isAnswerSetCorrect(q.correctAnswer, sel)) {
            correct++;
          } else {
            incorrect++;
          }
        }
      });

      const pct = total > 0 ? Math.round((correct / total) * 100) : 0;
      const scaledScore = total > 0 ? Math.round(100 + (correct / total) * 900) : 100;
      const durationSeconds =
        submissionMode === 'exam'
          ? Math.max(0, EXAM_DURATION_SECONDS - timeLeft)
          : null;

      const newAttempt = {
        id: `${activeExamId}-attempt-${Date.now()}`,
        examId: activeExamId,
        submittedAt: new Date().toISOString(),
        mode: submissionMode,
        durationSeconds,
        total,
        answered,
        unanswered: total - answered,
        correct,
        incorrect,
        flaggedCount,
        pct,
        scaledScore,
        passed: scaledScore >= 720,
        answers: { ...(currentState.answers || {}) },
        flagged: { ...(currentState.flagged || {}) },
      };

      setExamHistory((prev) => {
        const existing = prev[activeExamId] || [];
        const updated = [newAttempt, ...existing];
        const nextHistory = { ...prev, [activeExamId]: updated };
        saveHistoryToStorage(nextHistory);
        return nextHistory;
      });

      // Clear active paused session once submitted
      setAllProgress((prev) => {
        const nextAll = { ...prev };
        delete nextAll[activeExamId];
        saveProgressToStorage(nextAll);
        return nextAll;
      });
      await apiSyncProgress(activeExamId, null);

      await apiSaveAttempt(activeExamId, newAttempt);
      fetchSqliteState();

      setExamSubmitted(true);
      setTimerRunning(false);
      setExamPausedModal(false);
      setPreviewAttempt(newAttempt);
    },
    [activeExamId, activeExamData, allProgress, mode, timeLeft, fetchSqliteState]
  );

  // 1. Countdown Timer Tick Effect for Exam Mode
  useEffect(() => {
    if (mode !== 'exam' || !timerRunning || examSubmitted || previewAttempt) return;
    const interval = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [mode, timerRunning, examSubmitted, previewAttempt]);

  // 2. Auto-Submit Effect when Exam Mode Timer reaches 0
  useEffect(() => {
    if (
      mode === 'exam' &&
      !examSubmitted &&
      !previewAttempt &&
      timeLeft === 0 &&
      !autoSubmitTriggeredRef.current
    ) {
      autoSubmitTriggeredRef.current = true;
      setTimerRunning(false);
      setExamPausedModal(false);
      saveSubmissionToHistory('exam');
    }
  }, [mode, examSubmitted, previewAttempt, timeLeft, saveSubmissionToHistory]);

  // Pause & Continue handlers in Exam Mode
  const handlePauseExam = () => {
    setTimerRunning(false);
    setExamPausedModal(true);
    persistCurrentSession({ isPaused: true });
  };

  const handleContinueExamFromModal = () => {
    setExamPausedModal(false);
    if (mode === 'exam' && !examSubmitted && !previewAttempt) {
      setTimerRunning(true);
    }
  };

  const handleSaveAndExitToHome = () => {
    persistCurrentSession({ isPaused: true });
    setTimerRunning(false);
    setExamPausedModal(false);
    setPreviewAttempt(null);
    setActiveExamId(null);
  };

  // Start an exam (or continue a paused exam, or preview a submitted attempt)
  const startExam = (examId, selectedMode = 'practice', options = {}) => {
    const catalogEntry = examCatalog[examId];
    if (!catalogEntry || !catalogEntry.rawData) return;

    const rawQuestions = catalogEntry.rawData.attemptAnswers || [];
    setActiveExamId(examId);
    setActiveExamData(catalogEntry.rawData);
    setSearchQuery('');
    setStatusFilter('all');
    setOnlyRetryWrongIds(options.retryWrongIds || null);
    setMobileDrawerOpen(false);
    setHistoryModalExamId(null);
    setExamPausedModal(false);
    autoSubmitTriggeredRef.current = false;

    // Case A: Previewing a past submitted attempt
    if (options.attemptToPreview) {
      setMode('review');
      setQuestionOrder(rawQuestions.map((_, i) => i));
      setCurrentIdx(0);
      setPreviewAttempt(options.attemptToPreview);
      setTimerRunning(false);
      setExamSubmitted(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setPreviewAttempt(null);

    // Case B: Continuing a paused / saved session
    if (options.continueSession) {
      const savedProg = allProgress[examId] || {};
      const sess = savedProg.session || {};
      const resumeMode = sess.mode || selectedMode || 'exam';
      const resumeTime =
        typeof sess.timeLeft === 'number' && sess.timeLeft > 0
          ? sess.timeLeft
          : EXAM_DURATION_SECONDS;
      const resumeOrder =
        Array.isArray(sess.questionOrder) && sess.questionOrder.length === rawQuestions.length
          ? sess.questionOrder
          : rawQuestions.map((_, i) => i);
      const resumeIdx =
        typeof sess.currentIdx === 'number' &&
        sess.currentIdx >= 0 &&
        sess.currentIdx < rawQuestions.length
          ? sess.currentIdx
          : 0;

      setMode(resumeMode);
      setQuestionOrder(resumeOrder);
      setCurrentIdx(resumeIdx);
      setExamSubmitted(false);
      if (resumeMode === 'exam') {
        setTimeLeft(resumeTime);
        setTimerRunning(true);
      } else {
        setTimerRunning(false);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    // Case C: Starting a brand-new session
    const indices = rawQuestions.map((_, i) => i);
    if (options.shuffle) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
    }
    setQuestionOrder(indices);
    setCurrentIdx(0);
    setMode(selectedMode);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (selectedMode === 'exam') {
      // Fresh Exam Mode: clear all choices and start 130:00 timer
      const freshExamState = {
        answers: {},
        revealed: {},
        flagged: {},
        session: {
          mode: 'exam',
          timeLeft: EXAM_DURATION_SECONDS,
          currentIdx: 0,
          questionOrder: indices,
          isPaused: true,
          updatedAt: new Date().toISOString(),
        },
      };
      setAllProgress((prev) => {
        const nextAll = { ...prev, [examId]: freshExamState };
        saveProgressToStorage(nextAll);
        return nextAll;
      });
      apiSyncProgress(examId, freshExamState);
      setTimeLeft(EXAM_DURATION_SECONDS);
      setTimerRunning(true);
      setExamSubmitted(false);
    } else {
      setTimerRunning(false);
      setExamSubmitted(false);
    }
  };

  // Load Original JSON Attempt into SQLite History (from Admin Settings tab)
  const handleLoadJsonHistoryToSqlite = async (examId) => {
    const entry = examCatalog[examId];
    if (!entry?.rawData) return;
    const origAttempt = buildOriginalJsonAttempt(examId, entry.rawData);
    if (!origAttempt) {
      alert('No recorded selectedAnswers found for this exam.');
      return;
    }
    setExamHistory((prev) => {
      const existing = (prev[examId] || []).filter((a) => a.id !== origAttempt.id);
      const next = { ...prev, [examId]: [origAttempt, ...existing] };
      saveHistoryToStorage(next);
      return next;
    });
    await apiSaveAttempt(examId, origAttempt);
    await fetchSqliteState();
  };

  const handleLoadAllJsonHistoryToSqlite = async () => {
    for (const examId of Object.keys(examCatalog)) {
      const entry = examCatalog[examId];
      if (entry?.rawData) {
        const origAttempt = buildOriginalJsonAttempt(examId, entry.rawData);
        if (origAttempt) {
          await apiSaveAttempt(examId, origAttempt);
        }
      }
    }
    await fetchSqliteState();
  };

  const deleteHistoryAttempt = async (examId, attemptId, e) => {
    if (e) e.stopPropagation();
    setExamHistory((prev) => {
      const list = (prev[examId] || []).filter((a) => a.id !== attemptId);
      const next = { ...prev, [examId]: list };
      saveHistoryToStorage(next);
      return next;
    });
    await apiDeleteAttempt(attemptId);
    await fetchSqliteState();
    if (previewAttempt?.id === attemptId) {
      setPreviewAttempt(null);
      setExamSubmitted(false);
    }
  };

  const resetExamProgress = async (examId, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm('Reset your current in-progress / paused session for this test?')) return;
    setAllProgress((prev) => {
      const next = { ...prev };
      delete next[examId];
      saveProgressToStorage(next);
      return next;
    });
    await apiSyncProgress(examId, null);
    await fetchSqliteState();
    if (activeExamId === examId) {
      setPreviewAttempt(null);
      setExamSubmitted(false);
      setOnlyRetryWrongIds(null);
      setCurrentIdx(0);
    }
  };

  // Handle custom JSON upload into SQLite `exams` + `questions` tables and backup archive
  const handleCustomFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (!Array.isArray(json.attemptAnswers)) {
          alert('Invalid exam JSON: missing "attemptAnswers" array.');
          return;
        }
        const examId = file.name.replace(/\.json$/i, '').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
        const title = json.examName || file.name.replace(/\.json$/i, '');

        const res = await fetch('/api/admin/import-exam', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ examId, json, title }),
        });

        if (res.ok) {
          await fetchExamsCatalogFromSqlite();
          await fetchSqliteState();
          alert(`Imported "${title}" into SQLite and archived backup copy!`);
        } else {
          const errData = await res.json();
          alert('Import failed: ' + (errData.error || res.statusText));
        }
      } catch (err) {
        alert('Could not parse JSON file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const filteredQuestions = useMemo(() => {
    return orderedQuestions.filter((q) => {
      const qKey = String(q.questionId);
      if (onlyRetryWrongIds && !onlyRetryWrongIds.has(qKey)) {
        return false;
      }

      const selected = currentExamProgress.answers[qKey] || [];
      const isFlagged = !!currentExamProgress.flagged[qKey];
      const isAnswered = selected.length > 0;
      const isCorrect = isAnswerSetCorrect(q.correctAnswer, selected);
      const isMulti = (q.correctAnswer?.length || 1) > 1;

      if (statusFilter === 'unanswered' && isAnswered) return false;
      if (statusFilter === 'correct' && (!isAnswered || !isCorrect)) return false;
      if (statusFilter === 'incorrect' && (!isAnswered || isCorrect)) return false;
      if (statusFilter === 'flagged' && !isFlagged) return false;
      if (statusFilter === 'multi' && !isMulti) return false;

      if (searchQuery.trim()) {
        const term = searchQuery.toLowerCase();
        const inQuestion = q.questionText?.toLowerCase().includes(term);
        const inAnswers = q.answers?.some((a) => a.toLowerCase().includes(term));
        const inExplanation = q.explanation?.toLowerCase().includes(term);
        const inId = String(q.questionId).includes(term);
        if (!inQuestion && !inAnswers && !inExplanation && !inId) return false;
      }

      return true;
    });
  }, [orderedQuestions, currentExamProgress, statusFilter, searchQuery, onlyRetryWrongIds]);

  useEffect(() => {
    if (currentIdx >= filteredQuestions.length && filteredQuestions.length > 0) {
      setCurrentIdx(0);
    }
  }, [filteredQuestions.length, currentIdx]);

  const currentQuestion = filteredQuestions[currentIdx] || null;

  // Handle selecting an option (also saves session timeLeft + currentIdx)
  const handleSelectOption = useCallback(
    (question, optionHtml) => {
      if (previewAttempt || examPausedModal) return;
      if (mode === 'review') return;
      if (mode === 'exam' && examSubmitted) return;

      const qKey = String(question.questionId);
      const maxChoices = question.correctAnswer?.length || 1;

      updateExamProgress((prev) => {
        const currentSelected = prev.answers[qKey] || [];
        let nextSelected;

        if (maxChoices === 1) {
          nextSelected = [optionHtml];
        } else {
          if (currentSelected.includes(optionHtml)) {
            nextSelected = currentSelected.filter((item) => item !== optionHtml);
          } else {
            if (currentSelected.length >= maxChoices) {
              nextSelected = [...currentSelected.slice(1), optionHtml];
            } else {
              nextSelected = [...currentSelected, optionHtml];
            }
          }
        }

        const nextRevealed = { ...prev.revealed };
        if (mode === 'practice' && instantCheck && nextSelected.length === maxChoices) {
          nextRevealed[qKey] = true;
        }

        return {
          ...prev,
          answers: { ...prev.answers, [qKey]: nextSelected },
          revealed: nextRevealed,
          session: {
            mode,
            timeLeft,
            currentIdx,
            questionOrder,
            isPaused: true,
            updatedAt: new Date().toISOString(),
          },
        };
      });
    },
    [
      previewAttempt,
      examPausedModal,
      mode,
      examSubmitted,
      instantCheck,
      timeLeft,
      currentIdx,
      questionOrder,
      updateExamProgress,
    ]
  );

  const toggleRevealCurrent = useCallback(() => {
    if (!currentQuestion || previewAttempt) return;
    const qKey = String(currentQuestion.questionId);
    updateExamProgress((prev) => ({
      ...prev,
      revealed: {
        ...prev.revealed,
        [qKey]: !prev.revealed[qKey],
      },
    }));
  }, [currentQuestion, previewAttempt, updateExamProgress]);

  const toggleFlagCurrent = useCallback(() => {
    if (!currentQuestion || previewAttempt) return;
    const qKey = String(currentQuestion.questionId);
    updateExamProgress((prev) => ({
      ...prev,
      flagged: {
        ...prev.flagged,
        [qKey]: !prev.flagged[qKey],
      },
      session: {
        mode,
        timeLeft,
        currentIdx,
        questionOrder,
        isPaused: true,
        updatedAt: new Date().toISOString(),
      },
    }));
  }, [
    currentQuestion,
    previewAttempt,
    mode,
    timeLeft,
    currentIdx,
    questionOrder,
    updateExamProgress,
  ]);

  // Keyboard navigation
  useEffect(() => {
    if (!activeExamId || !currentQuestion || examPausedModal) return;
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToQuestion(Math.min(filteredQuestions.length - 1, currentIdx + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToQuestion(Math.max(0, currentIdx - 1));
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFlagCurrent();
      } else if (e.key === ' ' || e.key === 'Enter') {
        if (mode === 'practice' && !previewAttempt) {
          e.preventDefault();
          toggleRevealCurrent();
        }
      } else if (/^[1-6]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        if (currentQuestion.answers?.[idx]) {
          e.preventDefault();
          handleSelectOption(currentQuestion, currentQuestion.answers[idx]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeExamId,
    currentQuestion,
    currentIdx,
    filteredQuestions.length,
    mode,
    previewAttempt,
    examPausedModal,
    goToQuestion,
    toggleFlagCurrent,
    toggleRevealCurrent,
    handleSelectOption,
  ]);

  const handleExplanationClick = (e) => {
    if (e.target.tagName === 'IMG' && e.target.src) {
      setLightboxSrc(e.target.src);
    }
  };

  // All catalog items sorted cleanly
  const allExamsList = useMemo(() => {
    const keys = Object.keys(examCatalog);
    if (keys.length === 0) return [];
    return keys.sort().map((k) => examCatalog[k]);
  }, [examCatalog]);

  const totalAttemptsCount = useMemo(() => {
    return Object.values(examHistory).reduce((acc, list) => acc + (list?.length || 0), 0);
  }, [examHistory]);

  // Reusable History Modal
  const renderHistoryModal = () => {
    if (!historyModalExamId) return null;
    const examInfo = examCatalog[historyModalExamId];
    const attempts = examHistory[historyModalExamId] || [];

    return (
      <div
        onClick={() => setHistoryModalExamId(null)}
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="bg-white dark:bg-slate-900 w-full sm:max-w-xl rounded-t-3xl sm:rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl max-h-[85vh] flex flex-col overflow-hidden safe-bottom"
        >
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div>
              <h3 className="font-bold text-base flex items-center gap-2">
                <History className="w-4 h-4 text-amber-500" />
                <span>Submission History • {examInfo?.examName || examInfo?.title}</span>
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {attempts.length} submitted {attempts.length === 1 ? 'attempt' : 'attempts'} stored.
              </p>
            </div>
            <button
              onClick={() => setHistoryModalExamId(null)}
              className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4 overflow-y-auto space-y-2.5 flex-1">
            {attempts.length === 0 ? (
              <div className="text-center py-10 text-slate-400 text-sm">
                No submitted attempts yet for this test.
              </div>
            ) : (
              attempts.map((att, index) => {
                const attemptNumber = attempts.length - index;
                const isCurrentlyPreviewing = previewAttempt?.id === att.id;
                return (
                  <div
                    key={att.id}
                    className={`rounded-xl border p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition ${
                      isCurrentlyPreviewing
                        ? 'border-amber-500 bg-amber-50/40 dark:bg-amber-500/10'
                        : 'border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-800/40'
                    }`}
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-xs px-2 py-0.5 rounded-md bg-slate-900 text-white dark:bg-slate-700">
                          {att.isOriginalJson ? 'JSON Record' : `Attempt #${attemptNumber}`}
                        </span>
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${
                            att.passed
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                              : 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
                          }`}
                        >
                          {att.passed ? 'PASS' : 'FAIL'} • {att.pct}% ({att.scaledScore}/1000)
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {formatDateTime(att.submittedAt)}
                        </span>
                      </div>

                      <div className="text-xs text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-3">
                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                          ✓ {att.correct} Correct
                        </span>
                        <span className="text-rose-600 dark:text-rose-400 font-semibold">
                          ✗ {att.incorrect} Wrong
                        </span>
                        <span className="text-slate-500">• {att.unanswered} Skipped</span>
                        {att.flaggedCount > 0 && (
                          <span className="text-amber-600 dark:text-amber-400 font-medium">
                            ⚑ {att.flaggedCount} Flagged
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() =>
                          startExam(historyModalExamId, 'review', {
                            attemptToPreview: att,
                          })
                        }
                        className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white shadow-xs transition cursor-pointer active:scale-95"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>{isCurrentlyPreviewing ? 'Viewing' : 'Preview'}</span>
                      </button>
                      <button
                        onClick={(e) =>
                          deleteHistoryAttempt(historyModalExamId, att.id, e)
                        }
                        title="Delete this attempt"
                        className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  };

  // Reusable Question Navigator & Filter Panel
  const renderNavigatorContent = () => (
    <div className="space-y-4">
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search keyword (e.g. S3, VPC, Aurora)..."
          className="w-full pl-9 pr-8 py-2.5 rounded-xl text-xs sm:text-sm bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-amber-500"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1">
            <Filter className="w-3.5 h-3.5" /> Filter Questions
          </span>
          <span>
            Showing {filteredQuestions.length}/{orderedQuestions.length}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { id: 'all', label: `All (${activeStats.total})` },
            { id: 'unanswered', label: `Left (${activeStats.unanswered})` },
            { id: 'correct', label: `Correct (${activeStats.correct})` },
            { id: 'incorrect', label: `Wrong (${activeStats.incorrect})` },
            { id: 'flagged', label: `Flag (${activeStats.flagged})` },
            { id: 'multi', label: 'Multi-select' },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`px-2 py-2 rounded-xl text-xs font-medium truncate transition cursor-pointer active:scale-95 ${
                statusFilter === f.id
                  ? 'bg-amber-500 text-white font-semibold shadow-xs'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2 flex items-center justify-between">
          <span>Question Map</span>
          <div className="flex items-center gap-2 text-[11px] font-normal">
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500" /> Correct
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-rose-500" /> Wrong
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500" /> Flagged
            </span>
          </div>
        </div>
        <div className="grid grid-cols-6 sm:grid-cols-8 lg:grid-cols-6 xl:grid-cols-7 gap-2 max-h-64 lg:max-h-80 overflow-y-auto p-0.5">
          {filteredQuestions.map((q, idx) => {
            const key = String(q.questionId);
            const sel = currentExamProgress.answers[key] || [];
            const flagged = !!currentExamProgress.flagged[key];
            const answered = sel.length > 0;
            const correct = isAnswerSetCorrect(q.correctAnswer, sel);
            const isCurrent = idx === currentIdx;

            const showResultColor =
              !!previewAttempt ||
              mode === 'review' ||
              (mode === 'exam' && examSubmitted) ||
              (mode === 'practice' && !!currentExamProgress.revealed[key]);

            let btnClass =
              'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200';
            if (answered) {
              if (showResultColor) {
                btnClass = correct
                  ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                  : 'bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-500/40';
              } else {
                btnClass =
                  'bg-sky-500/20 text-sky-700 dark:text-sky-300 border border-sky-500/40';
              }
            }

            return (
              <button
                key={q.questionId}
                onClick={() => goToQuestion(idx)}
                className={`relative h-10 rounded-xl font-semibold text-xs flex items-center justify-center transition cursor-pointer active:scale-95 ${btnClass} ${
                  isCurrent ? 'ring-2 ring-amber-500 font-bold' : ''
                }`}
              >
                {q.displayNumber}
                {flagged && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900" />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  // ============================================================================
  // VIEW 1: DASHBOARD (PUBLIC EXAMS TAB & ADMIN-PROTECTED SETTINGS TAB)
  // ============================================================================
  if (!activeExamId) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 transition-colors pb-10">
        {/* Top Navbar with Public Exams & Admin Settings Tabs */}
        <header className="sticky top-0 z-20 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur">
          <div className="max-w-7xl mx-auto px-3.5 sm:px-6 lg:px-8 h-14 sm:h-16 flex items-center justify-between gap-2">
            {/* Brand */}
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-white font-bold text-sm sm:text-base shadow-xs shrink-0">
                AWS
              </div>
              <div className="truncate">
                <h1 className="text-sm sm:text-lg font-bold tracking-tight truncate">
                  SAA-C03 Exam Hub
                </h1>
                <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 truncate hidden xs:block">
                  Solutions Architect Associate
                </p>
              </div>
            </div>

            {/* Navigation Tabs: Exams (Public) | Settings (Admin) */}
            <div className="flex items-center bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
              <button
                onClick={() => setHomeTab('exams')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  homeTab === 'exams'
                    ? 'bg-white dark:bg-slate-900 text-amber-600 dark:text-amber-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Exams</span>
              </button>

              <button
                onClick={() => {
                  setHomeTab('settings');
                  fetchSqliteState();
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  homeTab === 'settings'
                    ? 'bg-white dark:bg-slate-900 text-amber-600 dark:text-amber-400 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                {adminToken ? (
                  <Settings className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Lock className="w-3.5 h-3.5" />
                )}
                <span>Settings</span>
              </button>
            </div>

            {/* Theme toggle */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setDarkMode((d) => !d)}
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition active:scale-95 cursor-pointer"
                title="Toggle Dark Mode"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="max-w-7xl mx-auto px-3.5 sm:px-6 lg:px-8 py-4 sm:py-8">
          {homeTab === 'exams' ? (
            <>
              {/* Overall Banner */}
              <div className="mb-5 sm:mb-8 rounded-2xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white p-4 sm:p-7 shadow-md border border-slate-800">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 sm:gap-6">
                  <div>
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-400/10 px-2.5 py-1 rounded-full mb-2.5">
                      <Sparkles className="w-3 h-3" /> AWS SAA-C03 Practice Suite
                    </span>
                    <h2 className="text-xl sm:text-3xl font-bold tracking-tight">
                      Master all {sqliteInfo.questionsCount || 390} Exam Questions
                    </h2>
                    <p className="text-slate-300 text-xs sm:text-sm mt-1 max-w-2xl leading-relaxed">
                      6 full-length practice exams (65 questions each) with pause &amp; continue support, 130-minute exam timer, and detailed explanations.
                    </p>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5 sm:gap-4 shrink-0">
                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5 sm:p-3.5 text-center">
                      <div className="text-lg sm:text-2xl font-bold text-amber-400">
                        {allExamsList.length}
                      </div>
                      <div className="text-[11px] text-slate-300">Exams</div>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5 sm:p-3.5 text-center">
                      <div className="text-lg sm:text-2xl font-bold text-emerald-400">
                        {sqliteInfo.questionsCount || 390}
                      </div>
                      <div className="text-[11px] text-slate-300">Questions</div>
                    </div>
                    <div className="bg-white/5 border border-white/10 rounded-xl p-2.5 sm:p-3.5 text-center">
                      <div className="text-lg sm:text-2xl font-bold text-sky-400">72%</div>
                      <div className="text-[11px] text-slate-300">Pass Score</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Public Clean Exam Cards Grid */}
              {loadingCatalog ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <div
                      key={n}
                      className="h-56 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 animate-pulse flex flex-col justify-between"
                    >
                      <div className="h-6 bg-slate-200 dark:bg-slate-800 rounded w-1/2" />
                      <div className="space-y-3">
                        <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-full" />
                        <div className="h-4 bg-slate-200 dark:bg-slate-800 rounded w-3/4" />
                      </div>
                      <div className="h-10 bg-slate-200 dark:bg-slate-800 rounded-xl w-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                  {allExamsList.map((exam, idx) => {
                    const saved = allProgress[exam.id] || {
                      answers: {},
                      flagged: {},
                      session: null,
                    };
                    const questions = exam.rawData?.attemptAnswers || [];
                    const totalQ = exam.totalQuestions || questions.length || 65;

                    let answeredCount = 0;
                    let correctCount = 0;
                    questions.forEach((q) => {
                      const sel = saved.answers?.[String(q.questionId)] || [];
                      if (sel.length > 0) {
                        answeredCount++;
                        if (isAnswerSetCorrect(q.correctAnswer, sel)) {
                          correctCount++;
                        }
                      }
                    });

                    const progressPct =
                      totalQ > 0 ? Math.round((answeredCount / totalQ) * 100) : 0;
                    const accuracyPct =
                      answeredCount > 0
                        ? Math.round((correctCount / answeredCount) * 100)
                        : 0;

                    const hasPausedSession =
                      !!saved.session?.isPaused || answeredCount > 0;
                    const pausedMode = saved.session?.mode || 'practice';
                    const pausedTimeLeft = saved.session?.timeLeft;
                    const pausedQuestionNum = (saved.session?.currentIdx ?? 0) + 1;

                    return (
                      <div
                        key={exam.id}
                        className="group rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-amber-500/60 shadow-xs hover:shadow-md transition-all flex flex-col justify-between overflow-hidden"
                      >
                        <div className="p-4 sm:p-6">
                          <div className="flex items-start justify-between gap-2 mb-3.5">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200/70 dark:border-amber-500/20 flex items-center justify-center text-amber-600 dark:text-amber-400 font-bold text-sm sm:text-base shrink-0">
                                #{idx + 1}
                              </div>
                              <div>
                                <h3 className="font-bold text-base sm:text-lg text-slate-900 dark:text-white leading-snug">
                                  {exam.examName || exam.title}
                                </h3>
                                <span className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1 mt-0.5">
                                  AWS SAA-C03 Practice Exam
                                </span>
                              </div>
                            </div>

                            {hasPausedSession && (
                              <button
                                onClick={(e) => resetExamProgress(exam.id, e)}
                                title="Reset current paused / in-progress session"
                                className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/50 transition cursor-pointer"
                              >
                                <RotateCcw className="w-4 h-4" />
                              </button>
                            )}
                          </div>

                          {/* Badges */}
                          <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-4">
                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                              <Layers className="w-3.5 h-3.5 text-slate-500" />
                              {totalQ} Qs
                            </span>
                            <span className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                              <Clock className="w-3.5 h-3.5 text-slate-500" />
                              130m
                            </span>
                            {hasPausedSession && (
                              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                                <Pause className="w-3 h-3" />
                                Paused ({pausedMode === 'exam' ? 'Exam' : 'Practice'})
                              </span>
                            )}
                          </div>

                          {/* User In-Progress Practice Bar */}
                          <div>
                            <div className="flex items-center justify-between text-xs mb-1.5">
                              <span className="font-medium text-slate-600 dark:text-slate-400">
                                Progress: {answeredCount}/{totalQ} ({progressPct}%)
                              </span>
                              {answeredCount > 0 && pausedMode !== 'exam' && (
                                <span
                                  className={`font-semibold ${
                                    accuracyPct >= 72
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-amber-600 dark:text-amber-400'
                                  }`}
                                >
                                  {correctCount} Correct ({accuracyPct}%)
                                </span>
                              )}
                              {pausedMode === 'exam' && typeof pausedTimeLeft === 'number' && (
                                <span className="font-mono font-semibold text-amber-600 dark:text-amber-400">
                                  ⏱ {formatTime(pausedTimeLeft)} left
                                </span>
                              )}
                            </div>
                            <div className="w-full h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                              <div
                                className={`h-full transition-all duration-300 ${
                                  accuracyPct >= 72 ? 'bg-emerald-500' : 'bg-amber-500'
                                }`}
                                style={{ width: `${progressPct}%` }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Action Buttons Footer */}
                        <div className="px-4 sm:px-6 py-3.5 bg-slate-50/70 dark:bg-slate-900/50 border-t border-slate-100 dark:border-slate-800 space-y-2">
                          {hasPausedSession && (
                            <button
                              onClick={() =>
                                startExam(exam.id, pausedMode, { continueSession: true })
                              }
                              className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl font-bold text-xs bg-emerald-600 hover:bg-emerald-700 active:scale-98 text-white shadow-xs transition cursor-pointer"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              <span>
                                Continue {pausedMode === 'exam' ? 'Exam' : 'Practice'} (Q
                                {pausedQuestionNum}/{totalQ}
                                {pausedMode === 'exam' && typeof pausedTimeLeft === 'number'
                                  ? ` • ${formatTime(pausedTimeLeft)}`
                                  : ''}
                                )
                              </span>
                            </button>
                          )}

                          <div className="grid grid-cols-3 gap-2">
                            <button
                              onClick={() => startExam(exam.id, 'practice')}
                              className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl font-semibold text-xs bg-amber-500 hover:bg-amber-600 active:scale-95 text-white shadow-xs transition cursor-pointer"
                            >
                              <BookOpen className="w-3.5 h-3.5 shrink-0" />
                              <span>Practice</span>
                            </button>
                            <button
                              onClick={() => startExam(exam.id, 'exam')}
                              className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl font-semibold text-xs bg-slate-900 hover:bg-slate-800 dark:bg-slate-800 dark:hover:bg-slate-700 active:scale-95 text-white transition cursor-pointer"
                              title="Start a new timed exam with all choices cleared"
                            >
                              <Play className="w-3.5 h-3.5 shrink-0" />
                              <span>{hasPausedSession ? 'New Exam' : 'Exam'}</span>
                            </button>
                            <button
                              onClick={() => startExam(exam.id, 'review')}
                              className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl font-semibold text-xs bg-white hover:bg-slate-100 dark:bg-slate-900 dark:hover:bg-slate-800 active:scale-95 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 transition cursor-pointer"
                            >
                              <Eye className="w-3.5 h-3.5 shrink-0" />
                              <span>Review</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : !adminToken ? (
            /* ============================================================================ */
            /* ADMIN LOGIN GATE FOR SETTINGS TAB                                            */
            /* ============================================================================ */
            <div className="max-w-md mx-auto my-8 sm:my-14">
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 sm:p-8 shadow-md">
                <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-600 dark:text-amber-400 mx-auto mb-4">
                  <Lock className="w-6 h-6" />
                </div>
                <h2 className="text-xl font-bold text-center">Admin Settings Access</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 text-center mt-1 mb-6">
                  Sign in with your administrator credentials configured in <code className="font-mono">.env</code>.
                </p>

                {loginError && (
                  <div className="mb-4 p-3 rounded-xl bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 text-xs font-medium text-rose-600 dark:text-rose-300 text-center">
                    {loginError}
                  </div>
                )}

                <form onSubmit={handleAdminLogin} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      Admin Username
                    </label>
                    <input
                      type="text"
                      value={loginUser}
                      onChange={(e) => setLoginUser(e.target.value)}
                      required
                      autoComplete="username"
                      className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-amber-500"
                      placeholder="Enter username"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                      Admin Password
                    </label>
                    <input
                      type="password"
                      value={loginPass}
                      onChange={(e) => setLoginPass(e.target.value)}
                      required
                      autoComplete="current-password"
                      className="w-full px-3.5 py-2.5 rounded-xl text-sm bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-amber-500"
                      placeholder="••••••••"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loginLoading}
                    className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm bg-amber-500 hover:bg-amber-600 text-white shadow-xs transition cursor-pointer active:scale-98 disabled:opacity-50"
                  >
                    {loginLoading ? 'Signing in...' : 'Sign In as Admin'}
                  </button>
                </form>
              </div>
            </div>
          ) : (
            /* ============================================================================ */
            /* AUTHENTICATED ADMIN SETTINGS TAB                                             */
            /* ============================================================================ */
            <div className="space-y-6">
              {/* Top Admin Session Bar */}
              <div className="rounded-2xl bg-slate-900 text-white p-4 sm:px-6 flex flex-wrap items-center justify-between gap-3 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                    <ShieldCheck className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-sm font-bold flex items-center gap-2">
                      <span>Admin Console</span>
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold">
                        @{adminUsername}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">
                      Manage SQLite database records, JSON backup sync, and submitted attempts
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleAdminLogout}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 transition cursor-pointer"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Logout</span>
                  </button>
                </div>
              </div>

              {/* 1. SQLite Database Status & Backup Sync Card */}
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-6 shadow-xs space-y-5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                      <Database className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="font-bold text-base sm:text-lg">
                          SQLite Database Storage
                        </h2>
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300">
                          {sqliteInfo.connected ? 'Active' : 'Offline'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Exams: <strong>{sqliteInfo.examsCount}</strong> • Questions:{' '}
                        <strong>{sqliteInfo.questionsCount}</strong> • Submitted Attempts:{' '}
                        <strong>{totalAttemptsCount}</strong>
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => {
                        fetchExamsCatalogFromSqlite();
                        fetchSqliteState();
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition cursor-pointer active:scale-95"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Refresh</span>
                    </button>

                    <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition active:scale-95">
                      <Upload className="w-3.5 h-3.5" />
                      <span>Import Exam JSON</span>
                      <input
                        type="file"
                        accept=".json"
                        onChange={handleCustomFileUpload}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>

                {/* JSON Backup Archive Sync Section */}
                <div className="rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200/80 dark:border-slate-800 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <FolderArchive className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                      <h3 className="text-xs sm:text-sm font-bold">
                        JSON Backup Archive
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {sqliteInfo.backupCount || 6} exam JSON backup files archived and ready for restoration.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={handleRestoreFromBackup}
                    className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 text-white transition cursor-pointer active:scale-95"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Sync SQLite from Backup</span>
                  </button>
                </div>

                {/* Load Recorded History from SQLite Questions into Attempts Table */}
                <div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                    <div>
                      <h3 className="text-xs sm:text-sm font-bold text-slate-800 dark:text-slate-200">
                        Load Original Recorded Attempt History
                      </h3>
                      <p className="text-xs text-slate-500">
                        Load the original recorded answers &amp; flags into the submitted history list for preview.
                      </p>
                    </div>
                    <button
                      onClick={handleLoadAllJsonHistoryToSqlite}
                      className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white transition cursor-pointer active:scale-95"
                    >
                      Load All 6 Original Histories
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                    {allExamsList.map((exam, idx) => (
                      <button
                        key={exam.id}
                        onClick={() => handleLoadJsonHistoryToSqlite(exam.id)}
                        className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-amber-500 bg-slate-50/70 dark:bg-slate-800/40 text-left transition cursor-pointer active:scale-95"
                      >
                        <div className="font-bold text-xs text-slate-800 dark:text-slate-200 truncate">
                          Test #{idx + 1}
                        </div>
                        {exam.originalStats ? (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                              {exam.originalStats.correctCount}✓
                            </span>{' '}
                            /{' '}
                            <span className="text-rose-600 dark:text-rose-400 font-semibold">
                              {exam.originalStats.incorrectCount}✗
                            </span>{' '}
                            • Load
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-400 mt-0.5">Load</div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 2. All Submitted History & Preview Manager */}
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 sm:p-6 shadow-xs space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="font-bold text-base sm:text-lg flex items-center gap-2">
                      <History className="w-5 h-5 text-amber-500" />
                      <span>Submitted Attempts History ({totalAttemptsCount})</span>
                    </h2>
                    <p className="text-xs text-slate-500">
                      Preview any past submission across all practice tests.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setSettingsExamFilter('all')}
                      className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                        settingsExamFilter === 'all'
                          ? 'bg-amber-500 text-white'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      All Tests ({totalAttemptsCount})
                    </button>
                    {allExamsList.map((exam, idx) => {
                      const count = (examHistory[exam.id] || []).length;
                      return (
                        <button
                          key={exam.id}
                          onClick={() => setSettingsExamFilter(exam.id)}
                          className={`px-2.5 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                            settingsExamFilter === exam.id
                              ? 'bg-amber-500 text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          Test #{idx + 1} ({count})
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-4">
                  {allExamsList
                    .filter(
                      (exam) =>
                        settingsExamFilter === 'all' || exam.id === settingsExamFilter
                    )
                    .map((exam) => {
                      const attempts = examHistory[exam.id] || [];
                      return (
                        <div
                          key={exam.id}
                          className="rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden"
                        >
                          <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                            <span className="font-bold text-xs sm:text-sm">
                              {exam.examName || exam.title}
                            </span>
                            <span className="text-xs text-slate-500">
                              {attempts.length}{' '}
                              {attempts.length === 1 ? 'submission' : 'submissions'}
                            </span>
                          </div>

                          {attempts.length === 0 ? (
                            <div className="p-4 text-xs text-slate-400 text-center">
                              No submitted attempts for {exam.examName || exam.title}.
                            </div>
                          ) : (
                            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                              {attempts.map((att, index) => {
                                const attemptNumber = attempts.length - index;
                                return (
                                  <div
                                    key={att.id}
                                    className="p-3.5 sm:px-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/60 dark:hover:bg-slate-800/30 transition"
                                  >
                                    <div className="space-y-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-bold text-xs px-2 py-0.5 rounded-md bg-slate-900 text-white dark:bg-slate-700">
                                          {att.isOriginalJson
                                            ? 'JSON Record'
                                            : `Attempt #${attemptNumber}`}
                                        </span>
                                        <span
                                          className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${
                                            att.passed
                                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                                              : 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
                                          }`}
                                        >
                                          {att.passed ? 'PASS' : 'FAIL'} • {att.pct}% (
                                          {att.scaledScore}/1000)
                                        </span>
                                        <span className="text-[11px] text-slate-400">
                                          {formatDateTime(att.submittedAt)}
                                        </span>
                                      </div>

                                      <div className="text-xs text-slate-600 dark:text-slate-300 flex flex-wrap items-center gap-3">
                                        <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                                          ✓ {att.correct} Correct
                                        </span>
                                        <span className="text-rose-600 dark:text-rose-400 font-semibold">
                                          ✗ {att.incorrect} Wrong
                                        </span>
                                        <span className="text-slate-500">
                                          • {att.unanswered} Skipped
                                        </span>
                                        {att.flaggedCount > 0 && (
                                          <span className="text-amber-600 dark:text-amber-400 font-medium">
                                            ⚑ {att.flaggedCount} Flagged
                                          </span>
                                        )}
                                        {att.durationSeconds != null && (
                                          <span className="text-slate-400 font-mono">
                                            ⏱ {formatTime(att.durationSeconds)}
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                      <button
                                        onClick={() =>
                                          startExam(exam.id, 'review', {
                                            attemptToPreview: att,
                                          })
                                        }
                                        className="flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white shadow-xs transition cursor-pointer active:scale-95"
                                      >
                                        <Eye className="w-3.5 h-3.5" />
                                        <span>Preview</span>
                                      </button>
                                      <button
                                        onClick={(e) =>
                                          deleteHistoryAttempt(exam.id, att.id, e)
                                        }
                                        title="Delete this submission"
                                        className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                                      >
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  // ============================================================================
  // VIEW 2: ACTIVE EXAM / PRACTICE / REVIEW / ATTEMPT PREVIEW INTERFACE
  // ============================================================================
  const qKey = currentQuestion ? String(currentQuestion.questionId) : '';
  const selectedForCurrent = currentQuestion
    ? currentExamProgress.answers[qKey] || []
    : [];
  const isFlaggedCurrent = currentQuestion
    ? !!currentExamProgress.flagged[qKey]
    : false;
  const maxChoicesCurrent = currentQuestion?.correctAnswer?.length || 1;

  const isExplanationVisible =
    !!previewAttempt ||
    mode === 'review' ||
    (mode === 'exam' && examSubmitted) ||
    (mode === 'practice' && !!currentExamProgress.revealed[qKey]);

  const activeExamAttempts = examHistory[activeExamId] || [];

  const shuffleCurrentExam = () => {
    const indices = [...questionOrder];
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    setQuestionOrder(indices);
    goToQuestion(0);
  };

  const handleRetryWrongOnly = () => {
    const wrongSet = new Set();
    orderedQuestions.forEach((q) => {
      const key = String(q.questionId);
      const sel = currentExamProgress.answers[key] || [];
      if (!isAnswerSetCorrect(q.correctAnswer, sel)) {
        wrongSet.add(key);
      }
    });
    if (wrongSet.size === 0) {
      alert('All questions are answered correctly!');
      return;
    }
    setPreviewAttempt(null);
    updateExamProgress((prev) => {
      const nextAnswers = { ...prev.answers };
      const nextRevealed = { ...prev.revealed };
      wrongSet.forEach((k) => {
        delete nextAnswers[k];
        delete nextRevealed[k];
      });
      return { ...prev, answers: nextAnswers, revealed: nextRevealed };
    });
    setOnlyRetryWrongIds(wrongSet);
    setMode('practice');
    setExamSubmitted(false);
    setStatusFilter('all');
    goToQuestion(0);
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col pb-20 lg:pb-8">
      {/* Sticky Top Header */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 sm:py-0 sm:h-16 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <button
                onClick={handleSaveAndExitToHome}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition shrink-0 active:scale-95 cursor-pointer"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden xs:inline">Home</span>
              </button>
              <div className="truncate">
                <h1 className="font-bold text-sm sm:text-base truncate leading-tight">
                  {activeExamData?.examName || 'Practice Exam'}
                </h1>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                  {previewAttempt ? (
                    <span className="text-amber-600 dark:text-amber-400 font-semibold">
                      Previewing Submission • {activeStats.correct}/{activeStats.total} ({activeStats.pct}%)
                    </span>
                  ) : mode === 'exam' && !examSubmitted ? (
                    <span>
                      Answered {activeStats.answered}/{activeStats.total} •{' '}
                      <span className="text-amber-600 dark:text-amber-400 font-medium">
                        {activeStats.flagged} Flagged
                      </span>
                    </span>
                  ) : (
                    <>
                      {activeStats.answered}/{activeStats.total} answered •{' '}
                      <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                        {activeStats.correct}✓ ({activeStats.pct}%)
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Mobile right actions: Timer + Pause/Continue button */}
            <div className="flex sm:hidden items-center gap-1.5 shrink-0">
              {mode === 'exam' && !examSubmitted && !previewAttempt && (
                <button
                  onClick={handlePauseExam}
                  className={`flex items-center gap-1 border px-2.5 py-1 rounded-xl text-xs font-mono font-bold transition active:scale-95 ${
                    timeLeft <= 300
                      ? 'bg-rose-50 dark:bg-rose-950/60 border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 animate-pulse'
                      : 'bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                  }`}
                  title="Tap to pause exam"
                >
                  <Clock className="w-3.5 h-3.5 text-amber-500" />
                  <span>{formatTime(timeLeft)}</span>
                  <Pause className="w-3 h-3 ml-0.5" />
                </button>
              )}
              <button
                onClick={shuffleCurrentExam}
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 active:scale-95"
              >
                <Shuffle className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setDarkMode((d) => !d)}
                className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 active:scale-95"
              >
                {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          {/* Mode Switcher & Submit */}
          <div className="flex items-center justify-between sm:justify-end gap-2">
            <div className="flex-1 sm:flex-initial grid grid-cols-3 bg-slate-100 dark:bg-slate-800 p-1 rounded-xl">
              {[
                { id: 'practice', label: 'Practice', icon: BookOpen },
                { id: 'exam', label: 'Exam', icon: Clock },
                { id: 'review', label: 'Review', icon: Eye },
              ].map((item) => {
                const Icon = item.icon;
                const active = !previewAttempt && mode === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setPreviewAttempt(null);
                      setExamPausedModal(false);
                      autoSubmitTriggeredRef.current = false;
                      if (item.id === 'exam' && mode !== 'exam') {
                        const freshOrder = orderedQuestions.map((q) => q.origIndex);
                        const emptyState = {
                          answers: {},
                          revealed: {},
                          flagged: {},
                          session: {
                            mode: 'exam',
                            timeLeft: EXAM_DURATION_SECONDS,
                            currentIdx: 0,
                            questionOrder: freshOrder,
                            isPaused: true,
                            updatedAt: new Date().toISOString(),
                          },
                        };
                        setAllProgress((prev) => {
                          const nextAll = { ...prev, [activeExamId]: emptyState };
                          saveProgressToStorage(nextAll);
                          return nextAll;
                        });
                        apiSyncProgress(activeExamId, emptyState);
                        setTimeLeft(EXAM_DURATION_SECONDS);
                        setTimerRunning(true);
                        setExamSubmitted(false);
                        setStatusFilter('all');
                        setOnlyRetryWrongIds(null);
                        goToQuestion(0);
                      } else {
                        setExamSubmitted(false);
                        setTimerRunning(false);
                      }
                      setMode(item.id);
                    }}
                    className={`flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                      active
                        ? 'bg-white dark:bg-slate-900 text-amber-600 dark:text-amber-400 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>

            {!previewAttempt && mode === 'exam' && !examSubmitted && (
              <button
                onClick={() => saveSubmissionToHistory('exam')}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs transition shrink-0 cursor-pointer active:scale-95"
              >
                Submit Exam
              </button>
            )}

            {!previewAttempt && mode === 'practice' && activeStats.answered > 0 && (
              <button
                onClick={() => saveSubmissionToHistory('practice')}
                title="Save current answers as a submitted attempt"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs transition shrink-0 cursor-pointer active:scale-95"
              >
                <Save className="w-3.5 h-3.5" />
                <span className="hidden xs:inline">Submit</span>
              </button>
            )}

            {/* Desktop Timer + Pause Button & Utility Icons */}
            <div className="hidden sm:flex items-center gap-2">
              {mode === 'exam' && !examSubmitted && !previewAttempt && (
                <div
                  className={`flex items-center gap-2 border px-3 py-1.5 rounded-xl text-xs font-mono font-bold ${
                    timeLeft <= 300
                      ? 'bg-rose-50 dark:bg-rose-950/60 border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 animate-pulse'
                      : 'bg-amber-50 dark:bg-amber-950/60 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5 text-amber-500" />
                  <span>{formatTime(timeLeft)}</span>
                  <button
                    onClick={handlePauseExam}
                    className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-900 dark:text-amber-200 font-sans font-semibold text-[11px] cursor-pointer transition"
                    title="Pause Exam"
                  >
                    <Pause className="w-3 h-3" />
                    <span>Pause</span>
                  </button>
                </div>
              )}

              <button
                onClick={shuffleCurrentExam}
                title="Shuffle Question Order"
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition cursor-pointer"
              >
                <Shuffle className="w-4 h-4" />
              </button>

              <button
                onClick={() => setDarkMode((d) => !d)}
                className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 transition cursor-pointer"
                title="Toggle Dark Mode"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        <div className="w-full h-1 bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-amber-500 transition-all duration-300"
            style={{
              width: `${
                filteredQuestions.length > 0
                  ? Math.round(((currentIdx + 1) / filteredQuestions.length) * 100)
                  : 0
              }%`,
            }}
          />
        </div>
      </header>

      {/* Attempt Preview / Exam Results Summary Banner */}
      {(previewAttempt || examSubmitted) && (
        <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div className="max-w-7xl mx-auto px-3.5 sm:px-6 py-3 sm:py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5 sm:gap-4">
              {previewAttempt && (
                <span className="px-2.5 py-1 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300 font-bold text-xs flex items-center gap-1.5">
                  <Eye className="w-3.5 h-3.5" />
                  {previewAttempt.isOriginalJson
                    ? 'Preview: Original JSON Attempt'
                    : `Submitted Result (${formatDateTime(previewAttempt.submittedAt)})`}
                </span>
              )}
              <div
                className={`px-3 py-1 rounded-xl font-bold text-xs sm:text-sm flex items-center gap-1.5 ${
                  activeStats.passed
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                    : 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
                }`}
              >
                <Award className="w-4 h-4" />
                <span>{activeStats.passed ? 'PASSED' : 'FAILED'}</span>
                <span className="font-mono">({activeStats.scaledScore}/1000)</span>
              </div>
              <div className="text-xs sm:text-sm flex items-center gap-3">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  ✓ {activeStats.correct} ({activeStats.pct}%)
                </span>
                <span className="font-semibold text-rose-600 dark:text-rose-400">
                  ✗ {activeStats.incorrect}
                </span>
                <span className="text-slate-500">• {activeStats.unanswered} Skipped</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {adminToken && (
                <button
                  onClick={() => setHistoryModalExamId(activeExamId)}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition cursor-pointer flex items-center gap-1"
                >
                  <History className="w-3.5 h-3.5" />
                  <span>Switch Attempt ({activeExamAttempts.length})</span>
                </button>
              )}

              {activeStats.incorrect + activeStats.unanswered > 0 && (
                <button
                  onClick={handleRetryWrongOnly}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white transition cursor-pointer"
                >
                  Retry Wrong ({activeStats.incorrect + activeStats.unanswered})
                </button>
              )}

              {previewAttempt && (
                <button
                  onClick={() => startExam(activeExamId, 'exam')}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 dark:bg-slate-700 text-white transition cursor-pointer"
                >
                  New Exam Attempt
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="max-w-7xl w-full mx-auto px-3 sm:px-6 py-3.5 sm:py-6 flex-1 grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-8 space-y-4">
          {!currentQuestion ? (
            <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 sm:p-12 text-center">
              <HelpCircle className="w-10 h-10 text-slate-400 mx-auto mb-3" />
              <h3 className="text-base font-bold">No questions match your filter</h3>
              <p className="text-xs text-slate-500 mt-1 mb-4">
                Clear your search query or switch the filter back to &quot;All&quot;.
              </p>
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setSearchQuery('');
                  setOnlyRetryWrongIds(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white"
              >
                Reset Filters
              </button>
            </div>
          ) : (
            <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs overflow-hidden">
              <div className="px-4 sm:px-6 py-3 sm:py-4 bg-slate-50/80 dark:bg-slate-800/40 border-b border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5">
                  <span className="px-2.5 py-1 rounded-lg bg-slate-900 dark:bg-amber-500 text-white dark:text-slate-950 font-bold text-xs">
                    Q{currentQuestion.displayNumber}/{orderedQuestions.length}
                  </span>
                  <span className="text-[11px] sm:text-xs text-slate-400 font-mono">
                    #{currentQuestion.questionId}
                  </span>
                  {maxChoicesCurrent > 1 ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] sm:text-xs font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300">
                      <CheckSquare className="w-3 h-3" />
                      Choose {maxChoicesCurrent}
                    </span>
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                      Single Choice
                    </span>
                  )}
                  {previewAttempt && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                        selectedForCurrent.length === 0
                          ? 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'
                          : isAnswerSetCorrect(
                              currentQuestion.correctAnswer,
                              selectedForCurrent
                            )
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                          : 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
                      }`}
                    >
                      {selectedForCurrent.length === 0
                        ? 'Skipped'
                        : isAnswerSetCorrect(
                            currentQuestion.correctAnswer,
                            selectedForCurrent
                          )
                        ? 'Correct'
                        : 'Wrong'}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!previewAttempt && mode === 'practice' && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={instantCheck}
                        onChange={(e) => setInstantCheck(e.target.checked)}
                        className="rounded border-slate-300 text-amber-500 focus:ring-amber-500"
                      />
                      <span>Auto-check</span>
                    </label>
                  )}

                  <button
                    onClick={toggleFlagCurrent}
                    disabled={!!previewAttempt}
                    className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                      previewAttempt ? 'cursor-default' : 'cursor-pointer'
                    } ${
                      isFlaggedCurrent
                        ? 'bg-amber-50 dark:bg-amber-500/20 border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-300'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100'
                    }`}
                  >
                    <Flag
                      className={`w-3.5 h-3.5 ${
                        isFlaggedCurrent ? 'fill-amber-500 text-amber-500' : ''
                      }`}
                    />
                    <span>{isFlaggedCurrent ? 'Flagged' : 'Flag'}</span>
                  </button>
                </div>
              </div>

              {/* Question Body */}
              <div className="p-4 sm:p-6">
                <div
                  className="exam-html text-[15px] sm:text-base text-slate-800 dark:text-slate-100 mb-5"
                  dangerouslySetInnerHTML={{ __html: currentQuestion.questionText }}
                />

                {/* Answer Options */}
                <div className="space-y-2.5 sm:space-y-3">
                  {currentQuestion.answers?.map((ansHtml, idx) => {
                    const letter = String.fromCharCode(65 + idx);
                    const isSelected = selectedForCurrent.includes(ansHtml);
                    const isCorrectOption = currentQuestion.correctAnswer?.includes(ansHtml);

                    let borderStyle =
                      'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 bg-white dark:bg-slate-900';
                    let badgeStyle =
                      'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';

                    if (isExplanationVisible) {
                      if (isCorrectOption) {
                        borderStyle =
                          'border-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/30 dark:border-emerald-500/70';
                        badgeStyle = 'bg-emerald-600 text-white';
                      } else if (isSelected && !isCorrectOption) {
                        borderStyle =
                          'border-rose-500 bg-rose-50/70 dark:bg-rose-950/30 dark:border-rose-500/70';
                        badgeStyle = 'bg-rose-600 text-white';
                      }
                    } else if (isSelected) {
                      borderStyle =
                        'border-amber-500 bg-amber-50/60 dark:bg-amber-500/10 dark:border-amber-500';
                      badgeStyle = 'bg-amber-500 text-white';
                    }

                    return (
                      <div
                        key={idx}
                        onClick={() => handleSelectOption(currentQuestion, ansHtml)}
                        className={`group rounded-xl border-2 p-3.5 sm:p-4 transition-all flex items-start gap-3 ${
                          previewAttempt || mode === 'review'
                            ? 'cursor-default'
                            : 'cursor-pointer active:scale-[0.99]'
                        } ${borderStyle}`}
                      >
                        <div
                          className={`w-7 h-7 rounded-lg font-bold text-xs flex items-center justify-center shrink-0 mt-0.5 transition-colors ${badgeStyle}`}
                        >
                          {letter}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div
                            className="answer-html text-[14.5px] sm:text-base text-slate-800 dark:text-slate-200"
                            dangerouslySetInnerHTML={{ __html: ansHtml }}
                          />
                          {isExplanationVisible && isSelected && (
                            <span
                              className={`inline-block mt-1.5 text-[11px] font-semibold px-2 py-0.5 rounded-md ${
                                isCorrectOption
                                  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300'
                                  : 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
                              }`}
                            >
                              Your Choice
                            </span>
                          )}
                        </div>

                        {isExplanationVisible && (
                          <div className="shrink-0 mt-0.5">
                            {isCorrectOption ? (
                              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                            ) : isSelected ? (
                              <XCircle className="w-5 h-5 text-rose-600 dark:text-rose-400" />
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Desktop Navigation & Check Bar */}
                <div className="hidden lg:flex mt-6 pt-5 border-t border-slate-200 dark:border-slate-800 items-center justify-between gap-3">
                  <button
                    onClick={() => goToQuestion(Math.max(0, currentIdx - 1))}
                    disabled={currentIdx === 0}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-40 transition cursor-pointer disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    Previous
                  </button>

                  {!previewAttempt && mode === 'practice' && (
                    <button
                      onClick={toggleRevealCurrent}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white shadow-xs transition cursor-pointer"
                    >
                      <Eye className="w-4 h-4" />
                      {isExplanationVisible ? 'Hide Explanation' : 'Check Answer'}
                    </button>
                  )}

                  {!previewAttempt && mode === 'exam' && !examSubmitted && (
                    <button
                      onClick={handlePauseExam}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 transition cursor-pointer"
                    >
                      <Pause className="w-4 h-4" />
                      Pause Exam
                    </button>
                  )}

                  <button
                    onClick={() =>
                      goToQuestion(Math.min(filteredQuestions.length - 1, currentIdx + 1))
                    }
                    disabled={currentIdx >= filteredQuestions.length - 1}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white disabled:opacity-40 transition cursor-pointer disabled:cursor-not-allowed"
                  >
                    Next
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Explanation Panel */}
              {isExplanationVisible && currentQuestion.explanation && (
                <div className="border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/80 p-3.5 sm:p-6">
                  <div className="flex items-center justify-between mb-2.5 sm:mb-3">
                    <h4 className="text-xs sm:text-sm font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <BookOpen className="w-4 h-4" />
                      Detailed Explanation
                    </h4>
                    <span className="text-[11px] text-slate-400 flex items-center gap-1">
                      <Maximize2 className="w-3 h-3" /> Tap diagram to zoom
                    </span>
                  </div>
                  <div
                    onClick={handleExplanationClick}
                    className="exam-html text-[14.5px] sm:text-base text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-900 p-3.5 sm:p-5 rounded-xl border border-slate-200/80 dark:border-slate-800"
                    dangerouslySetInnerHTML={{ __html: currentQuestion.explanation }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Desktop Right Sidebar */}
        <div className="hidden lg:block lg:col-span-4 space-y-4 lg:sticky lg:top-20">
          <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 shadow-xs">
            {renderNavigatorContent()}
            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 text-[11px] text-slate-400 flex flex-wrap justify-between gap-2">
              <span>←/→: Prev/Next</span>
              <span>1-6: Select</span>
              <span>Space: Check</span>
              <span>F: Flag</span>
            </div>
          </div>
        </div>
      </div>

      {/* MOBILE STICKY THUMB-ZONE BOTTOM NAVIGATION BAR */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 px-3 pt-2 safe-bottom shadow-lg">
        <div className="max-w-lg mx-auto grid grid-cols-5 gap-1.5 items-center">
          <button
            onClick={() => goToQuestion(Math.max(0, currentIdx - 1))}
            disabled={currentIdx === 0}
            className="flex flex-col items-center justify-center py-1.5 rounded-xl text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 disabled:opacity-35 active:scale-95 transition"
          >
            <ChevronLeft className="w-5 h-5" />
            <span className="text-[10px] font-semibold mt-0.5">Prev</span>
          </button>

          <button
            onClick={toggleFlagCurrent}
            disabled={!!previewAttempt}
            className={`flex flex-col items-center justify-center py-1.5 rounded-xl active:scale-95 transition ${
              isFlaggedCurrent
                ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-600 dark:text-amber-400'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
            }`}
          >
            <Flag
              className={`w-4 h-4 my-0.5 ${
                isFlaggedCurrent ? 'fill-amber-500 text-amber-500' : ''
              }`}
            />
            <span className="text-[10px] font-semibold mt-0.5">
              {isFlaggedCurrent ? 'Flagged' : 'Flag'}
            </span>
          </button>

          {!previewAttempt && mode === 'practice' ? (
            <button
              onClick={toggleRevealCurrent}
              className={`flex flex-col items-center justify-center py-1.5 rounded-xl text-white shadow-xs active:scale-95 transition ${
                isExplanationVisible ? 'bg-slate-700 dark:bg-slate-700' : 'bg-indigo-600'
              }`}
            >
              <Eye className="w-4 h-4 my-0.5" />
              <span className="text-[10px] font-semibold mt-0.5">
                {isExplanationVisible ? 'Hide' : 'Answer'}
              </span>
            </button>
          ) : !previewAttempt && mode === 'exam' && !examSubmitted ? (
            <button
              onClick={handlePauseExam}
              className="flex flex-col items-center justify-center py-1.5 rounded-xl bg-amber-500/15 text-amber-700 dark:text-amber-300 active:scale-95 transition"
            >
              <Pause className="w-4 h-4 my-0.5" />
              <span className="text-[10px] font-semibold mt-0.5">Pause</span>
            </button>
          ) : (
            <div className="flex flex-col items-center justify-center py-1.5 text-center">
              <span className="text-xs font-bold text-amber-600 dark:text-amber-400">
                {previewAttempt
                  ? `${activeStats.pct}%`
                  : `${activeStats.answered}/${activeStats.total}`}
              </span>
              <span className="text-[10px] text-slate-400">
                {previewAttempt ? 'Score' : 'Done'}
              </span>
            </div>
          )}

          <button
            onClick={() => setMobileDrawerOpen(true)}
            className="relative flex flex-col items-center justify-center py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 active:scale-95 transition"
          >
            <LayoutGrid className="w-4 h-4 my-0.5" />
            <span className="text-[10px] font-semibold mt-0.5">
              {currentIdx + 1}/{filteredQuestions.length}
            </span>
            {(statusFilter !== 'all' || searchQuery) && (
              <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-amber-500" />
            )}
          </button>

          <button
            onClick={() =>
              goToQuestion(Math.min(filteredQuestions.length - 1, currentIdx + 1))
            }
            disabled={currentIdx >= filteredQuestions.length - 1}
            className="flex flex-col items-center justify-center py-1.5 rounded-xl bg-amber-500 text-white disabled:opacity-35 active:scale-95 transition shadow-xs"
          >
            <ChevronRight className="w-5 h-5" />
            <span className="text-[10px] font-semibold mt-0.5">Next</span>
          </button>
        </div>
      </div>

      {/* ============================================================================ */}
      {/* EXAM PAUSED MODAL OVERLAY (Continue Exam or Save & Exit to Home)             */}
      {/* ============================================================================ */}
      {examPausedModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 p-6 sm:p-8 shadow-2xl text-center">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-500 mx-auto mb-4">
              <Pause className="w-7 h-7" />
            </div>
            <h3 className="text-xl font-bold">Exam Paused</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 mb-5">
              Your timer is paused and your progress is saved in SQLite. You can continue right now or exit to the home page and resume later.
            </p>

            <div className="grid grid-cols-3 gap-2.5 mb-6 bg-slate-50 dark:bg-slate-800/60 p-3.5 rounded-xl border border-slate-200/70 dark:border-slate-800">
              <div>
                <div className="text-sm sm:text-base font-mono font-bold text-amber-600 dark:text-amber-400">
                  {formatTime(timeLeft)}
                </div>
                <div className="text-[11px] text-slate-500">Time Left</div>
              </div>
              <div>
                <div className="text-sm sm:text-base font-bold text-slate-800 dark:text-slate-200">
                  Q{currentIdx + 1}/{orderedQuestions.length}
                </div>
                <div className="text-[11px] text-slate-500">Current</div>
              </div>
              <div>
                <div className="text-sm sm:text-base font-bold text-emerald-600 dark:text-emerald-400">
                  {activeStats.answered}/{activeStats.total}
                </div>
                <div className="text-[11px] text-slate-500">Answered</div>
              </div>
            </div>

            <div className="space-y-2.5">
              <button
                onClick={handleContinueExamFromModal}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl font-bold text-sm bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition cursor-pointer active:scale-98"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Continue Exam</span>
              </button>

              <button
                onClick={handleSaveAndExitToHome}
                className="w-full py-2.5 px-4 rounded-xl font-semibold text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition cursor-pointer"
              >
                Save &amp; Exit to Home Page
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MOBILE SLIDE-UP QUESTION NAVIGATOR & FILTER SHEET */}
      {mobileDrawerOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-xs">
          <div className="flex-1" onClick={() => setMobileDrawerOpen(false)} />
          <div className="bg-white dark:bg-slate-900 rounded-t-3xl border-t border-slate-200 dark:border-slate-800 p-4 safe-bottom max-h-[82vh] flex flex-col shadow-2xl">
            <div className="w-10 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700 mx-auto mb-3" />
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="font-bold text-sm">Question Navigator &amp; Filters</h3>
                <p className="text-xs text-slate-500">
                  Answered {activeStats.answered}/{activeStats.total}
                </p>
              </div>
              <button
                onClick={() => setMobileDrawerOpen(false)}
                className="p-2 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="overflow-y-auto pr-0.5 pb-2">
              {renderNavigatorContent()}
            </div>
          </div>
        </div>
      )}

      {renderHistoryModal()}

      {lightboxSrc && (
        <div
          onClick={() => setLightboxSrc(null)}
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-2 sm:p-4"
        >
          <div className="relative max-w-5xl w-full max-h-[90vh] flex flex-col items-center">
            <button
              onClick={() => setLightboxSrc(null)}
              className="self-end mb-2 text-white bg-white/10 hover:bg-white/20 rounded-full p-2"
            >
              <X className="w-5 h-5" />
            </button>
            <img
              src={lightboxSrc}
              alt="Diagram Zoom"
              className="max-w-full max-h-[82vh] object-contain rounded-xl bg-white p-1.5 shadow-2xl"
            />
          </div>
        </div>
      )}
    </div>
  );
}
