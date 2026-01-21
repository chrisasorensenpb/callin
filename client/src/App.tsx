import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';

interface Session {
  sessionId: string;
  pairCode: string;
  expiresAt: string;
  phoneNumber: string;
}

interface DemoState {
  phase: 'waiting' | 'paired' | 'questions' | 'callback_preparing' | 'dialing' | 'connected' | 'completed';
  callerName: string | null;
  callerPhone: string | null;
  vertical: string | null;
  verticalDisplay: string | null;
  pain: string | null;
  painDisplay: string | null;
  showSpamImage: boolean;
  showCalendar: boolean;
  appointment: { date: string; time: string } | null;
}

interface EventLog {
  type: string;
  time: string;
  data?: unknown;
}

function formatPhoneDisplay(phone: string): string {
  if (!phone) return '';
  // Already masked format like (***) ***-1234
  if (phone.includes('*')) return phone;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  if (cleaned.length === 11 && cleaned[0] === '1') {
    return `(${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7)}`;
  }
  return phone;
}

function formatVertical(vertical: string, displayName?: string | null): string {
  if (displayName) return displayName;
  const labels: Record<string, string> = {
    real_estate: 'Real Estate',
    insurance: 'Insurance',
    mortgage: 'Mortgage',
    other: 'Other',
  };
  return labels[vertical] || vertical.replace(/_/g, ' ');
}

