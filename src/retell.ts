import { Router, Request, Response } from 'express';
import { config } from './config.js';
import {
  findSessionByCode,
  pairSession,
  createEvent,
  checkRateLimit,
  recordFailedAttempt,
  clearRateLimit,
  extendSession,
  getSession,
  updateSessionPhone,
} from './session.js';
import { emitToSession } from './websocket.js';
import { createOutboundCall } from './retell-client.js';

const router = Router();

// Store call state (in production, use Redis)
const callState = new Map<string, {
  name?: string;
  sessionId?: string;
  callerNumber?: string;
  codeAttempts: number;
}>();

// ============================================================================
// Retell Webhook - Call Lifecycle Events
// ============================================================================

interface RetellWebhookEvent {
  event: string;
  call: {
    call_id: string;
    call_status: string;
    agent_id: string;
    from_number?: string;
    to_number?: string;
    metadata?: Record<string, string>;
    start_timestamp?: number;
    end_timestamp?: number;
    transcript?: string;
    recording_url?: string;
  };
}

router.post('/webhook', async (req: Request, res: Response) => {
  const event = req.body as RetellWebhookEvent;

  console.log('Retell webhook event:', event.event, {
    callId: event.call?.call_id,
    status: event.call?.call_status,
  });

  try {
    switch (event.event) {
      case 'call_started':
        // Initialize call state
        callState.set(event.call.call_id, {
          callerNumber: event.call.from_number,
          codeAttempts: 0,
        });
        break;

      case 'call_ended': {
        // Clean up and emit completion if needed
        const state = callState.get(event.call.call_id);
        if (state?.sessionId) {
          await createEvent(state.sessionId, 'call_ended', {
            callId: event.call.call_id,
            duration: event.call.end_timestamp && event.call.start_timestamp
              ? Math.round((event.call.end_timestamp - event.call.start_timestamp) / 1000)
              : undefined,
            timestamp: new Date().toISOString(),
          });
        }
        callState.delete(event.call.call_id);
        break;
      }

      case 'call_analyzed':
        // Call recording/transcript available - could store for analysis
        console.log('Call analyzed:', event.call.call_id);
        break;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================================
// Retell Custom Function Handler
// ============================================================================

interface CustomFunctionRequest {
  call: {
    call_id: string;
    from_number?: string;
    to_number?: string;
    metadata?: Record<string, string>;
  };
  name: string;
  args: Record<string, unknown>;
}

interface CustomFunctionResponse {
  result?: string;
  information?: Record<string, unknown>;
}

router.post('/custom-function', async (req: Request, res: Response) => {
  const request = req.body as CustomFunctionRequest;
  const { call, name, args } = request;

  console.log('Custom function called:', name, {
    callId: call.call_id,
    args,
  });

  try {
    let response: CustomFunctionResponse;

    switch (name) {
      case 'capture_name':
        response = await handleCaptureName(call.call_id, args);
        break;

      case 'verify_code':
        response = await handleVerifyCode(call.call_id, call.from_number || '', args);
        break;

      case 'capture_vertical':
        response = await handleCaptureVertical(call.call_id, args);
        break;

      case 'capture_pain':
        response = await handleCapturePain(call.call_id, args);
        break;

      case 'initiate_callback':
        response = await handleInitiateCallback(call.call_id, args);
        break;

      case 'schedule_appointment':
        response = await handleScheduleAppointment(call.call_id, args);
        break;

      default:
        console.warn('Unknown custom function:', name);
        response = { result: 'Unknown function' };
    }

    res.json(response);
  } catch (error) {
    console.error('Custom function error:', error);
    res.status(500).json({ result: 'An error occurred. Please try again.' });
  }
});

// ============================================================================
// Custom Function Handlers
// ============================================================================

async function handleCaptureName(
  callId: string,
  args: Record<string, unknown>
): Promise<CustomFunctionResponse> {
  const name = sanitizeName(String(args.name || ''));

  const state = callState.get(callId) || { codeAttempts: 0 };
  state.name = name;
  callState.set(callId, state);

  console.log('Captured name:', name, 'for call:', callId);

  return {
    result: `Got it, ${name}. Now please say the 4-digit code shown on your screen.`,
    information: { captured_name: name },
  };
}

async function handleVerifyCode(
  callId: string,
  callerNumber: string,
  args: Record<string, unknown>
): Promise<CustomFunctionResponse> {
  const code = String(args.code || '').replace(/\D/g, '');
  const state = callState.get(callId) || { codeAttempts: 0 };
  const callerName = state.name || 'Caller';

  // Check rate limit
  const rateLimitCheck = await checkRateLimit(callerNumber);
  if (!rateLimitCheck.allowed) {
    const waitSeconds = rateLimitCheck.lockedUntil
      ? Math.ceil((rateLimitCheck.lockedUntil.getTime() - Date.now()) / 1000)
      : 60;
    return {
      result: `Too many failed attempts. Please wait ${waitSeconds} seconds and try again.`,
    };
  }

  // Validate code format
  if (code.length !== 4) {
    state.codeAttempts++;
    callState.set(callId, state);
    await recordFailedAttempt(callerNumber);

    if (state.codeAttempts >= 3) {
      return {
        result: 'Sorry, I couldn\'t understand the code. Please refresh the webpage and try again.',
      };
    }

    return {
      result: 'I need a 4-digit code. Please say the digits one at a time, like "four eight two seven".',
    };
  }

  // Find session
  const session = await findSessionByCode(code);

  if (!session) {
    state.codeAttempts++;
    callState.set(callId, state);
    await recordFailedAttempt(callerNumber);

    if (state.codeAttempts >= 3) {
      return {
        result: 'That code doesn\'t match any active session. Please refresh the webpage and try again.',
      };
    }

    return {
      result: 'I couldn\'t find that code. Please make sure you\'re reading the code from your webpage.',
    };
  }

  // Success - pair the session
  await pairSession(session.id, callerNumber, callerName, callId);
  await clearRateLimit(callerNumber);

  state.sessionId = session.id;
  callState.set(callId, state);

  // Emit WebSocket event
  emitToSession(session.id, 'paired', {
    callerName,
    timestamp: new Date().toISOString(),
  });

  return {
    result: `Connected! Keep the webpage open, ${callerName}. I can see your browser updating in real-time now.`,
    information: { session_id: session.id, paired: true },
  };
}

async function handleCaptureVertical(
  callId: string,
  args: Record<string, unknown>
): Promise<CustomFunctionResponse> {
  const state = callState.get(callId);
  if (!state?.sessionId) {
    return { result: 'Please verify your code first.' };
  }

  const vertical = normalizeVertical(String(args.vertical || ''));

  await createEvent(state.sessionId, 'vertical_selected', {
    vertical,
    timestamp: new Date().toISOString(),
  });

  emitToSession(state.sessionId, 'vertical_selected', {
    vertical,
    timestamp: new Date().toISOString(),
  });

  await extendSession(state.sessionId);

  const verticalDisplay = vertical.replace(/_/g, ' ');

  return {
    result: `Great, ${verticalDisplay}! Check your browser - you should see it updating. Now, what's your biggest pain point with outbound calling?`,
    information: { vertical },
  };
}

async function handleCapturePain(
  callId: string,
  args: Record<string, unknown>
): Promise<CustomFunctionResponse> {
  const state = callState.get(callId);
  if (!state?.sessionId) {
    return { result: 'Please verify your code first.' };
  }

  const pain = normalizePain(String(args.pain || ''));

  await createEvent(state.sessionId, 'pain_selected', {
    pain,
    timestamp: new Date().toISOString(),
  });

  emitToSession(state.sessionId, 'pain_selected', {
    pain,
    timestamp: new Date().toISOString(),
  });

  await extendSession(state.sessionId);

  const painDisplay = pain.replace(/_/g, ' ');

  return {
    result: `${painDisplay} - we hear that a lot! Check your browser, you should see it updating. Now here's the exciting part - I'm going to demonstrate our power dialer by calling you back instantly. What's your phone number?`,
    information: { pain },
  };
}

async function handleInitiateCallback(
  callId: string,
  args: Record<string, unknown>
): Promise<CustomFunctionResponse> {
  const state = callState.get(callId);
  if (!state?.sessionId) {
    return { result: 'Please verify your code first.' };
  }

  const phoneNumber = normalizePhoneNumber(String(args.phone_number || ''));

  if (!phoneNumber) {
    return {
      result: 'I didn\'t catch that phone number. Please say your 10-digit phone number digit by digit.',
    };
  }

  // Update session with callback phone
  await updateSessionPhone(state.sessionId, phoneNumber);

  // Emit preparing event
  await createEvent(state.sessionId, 'callback_preparing', {
    phoneNumber: maskPhone(phoneNumber),
    timestamp: new Date().toISOString(),
  });

  emitToSession(state.sessionId, 'callback_preparing', {
    phoneNumber: maskPhone(phoneNumber),
    timestamp: new Date().toISOString(),
  });

  // Schedule the callback after this call ends
  setTimeout(async () => {
    try {
      await initiateCallback(state.sessionId!, phoneNumber, state.name || 'there');
    } catch (error) {
      console.error('Callback error:', error);
      emitToSession(state.sessionId!, 'callback_failed', {
        error: 'Failed to place call',
        timestamp: new Date().toISOString(),
      });
    }
  }, 3000);

  return {
    result: `Got it! I have your number ending in ${phoneNumber.slice(-4)}. Watch your screen - the dialer is about to call you. Hang up now and answer the incoming call!`,
    information: { phone_captured: true, phone_last_four: phoneNumber.slice(-4) },
  };
}

async function handleScheduleAppointment(
  callId: string,
  args: Record<string, unknown>
): Promise<CustomFunctionResponse> {
  // For callback calls, get session from metadata
  const state = callState.get(callId);
  const sessionId = state?.sessionId || String(args.session_id || '');

  if (!sessionId) {
    return { result: 'I couldn\'t find your session. Let\'s continue anyway.' };
  }

  const wantsSchedule = String(args.wants_schedule || '').toLowerCase();
  const isYes = ['yes', 'yeah', 'sure', 'okay', 'yep', 'absolutely', 'definitely'].some(
    word => wantsSchedule.includes(word)
  );

  if (isYes) {
    await createEvent(sessionId, 'schedule_requested', {
      timestamp: new Date().toISOString(),
    });

    emitToSession(sessionId, 'schedule_requested', {
      timestamp: new Date().toISOString(),
    });

    // Schedule a demo appointment
    const appointmentDate = getNextBusinessDay();

    await createEvent(sessionId, 'appointment_scheduled', {
      date: appointmentDate,
      time: '2:00 PM',
      timestamp: new Date().toISOString(),
    });

    emitToSession(sessionId, 'appointment_scheduled', {
      date: appointmentDate,
      time: '2:00 PM',
      timestamp: new Date().toISOString(),
    });

    return {
      result: `Great! Check your screen - the calendar is now open. I've scheduled a demo follow-up for ${appointmentDate} at 2 PM. You should see it on the calendar now.`,
      information: { scheduled: true, date: appointmentDate, time: '2:00 PM' },
    };
  } else {
    await createEvent(sessionId, 'schedule_declined', {
      timestamp: new Date().toISOString(),
    });

    emitToSession(sessionId, 'schedule_declined', {
      timestamp: new Date().toISOString(),
    });

    return {
      result: 'No problem! The calendar feature is there whenever you need it.',
      information: { scheduled: false },
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

async function initiateCallback(
  sessionId: string,
  phoneNumber: string,
  callerName: string
) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Emit dialing event
  await createEvent(sessionId, 'callback_dialing', {
    phoneNumber: maskPhone(phoneNumber),
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'callback_dialing', {
    phoneNumber: maskPhone(phoneNumber),
    callerName,
    timestamp: new Date().toISOString(),
  });

  // Create outbound call via Retell
  const call = await createOutboundCall({
    toNumber: phoneNumber,
    sessionId,
    callerName,
  });

  // Store session ID for callback call
  callState.set(call.call_id, {
    name: callerName,
    sessionId,
    codeAttempts: 0,
  });

  await createEvent(sessionId, 'callback_initiated', {
    callId: call.call_id,
    timestamp: new Date().toISOString(),
  });

  // Emit answered event (Retell handles the connection)
  setTimeout(() => {
    emitToSession(sessionId, 'callback_answered', {
      callerName,
      timestamp: new Date().toISOString(),
    });
  }, 2000);

  console.log(`Callback initiated via Retell: ${call.call_id} to ${maskPhone(phoneNumber)}`);
}

function sanitizeName(speech: string): string {
  if (!speech) return 'Caller';

  let name = speech.trim()
    .replace(/\b(my name is|i'm|i am|it's|this is|call me)\b/gi, '')
    .trim();

  name = name
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  name = name.replace(/[^a-zA-Z\s'-]/g, '').slice(0, 100);

  return name || 'Caller';
}

function normalizeVertical(input: string): string {
  const lower = input.toLowerCase();

  if (lower.includes('real estate') || lower.includes('realtor') || lower.includes('property')) {
    return 'real_estate';
  }
  if (lower.includes('insurance') || lower.includes('policy')) {
    return 'insurance';
  }
  if (lower.includes('mortgage') || lower.includes('loan') || lower.includes('lending')) {
    return 'mortgage';
  }
  return 'other';
}

function normalizePain(input: string): string {
  const lower = input.toLowerCase();

  if (lower.includes('spam') || lower.includes('flag') || lower.includes('blocked')) {
    return 'spam_flags';
  }
  if (lower.includes('delay') || lower.includes('awkward') || lower.includes('pause')) {
    return 'awkward_delay';
  }
  if (lower.includes('answer') || lower.includes('rate') || lower.includes('pickup')) {
    return 'low_answer_rates';
  }
  if (lower.includes('speed') || lower.includes('slow') || lower.includes('fast')) {
    return 'speed';
  }
  return 'other';
}

function normalizePhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `+${digits}`;
  }
  if (digits.length > 10) {
    return `+1${digits.slice(-10)}`;
  }

  return null;
}

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return `(***) ***-${phone.slice(-4)}`;
}

function getNextBusinessDay(): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  while (tomorrow.getDay() === 0 || tomorrow.getDay() === 6) {
    tomorrow.setDate(tomorrow.getDate() + 1);
  }

  return tomorrow.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export default router;
