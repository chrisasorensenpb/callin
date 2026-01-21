/**
 * Setup script to create Retell AI agents via API
 *
 * Usage: RETELL_API_KEY=key_xxx npx tsx scripts/setup-retell.ts
 */

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const BASE_URL = process.env.BASE_URL || 'https://callin-6bcc.onrender.com';

if (!RETELL_API_KEY) {
  console.error('Error: RETELL_API_KEY environment variable is required');
  console.log('\nUsage: RETELL_API_KEY=key_xxx npx tsx scripts/setup-retell.ts');
  process.exit(1);
}

const RETELL_API = 'https://api.retellai.com';

async function retellRequest<T>(endpoint: string, body?: object): Promise<T> {
  const response = await fetch(`${RETELL_API}${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${RETELL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Retell API error: ${response.status} - ${error}`);
  }

  return response.json();
}

// Custom function webhook URL
const WEBHOOK_URL = `${BASE_URL}/retell/custom-function`;

// Inbound agent prompt
const INBOUND_PROMPT = `You are a friendly demo assistant for PhoneBurner's power dialer. Your job is to guide callers through a quick interactive demo.

## Conversation Flow

1. **Greet and get name**: Start by warmly greeting the caller and asking for their name. Once they tell you, call the capture_name function.

2. **Code verification**: Ask them to read the 4-digit code shown on their browser screen. When they give you a code, call the verify_code function. If it fails, ask them to try again.

3. **Industry question**: Once verified, ask what industry they're in - Real Estate, Insurance, Mortgage, or Other. Call capture_vertical with their answer.

4. **Pain point question**: Ask about their biggest pain point with outbound calling - Spam Flags, Awkward Delay, Low Answer Rates, or Speed. Call capture_pain with their answer.

5. **Phone capture**: Explain you'll demonstrate the power dialer by calling them back instantly. Ask for their phone number. When they give it, call initiate_callback and tell them to hang up and answer the incoming call.

## Guidelines
- Keep responses under 30 words
- Be natural and conversational
- Handle interruptions gracefully
- If you don't understand something, ask for clarification
- Always call the appropriate function at each step to update the browser in real-time`;

// Callback agent prompt
const CALLBACK_PROMPT = `You're calling back a user who just completed the first part of the PhoneBurner demo.

## Your Job
1. Greet them by name (use the caller_name variable)
2. Highlight how fast the callback was - "Notice how fast that was? No awkward delay!"
3. Point out their browser is updating in real-time
4. Ask if they'd like to schedule a follow-up demo call
5. Call schedule_appointment with their answer (yes/no)
6. Thank them for trying the demo and say goodbye

## Guidelines
- Keep responses concise and enthusiastic
- Emphasize the instant connection and real-time updates
- The session_id variable contains their session for the function call`;

// Custom tools for inbound agent
const inboundTools = [
  {
    type: 'custom',
    name: 'capture_name',
    description: 'Call this when the user tells you their name',
    url: WEBHOOK_URL,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The caller\'s name',
        },
      },
      required: ['name'],
    },
  },
  {
    type: 'custom',
    name: 'verify_code',
    description: 'Call this when the user tells you the 4-digit code from their screen',
    url: WEBHOOK_URL,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The 4-digit code the user read from their browser',
        },
      },
      required: ['code'],
    },
  },
  {
    type: 'custom',
    name: 'capture_vertical',
    description: 'Call this when the user tells you their industry',
    url: WEBHOOK_URL,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        vertical: {
          type: 'string',
          description: 'The industry: real estate, insurance, mortgage, or other',
        },
      },
      required: ['vertical'],
    },
  },
  {
    type: 'custom',
    name: 'capture_pain',
    description: 'Call this when the user tells you their pain point',
    url: WEBHOOK_URL,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        pain: {
          type: 'string',
          description: 'The pain point: spam flags, awkward delay, low answer rates, or speed',
        },
      },
      required: ['pain'],
    },
  },
  {
    type: 'custom',
    name: 'initiate_callback',
    description: 'Call this when the user gives you their phone number for the callback',
    url: WEBHOOK_URL,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        phone_number: {
          type: 'string',
          description: 'The phone number to call back',
        },
      },
      required: ['phone_number'],
    },
  },
  {
    type: 'end_call',
    name: 'end_call',
    description: 'End the call when the conversation is complete or user wants to hang up',
  },
];