function formatPain(pain: string, displayName?: string | null): string {
  if (displayName) return displayName;
  const labels: Record<string, string> = {
    spam_flags: 'Spam Flags',
    awkward_delay: 'Awkward Delay',
    low_answer_rates: 'Low Answer Rates',
    speed: 'Speed / Efficiency',
  };
  return labels[pain] || pain.replace(/_/g, ' ');
}

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [demoState, setDemoState] = useState<DemoState>({
    phase: 'waiting',
    callerName: null,
    callerPhone: null,
    vertical: null,
    verticalDisplay: null,
    pain: null,
    painDisplay: null,
    showSpamImage: false,
    showCalendar: false,
    appointment: null,
  });
  const [events, setEvents] = useState<EventLog[]>([]);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [dialerAnimation, setDialerAnimation] = useState<'idle' | 'dialing' | 'ringing' | 'connected'>('idle');
  const socketRef = useRef<Socket | null>(null);

  const addEvent = useCallback((type: string, data?: unknown) => {
    const time = new Date().toLocaleTimeString();
    setEvents(prev => [{ type, time, data }, ...prev].slice(0, 30));
  }, []);

  const createSession = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/session', {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error('Failed to create session');
      }

      const data: Session = await response.json();
      setSession(data);

      const expiresAt = new Date(data.expiresAt).getTime();
      const now = Date.now();
      setTimeLeft(Math.max(0, Math.floor((expiresAt - now) / 1000)));

      addEvent('session_created', { code: data.pairCode });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [addEvent]);

  useEffect(() => {
    createSession();
  }, [createSession]);

  useEffect(() => {
    if (!session?.sessionId) return;

    const socket = io({ transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('subscribe', session.sessionId);
      addEvent('websocket_connected');
    });

    socket.on('paired', (data: { callerName: string }) => {
      setDemoState(prev => ({
        ...prev,
        phase: 'paired',
        callerName: data.callerName,
      }));
      addEvent('paired', data);
    });

    socket.on('vertical_selected', (data: { vertical: string; displayName?: string }) => {
      setDemoState(prev => ({
        ...prev,
        phase: 'questions',
        vertical: data.vertical,
        verticalDisplay: data.displayName || data.vertical,
      }));
      addEvent('vertical_selected', data);
    });

    socket.on('pain_selected', (data: { pain: string; displayName?: string; isSpam?: boolean }) => {
      setDemoState(prev => ({
        ...prev,
        pain: data.pain,
        painDisplay: data.displayName || data.pain,
        showSpamImage: data.isSpam || false,
      }));
      addEvent('pain_selected', data);
    });

    socket.on('callback_preparing', (data: { phoneNumber: string }) => {
      setDemoState(prev => ({
        ...prev,
        phase: 'callback_preparing',
        callerPhone: data.phoneNumber,
      }));
      setDialerAnimation('idle');
      addEvent('callback_preparing', data);
    });

    socket.on('callback_dialing', (data: { phoneNumber: string; callerName: string }) => {
      setDemoState(prev => ({
        ...prev,
        phase: 'dialing',
        callerPhone: data.phoneNumber,
      }));
      setDialerAnimation('dialing');
      addEvent('callback_dialing', data);
    });

    socket.on('callback_ringing', () => {
      setDialerAnimation('ringing');
      addEvent('callback_ringing');
    });

    socket.on('callback_answered', (data: { callerName: string }) => {
      setDemoState(prev => ({
        ...prev,
        phase: 'connected',
      }));
      setDialerAnimation('connected');
      addEvent('callback_answered', data);
    });

    socket.on('callback_failed', (data: { status?: string; error?: string }) => {
      setDialerAnimation('idle');
      addEvent('callback_failed', data);
    });

    socket.on('schedule_requested', () => {
      setDemoState(prev => ({
        ...prev,
        showCalendar: true,
      }));
      addEvent('schedule_requested');
    });

    socket.on('appointment_scheduled', (data: { date: string; time: string }) => {
      setDemoState(prev => ({
        ...prev,
        appointment: { date: data.date, time: data.time },
      }));
      addEvent('appointment_scheduled', data);
    });

    socket.on('schedule_declined', () => {
      addEvent('schedule_declined');
    });

    socket.on('demo_completed', () => {
      setDemoState(prev => ({
        ...prev,
        phase: 'completed',
      }));
      addEvent('demo_completed');
    });

    socket.on('disconnect', () => {
      addEvent('websocket_disconnected');
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session?.sessionId, addEvent]);

  useEffect(() => {
    if (timeLeft <= 0 || demoState.phase !== 'waiting') return;

    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [timeLeft, demoState.phase]);

  const formatTimeLeft = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return (
      <div className="app">
        <div className="loading-screen">
          <div className="spinner" />
          <p>Initializing demo...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app">
        <div className="error-screen">
          <h2>Error</h2>
          <p>{error}</p>
          <button onClick={createSession}>Try Again</button>
        </div>
      </div>
    );
  }

  const showDialer = ['callback_preparing', 'dialing', 'connected', 'completed'].includes(demoState.phase);

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-icon">📞</span>
          <span className="logo-text">PhoneBurner</span>
        </div>
        <div className="header-status">
          {demoState.phase === 'waiting' && <span className="status-badge waiting">Waiting for Call</span>}
          {demoState.phase === 'paired' && <span className="status-badge paired">Connected</span>}
          {demoState.phase === 'questions' && <span className="status-badge active">In Progress</span>}
          {demoState.phase === 'dialing' && <span className="status-badge dialing">Dialing...</span>}
          {demoState.phase === 'connected' && <span className="status-badge connected">On Call</span>}
          {demoState.phase === 'completed' && <span className="status-badge completed">Demo Complete</span>}
        </div>
      </header>

      <main className="main-content">
        {/* Initial Pairing Screen */}
        {demoState.phase === 'waiting' && (
          <div className="pairing-screen">
            <div className="pairing-card">
              <h1>Power Dialer Demo</h1>
              <p className="subtitle">Experience instant callbacks and real-time CRM updates</p>

              <div className="code-display">
                <span className="code-label">Your Demo Code</span>
                <span className="code-value">{session?.pairCode}</span>
              </div>

              <div className="call-instructions">
                <div className="phone-number">
                  <span className="phone-icon">📱</span>
                  <span className="phone-value">{formatPhoneDisplay(session?.phoneNumber || '')}</span>
                </div>
                <p>Call this number and speak the code above</p>
              </div>

              <div className="status-indicator">
                <div className="pulse-dot" />
                <span>Waiting for your call...</span>
              </div>

              {timeLeft > 0 && (
                <p className="timer">Session expires in {formatTimeLeft(timeLeft)}</p>
              )}
            </div>

            <div className="steps-card">
              <h3>How it works</h3>
              <ol>
                <li>
                  <span className="step-num">1</span>
                  <span>Call the number above</span>
                </li>
                <li>
                  <span className="step-num">2</span>
                  <span>Say your name when prompted</span>
                </li>
                <li>
                  <span className="step-num">3</span>
                  <span>Speak the 4-digit code</span>
                </li>
                <li>
                  <span className="step-num">4</span>
                  <span>Watch the magic happen!</span>
                </li>
              </ol>
            </div>
          </div>
        )}

        {/* Paired / Questions Phase */}
        {(demoState.phase === 'paired' || demoState.phase === 'questions') && !showDialer && (
          <div className="demo-progress-screen">
            <div className="welcome-banner">
              <h1>Welcome, {demoState.callerName}!</h1>
              <p>Answer the questions on the phone and watch this page update in real-time</p>
            </div>

            <div className="progress-cards">
              <div className={`progress-card ${demoState.vertical ? 'completed' : 'active'}`}>
                <div className="card-icon">{demoState.vertical ? '✓' : '1'}</div>
                <div className="card-content">
                  <h3>Industry</h3>
                  <p>{demoState.vertical ? formatVertical(demoState.vertical, demoState.verticalDisplay) : 'Listening...'}</p>
                </div>
              </div>

              <div className={`progress-card ${demoState.pain ? 'completed' : demoState.vertical ? 'active' : 'pending'}`}>
                <div className="card-icon">{demoState.pain ? '✓' : '2'}</div>
                <div className="card-content">
                  <h3>Pain Point</h3>
                  <p>{demoState.pain ? formatPain(demoState.pain, demoState.painDisplay) : 'Waiting...'}</p>
                </div>
              </div>

              <div className="progress-card pending">
                <div className="card-icon">3</div>
                <div className="card-content">
                  <h3>Callback Demo</h3>
                  <p>Coming up next...</p>
                </div>
              </div>
            </div>

            {/* Spam Image - Shows when user mentions spam as their pain point */}
            {demoState.showSpamImage && (
              <div className="spam-image-container">
                <div className="spam-phone-mockup">
                  <div className="phone-screen">
                    <div className="incoming-call">
                      <div className="spam-warning">⚠️ SPAM LIKELY</div>
                      <div className="caller-id">Unknown Caller</div>
                      <div className="phone-number">(555) 123-4567</div>
                      <div className="call-actions">
                        <div className="decline-btn">Decline</div>
                        <div className="accept-btn">Accept</div>
                      </div>
                    </div>
                  </div>
                </div>
                <p className="spam-caption">Look familiar? We can fix this.</p>
              </div>
            )}
          </div>
        )}

        {/* Dialer Screen */}
        {showDialer && (
          <div className="dialer-screen">
            <div className="dialer-panel">
              <div className="dialer-header">
                <h2>Power Dialer</h2>
                <div className={`dialer-status ${dialerAnimation}`}>
                  {dialerAnimation === 'idle' && 'Ready'}
                  {dialerAnimation === 'dialing' && 'Dialing...'}
                  {dialerAnimation === 'ringing' && 'Ringing...'}
                  {dialerAnimation === 'connected' && 'Connected'}
                </div>
              </div>

              <div className="dialer-display">
                <div className={`dial-animation ${dialerAnimation}`}>
                  {dialerAnimation === 'dialing' && (
                    <div className="dialing-waves">
                      <span></span><span></span><span></span>
                    </div>
                  )}
                  {dialerAnimation === 'ringing' && (
                    <div className="ringing-icon">📞</div>
                  )}
                  {dialerAnimation === 'connected' && (
                    <div className="connected-icon">✓</div>
                  )}
                </div>
                <div className="dial-number">{demoState.callerPhone || '(***) ***-****'}</div>
                <div className="dial-name">{demoState.callerName}</div>
              </div>

              <div className="dialer-keypad">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(key => (
                  <button key={key} className="keypad-btn" disabled>{key}</button>
                ))}
              </div>

              <div className="dialer-actions">
                <button className={`action-btn ${dialerAnimation === 'connected' ? 'end-call' : ''}`} disabled>
                  {dialerAnimation === 'connected' ? '🔴 End Call' : '📞 Dial'}
                </button>
              </div>
            </div>

            <div className="crm-panel">
              <div className="crm-header">
                <h2>Contact Record</h2>
                <span className="crm-badge">CRM</span>
              </div>

              <div className="crm-content">
                <div className="contact-avatar">
                  {demoState.callerName?.charAt(0).toUpperCase() || '?'}
                </div>

                <div className="contact-info">
                  <div className="info-row">
                    <label>Name</label>
                    <span>{demoState.callerName || '—'}</span>
                  </div>
                  <div className="info-row">
                    <label>Phone</label>
                    <span>{demoState.callerPhone || '—'}</span>
                  </div>
                  <div className="info-row">
                    <label>Industry</label>
                    <span>{demoState.vertical ? formatVertical(demoState.vertical, demoState.verticalDisplay) : '—'}</span>
                  </div>
                  <div className="info-row">
                    <label>Pain Point</label>
                    <span>{demoState.pain ? formatPain(demoState.pain, demoState.painDisplay) : '—'}</span>
                  </div>
                  <div className="info-row">
                    <label>Status</label>
                    <span className="status-tag">{demoState.phase === 'completed' ? 'Demo Completed' : 'In Progress'}</span>
                  </div>
                </div>

                <div className="notes-section">
                  <label>Call Notes</label>
                  <textarea placeholder="Add notes during the call..." disabled />
                </div>

                <div className="action-buttons">
                  <button className="crm-btn" disabled>📧 Send Email</button>
                  <button className="crm-btn" disabled>📅 Schedule</button>
                  <button className="crm-btn" disabled>🏷️ Add Tag</button>
                </div>
              </div>
            </div>

            {/* Calendar Panel */}
            {(demoState.showCalendar || demoState.appointment) && (
              <div className="calendar-panel">
                <div className="calendar-header">
                  <h2>📅 Schedule Follow-up</h2>
                </div>
                <div className="calendar-content">
                  {demoState.appointment ? (
                    <div className="appointment-confirmed">
                      <div className="confirm-icon">✓</div>
                      <h3>Appointment Scheduled!</h3>
                      <p className="appointment-date">{demoState.appointment.date}</p>
                      <p className="appointment-time">{demoState.appointment.time}</p>
                    </div>
                  ) : (
                    <div className="calendar-placeholder">
                      <div className="mini-calendar">
                        <div className="cal-header">January 2026</div>
                        <div className="cal-days">
                          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                            <span key={i} className="day-header">{d}</span>
                          ))}
                          {Array.from({ length: 31 }, (_, i) => (
                            <span key={i} className={`day ${i + 1 === 21 ? 'today' : ''} ${i + 1 === 22 ? 'selected' : ''}`}>
                              {i + 1}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p>Waiting for voice selection...</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Completion Screen */}
        {demoState.phase === 'completed' && (
          <div className="completion-overlay">
            <div className="completion-content">
              <div className="completion-icon">🎉</div>
              <h2>Demo Complete!</h2>
              <p>You've experienced the PhoneBurner power dialer with:</p>
              <ul>
                <li>✓ Instant callback with no awkward delay</li>
                <li>✓ Real-time CRM updates during calls</li>
                <li>✓ Voice-activated appointment scheduling</li>
              </ul>
              <button onClick={() => window.location.reload()}>Start New Demo</button>
            </div>
          </div>
        )}
      </main>

      {/* Event Log */}
      <aside className="event-log">
        <h3>Live Events</h3>
        <div className="events-list">
          {events.map((event, i) => (
            <div key={i} className="event-item">
              <span className="event-time">{event.time}</span>
              <span className="event-type">{event.type}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

export default App;
