import { Router, Request, Response } from 'express';
import twilio from 'twilio';
import { config } from './config.js';
import {
  parseSpokenCode,
  sanitizeName,
  parseVerticalSelection,
  parsePainSelection,
  parsePhoneNumber,
} from './speech-parser.js';
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

const router = Router();
const VoiceResponse = twilio.twiml.VoiceResponse;

// Initialize Twilio client for outbound calls
const twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);

// Store temporary call data (in production, use Redis)
const callData = new Map<string, { name?: string; attempts: number; sessionId?: string }>();

// Entry point - ask for name
router.post('/voice', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;

  // Initialize call data
  callData.set(callSid, { attempts: 0 });

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Hi, welcome to the Phone Burner demo. What\'s your name?');

  twiml.gather({
    input: ['speech'],
    action: '/twilio/name',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });

  // Fallback if no input
  twiml.say('I didn\'t catch that. Let\'s try again.');
  twiml.redirect('/twilio/voice');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle name capture
router.post('/name', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult || '';

  const name = sanitizeName(speechResult);

  // Store name for this call
  const data = callData.get(callSid) || { attempts: 0 };
  data.name = name;
  callData.set(callSid, data);

  twiml.say({
    voice: 'Polly.Matthew',
  }, `Thanks, ${name}. Now say the four digit code you see on your website.`);

  twiml.gather({
    input: ['speech'],
    action: '/twilio/code',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
  });

  // Fallback
  twiml.say('I didn\'t hear the code. Let\'s try again.');
  twiml.redirect('/twilio/name');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle code pairing
router.post('/code', async (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const callerNumber = req.body.From || '';
  const speechResult = req.body.SpeechResult || '';

  const data = callData.get(callSid) || { attempts: 0 };
  const callerName = data.name || 'Caller';

  // Check rate limit
  const rateLimitCheck = await checkRateLimit(callerNumber);
  if (!rateLimitCheck.allowed) {
    const waitSeconds = rateLimitCheck.lockedUntil
      ? Math.ceil((rateLimitCheck.lockedUntil.getTime() - Date.now()) / 1000)
      : 60;

    twiml.say({
      voice: 'Polly.Matthew',
    }, `Too many failed attempts. Please wait ${waitSeconds} seconds and try again.`);
    twiml.hangup();

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Parse the spoken code
  const parseResult = parseSpokenCode(speechResult);

  if (!parseResult.success || !parseResult.code) {
    data.attempts++;
    callData.set(callSid, data);

    const lockResult = await recordFailedAttempt(callerNumber);

    if (lockResult.locked || data.attempts >= 3) {
      twiml.say({
        voice: 'Polly.Matthew',
      }, 'Sorry, I couldn\'t understand the code. Please refresh the webpage and try again.');
      twiml.hangup();
    } else {
      twiml.say({
        voice: 'Polly.Matthew',
      }, 'Sorry, I didn\'t get that. Please say the four digits one at a time, like four eight two seven.');

      twiml.gather({
        input: ['speech'],
        action: '/twilio/code',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US',
        hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
      });

      twiml.redirect('/twilio/code-retry');
    }

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Find session by code
  const session = await findSessionByCode(parseResult.code);

  if (!session) {
    data.attempts++;
    callData.set(callSid, data);

    await recordFailedAttempt(callerNumber);

    if (data.attempts >= 3) {
      twiml.say({
        voice: 'Polly.Matthew',
      }, 'That code doesn\'t match any active session. Please refresh the webpage and try again.');
      twiml.hangup();
    } else {
      twiml.say({
        voice: 'Polly.Matthew',
      }, 'I couldn\'t find that code. Please make sure you\'re reading the code from your webpage and try again.');

      twiml.gather({
        input: ['speech'],
        action: '/twilio/code',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'en-US',
        hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
      });

      twiml.redirect('/twilio/code-retry');
    }

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Success - pair the session
  try {
    await pairSession(session.id, callerNumber, callerName, callSid);
    await clearRateLimit(callerNumber);

    // Store session ID in call data
    data.sessionId = session.id;
    callData.set(callSid, data);

    // Emit WebSocket event
    emitToSession(session.id, 'paired', {
      callerName,
      timestamp: new Date().toISOString(),
    });

    twiml.say({
      voice: 'Polly.Matthew',
    }, `Connected! Keep the webpage open, ${callerName}. Now, let me ask you a couple quick questions.`);

    twiml.pause({ length: 1 });

    twiml.say({
      voice: 'Polly.Matthew',
    }, 'What industry are you in? Say Real Estate, Insurance, Mortgage, or Other.');

    twiml.gather({
      input: ['speech'],
      action: `/twilio/vertical?sessionId=${session.id}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      hints: 'real estate, insurance, mortgage, other',
    });

    twiml.say('I didn\'t catch that.');
    twiml.redirect(`/twilio/vertical-prompt?sessionId=${session.id}`);

  } catch (error) {
    console.error('Error pairing session:', error);
    twiml.say({
      voice: 'Polly.Matthew',
    }, 'Sorry, there was an error connecting your session. Please try again.');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Retry prompt for code
router.post('/code-retry', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Please say the four digit code you see on your website.');

  twiml.gather({
    input: ['speech'],
    action: '/twilio/code',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
  });

  twiml.say('Let me transfer you to support.');
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// Vertical prompt
router.post('/vertical-prompt', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'What industry are you in? Say Real Estate, Insurance, Mortgage, or Other.');

  twiml.gather({
    input: ['speech'],
    action: `/twilio/vertical?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'real estate, insurance, mortgage, other',
  });

  twiml.redirect(`/twilio/vertical-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle vertical selection
router.post('/vertical', async (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;
  const speechResult = req.body.SpeechResult || '';

  const vertical = parseVerticalSelection(speechResult);

  if (!vertical) {
    twiml.say({
      voice: 'Polly.Matthew',
    }, 'I didn\'t catch that. Please say Real Estate, Insurance, Mortgage, or Other.');

    twiml.gather({
      input: ['speech'],
      action: `/twilio/vertical?sessionId=${sessionId}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      hints: 'real estate, insurance, mortgage, other',
    });

    twiml.redirect(`/twilio/vertical-prompt?sessionId=${sessionId}`);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Store event and emit to WebSocket
  await createEvent(sessionId, 'vertical_selected', {
    vertical,
    raw: speechResult,
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'vertical_selected', {
    vertical,
    timestamp: new Date().toISOString(),
  });

  await extendSession(sessionId);

  const verticalDisplay = vertical.replace('_', ' ');

  twiml.say({
    voice: 'Polly.Matthew',
  }, `Great, ${verticalDisplay}! What\'s your biggest pain point with outbound calling? Say Spam Flags, Awkward Delay, Low Answer Rates, or Speed.`);

  twiml.gather({
    input: ['speech'],
    action: `/twilio/pain?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'spam flags, awkward delay, low answer rates, speed',
  });

  twiml.redirect(`/twilio/pain-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Pain prompt
router.post('/pain-prompt', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'What\'s your biggest pain point? Say Spam Flags, Awkward Delay, Low Answer Rates, or Speed.');

  twiml.gather({
    input: ['speech'],
    action: `/twilio/pain?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'spam flags, awkward delay, low answer rates, speed',
  });

  twiml.redirect(`/twilio/pain-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle pain selection - now asks for phone number
router.post('/pain', async (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;
  const speechResult = req.body.SpeechResult || '';

  const pain = parsePainSelection(speechResult);

  if (!pain) {
    twiml.say({
      voice: 'Polly.Matthew',
    }, 'I didn\'t catch that. Please say Spam Flags, Awkward Delay, Low Answer Rates, or Speed.');

    twiml.gather({
      input: ['speech'],
      action: `/twilio/pain?sessionId=${sessionId}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      hints: 'spam flags, awkward delay, low answer rates, speed',
    });

    twiml.redirect(`/twilio/pain-prompt?sessionId=${sessionId}`);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Store event and emit to WebSocket
  await createEvent(sessionId, 'pain_selected', {
    pain,
    raw: speechResult,
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'pain_selected', {
    pain,
    timestamp: new Date().toISOString(),
  });

  await extendSession(sessionId);

  const painDisplay = pain.replace(/_/g, ' ');

  twiml.say({
    voice: 'Polly.Matthew',
  }, `${painDisplay} - we hear that a lot. Check your browser, you should see it updating in real-time.`);

  twiml.pause({ length: 1 });

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Now here\'s the exciting part. I\'m going to demonstrate our power dialer by calling you back instantly. What\'s your phone number? Please say it digit by digit.');

  twiml.gather({
    input: ['speech'],
    action: `/twilio/phone?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
  });

  twiml.redirect(`/twilio/phone-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Phone prompt
router.post('/phone-prompt', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Please say your phone number digit by digit, like 4 1 5 5 5 5 1 2 3 4.');

  twiml.gather({
    input: ['speech'],
    action: `/twilio/phone?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
  });

  twiml.redirect(`/twilio/phone-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle phone number and initiate callback
router.post('/phone', async (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;
  const speechResult = req.body.SpeechResult || '';

  const phoneResult = parsePhoneNumber(speechResult);

  if (!phoneResult.success || !phoneResult.number) {
    twiml.say({
      voice: 'Polly.Matthew',
    }, 'I didn\'t quite get that. Please say your 10 digit phone number, digit by digit.');

    twiml.gather({
      input: ['speech'],
      action: `/twilio/phone?sessionId=${sessionId}`,
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
      hints: 'zero, one, two, three, four, five, six, seven, eight, nine',
    });

    twiml.redirect(`/twilio/phone-prompt?sessionId=${sessionId}`);

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const phoneNumber = phoneResult.number;

  // Update session with callback phone number
  await updateSessionPhone(sessionId, phoneNumber);

  // Emit event to show dialer is preparing
  await createEvent(sessionId, 'callback_preparing', {
    phoneNumber: maskPhone(phoneNumber),
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'callback_preparing', {
    phoneNumber: maskPhone(phoneNumber),
    timestamp: new Date().toISOString(),
  });

  twiml.say({
    voice: 'Polly.Matthew',
  }, `Got it! I have ${formatPhoneForSpeech(phoneNumber)}. Watch your screen - the dialer is about to call you. Hang up now and answer the incoming call!`);

  twiml.pause({ length: 2 });

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());

  // Initiate the callback after a short delay
  setTimeout(async () => {
    try {
      await initiateCallback(sessionId, phoneNumber);
    } catch (error) {
      console.error('Error initiating callback:', error);
      emitToSession(sessionId, 'callback_failed', {
        error: 'Failed to place call',
        timestamp: new Date().toISOString(),
      });
    }
  }, 3000);
});

// Initiate callback to the user
async function initiateCallback(sessionId: string, phoneNumber: string) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  // Log Twilio config for debugging (mask sensitive data)
  console.log('Twilio config check:', {
    accountSid: config.twilio.accountSid ? `${config.twilio.accountSid.slice(0, 10)}...` : 'MISSING',
    authToken: config.twilio.authToken ? `${config.twilio.authToken.slice(0, 8)}...` : 'MISSING',
    phoneNumber: config.twilio.phoneNumber || 'MISSING',
    baseUrl: config.baseUrl,
  });

  // Emit dialing event
  await createEvent(sessionId, 'callback_dialing', {
    phoneNumber: maskPhone(phoneNumber),
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'callback_dialing', {
    phoneNumber: maskPhone(phoneNumber),
    callerName: session.callerName,
    timestamp: new Date().toISOString(),
  });

  try {
    // Place the outbound call
    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: config.twilio.phoneNumber,
      url: `${config.baseUrl}/twilio/callback-answer?sessionId=${sessionId}`,
      statusCallback: `${config.baseUrl}/twilio/callback-status?sessionId=${sessionId}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    console.log(`Callback initiated: ${call.sid} to ${phoneNumber}`);

    await createEvent(sessionId, 'callback_initiated', {
      callSid: call.sid,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const twilioError = error as { code?: number; status?: number; message?: string };
    console.error('Twilio API error:', {
      code: twilioError.code,
      status: twilioError.status,
      message: twilioError.message,
    });
    throw error;
  }
}

// Handle callback answer
router.post('/callback-answer', async (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;

  const session = await getSession(sessionId);
  const callerName = session?.callerName || 'there';

  // Emit answered event
  await createEvent(sessionId, 'callback_answered', {
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'callback_answered', {
    callerName,
    timestamp: new Date().toISOString(),
  });

  twiml.say({
    voice: 'Polly.Matthew',
  }, `Hi ${callerName}! This is Phone Burner calling you back. Notice how fast that was? No awkward delay, no pause - instant connection.`);

  twiml.pause({ length: 1 });

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Look at your browser now. You can see the dialer interface with your contact information, ready to take notes and schedule follow-ups.');

  twiml.pause({ length: 1 });

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Would you like to schedule a follow-up call? Say yes or no.');

  twiml.gather({
    input: ['speech'],
    action: `/twilio/schedule?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'yes, no, yeah, nope, sure, okay',
  });

  twiml.redirect(`/twilio/schedule-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Schedule prompt
router.post('/schedule-prompt', (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'Would you like to schedule a follow-up? Say yes or no.');

  twiml.gather({
    input: ['speech'],
    action: `/twilio/schedule?sessionId=${sessionId}`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
    hints: 'yes, no',
  });

  twiml.redirect(`/twilio/schedule-prompt?sessionId=${sessionId}`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle schedule response
router.post('/schedule', async (req: Request, res: Response) => {
  const twiml = new VoiceResponse();
  const sessionId = req.query.sessionId as string;
  const speechResult = req.body.SpeechResult || '';

  const response = speechResult.toLowerCase();
  const wantsSchedule = response.includes('yes') || response.includes('yeah') ||
                        response.includes('sure') || response.includes('okay') ||
                        response.includes('yep');

  if (wantsSchedule) {
    // Emit schedule event
    await createEvent(sessionId, 'schedule_requested', {
      timestamp: new Date().toISOString(),
    });

    emitToSession(sessionId, 'schedule_requested', {
      timestamp: new Date().toISOString(),
    });

    twiml.say({
      voice: 'Polly.Matthew',
    }, 'Great! Check your screen - the calendar is now open. In a real scenario, you would select a date and time, and the system would automatically schedule the call and send a reminder.');

    twiml.pause({ length: 2 });

    // Emit appointment booked for demo
    await createEvent(sessionId, 'appointment_scheduled', {
      date: getNextBusinessDay(),
      time: '2:00 PM',
      timestamp: new Date().toISOString(),
    });

    emitToSession(sessionId, 'appointment_scheduled', {
      date: getNextBusinessDay(),
      time: '2:00 PM',
      timestamp: new Date().toISOString(),
    });

    twiml.say({
      voice: 'Polly.Matthew',
    }, 'I\'ve scheduled a demo follow-up for tomorrow at 2 PM. You should see it on the calendar now.');
  } else {
    await createEvent(sessionId, 'schedule_declined', {
      timestamp: new Date().toISOString(),
    });

    emitToSession(sessionId, 'schedule_declined', {
      timestamp: new Date().toISOString(),
    });

    twiml.say({
      voice: 'Polly.Matthew',
    }, 'No problem! The calendar feature is there whenever you need it.');
  }

  twiml.pause({ length: 1 });

  twiml.say({
    voice: 'Polly.Matthew',
  }, 'That\'s the Phone Burner power dialer demo! You\'ve seen instant callbacks, real-time CRM updates, and appointment scheduling. Thanks for trying it out. Goodbye!');

  // Emit completion
  await createEvent(sessionId, 'demo_completed', {
    timestamp: new Date().toISOString(),
  });

  emitToSession(sessionId, 'demo_completed', {
    timestamp: new Date().toISOString(),
  });

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

// Callback status updates
router.post('/callback-status', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const { CallSid, CallStatus } = req.body;

  console.log(`Callback ${CallSid} status: ${CallStatus}`);

  if (CallStatus === 'ringing') {
    emitToSession(sessionId, 'callback_ringing', {
      timestamp: new Date().toISOString(),
    });
  } else if (CallStatus === 'busy' || CallStatus === 'no-answer' || CallStatus === 'failed') {
    emitToSession(sessionId, 'callback_failed', {
      status: CallStatus,
      timestamp: new Date().toISOString(),
    });
  }

  res.sendStatus(200);
});

// Status callback for call events
router.post('/status', async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration } = req.body;

  console.log(`Call ${CallSid} status: ${CallStatus}, duration: ${CallDuration}s`);

  // Clean up call data on completion
  if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
    callData.delete(CallSid);
  }

  res.sendStatus(200);
});

// Helper functions
function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return `(***) ***-${phone.slice(-4)}`;
}

function formatPhoneForSpeech(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}, ${digits.slice(3, 6)}, ${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits[0] === '1') {
    return `${digits.slice(1, 4)}, ${digits.slice(4, 7)}, ${digits.slice(7)}`;
  }
  return digits.split('').join(' ');
}

function getNextBusinessDay(): string {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Skip weekends
  while (tomorrow.getDay() === 0 || tomorrow.getDay() === 6) {
    tomorrow.setDate(tomorrow.getDate() + 1);
  }

  return tomorrow.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  });
}

export default router;