// Custom tools for callback agent
const callbackTools = [
  {
    type: 'custom',
    name: 'schedule_appointment',
    description: 'Call this when asking if the user wants to schedule a follow-up',
    url: WEBHOOK_URL,
    speak_during_execution: false,
    speak_after_execution: true,
    parameters: {
      type: 'object',
      properties: {
        wants_schedule: {
          type: 'string',
          description: 'Whether they want to schedule: yes or no',
        },
        session_id: {
          type: 'string',
          description: 'The session ID from the dynamic variable',
        },
      },
      required: ['wants_schedule'],
    },
  },
  {
    type: 'end_call',
    name: 'end_call',
    description: 'End the call after thanking them for the demo',
  },
];

async function createLlm(name: string, prompt: string, tools: object[]) {
  console.log(`Creating LLM: ${name}...`);

  const llm = await retellRequest<{ llm_id: string }>('/create-retell-llm', {
    model: 'gpt-4o',
    general_prompt: prompt,
    general_tools: tools,
    begin_message: null, // Let agent start naturally based on context
  });

  console.log(`  Created LLM: ${llm.llm_id}`);
  return llm.llm_id;
}

async function createAgent(name: string, llmId: string, isCallback: boolean = false) {
  console.log(`Creating Agent: ${name}...`);

  const agentConfig: Record<string, unknown> = {
    agent_name: name,
    response_engine: {
      type: 'retell-llm',
      llm_id: llmId,
    },
    voice_id: '11labs-Adrian', // Natural male voice
    language: 'en-US',
    enable_backchannel: true,
    backchannel_frequency: 0.8,
    interruption_sensitivity: 0.8,
    ambient_sound: null,
    responsiveness: 1,
    voice_temperature: 1,
    voice_speed: 1,
    end_call_after_silence_ms: 30000,
  };

  // For callback agent, we pass dynamic variables
  if (isCallback) {
    agentConfig.begin_message = 'Hi {{caller_name}}! This is PhoneBurner calling you back.';
  } else {
    agentConfig.begin_message = 'Hi, welcome to the PhoneBurner demo! What\'s your name?';
  }

  const agent = await retellRequest<{ agent_id: string }>('/create-agent', agentConfig);

  console.log(`  Created Agent: ${agent.agent_id}`);
  return agent.agent_id;
}

async function main() {
  console.log('='.repeat(50));
  console.log('Setting up Retell AI agents for PhoneBurner Demo');
  console.log('='.repeat(50));
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
  console.log('');

  try {
    // Create inbound LLM and agent
    const inboundLlmId = await createLlm('phoneburner-inbound-llm', INBOUND_PROMPT, inboundTools);
    const inboundAgentId = await createAgent('PhoneBurner Demo (Inbound)', inboundLlmId);

    console.log('');

    // Create callback LLM and agent
    const callbackLlmId = await createLlm('phoneburner-callback-llm', CALLBACK_PROMPT, callbackTools);
    const callbackAgentId = await createAgent('PhoneBurner Demo (Callback)', callbackLlmId, true);

    console.log('');
    console.log('='.repeat(50));
    console.log('SUCCESS! Add these to your .env file:');
    console.log('='.repeat(50));
    console.log('');
    console.log(`RETELL_API_KEY=${RETELL_API_KEY}`);
    console.log(`RETELL_AGENT_ID=${inboundAgentId}`);
    console.log(`RETELL_CALLBACK_AGENT_ID=${callbackAgentId}`);
    console.log('');
    console.log('Next steps:');
    console.log('1. Add the above to your .env file');
    console.log('2. Add the same values in Render dashboard');
    console.log('3. Configure Twilio SIP trunk to point to Retell');
    console.log('');

  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

main();
