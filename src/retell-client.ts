import { config } from './config.js';

const RETELL_API_BASE = 'https://api.retellai.com/v2';

interface CreateCallParams {
  agentId: string;
  toNumber: string;
  fromNumber: string;
  metadata?: Record<string, string>;
  retellLlmDynamicVariables?: Record<string, string>;
}

interface RetellCall {
  call_id: string;
  call_status: string;
  agent_id: string;
  from_number: string;
  to_number: string;
  metadata?: Record<string, string>;
}

async function retellRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${RETELL_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${config.retell.apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      `Retell API error: ${response.status} - ${JSON.stringify(error)}`
    );
  }

  return response.json() as Promise<T>;
}

/**
 * Create an outbound call using Retell AI
 */
export async function createOutboundCall(params: {
  toNumber: string;
  sessionId: string;
  callerName: string;
}): Promise<RetellCall> {
  const { toNumber, sessionId, callerName } = params;

  const callParams: CreateCallParams = {
    agentId: config.retell.callbackAgentId || config.retell.agentId,
    toNumber,
    fromNumber: config.twilio.phoneNumber,
    metadata: {
      sessionId,
      callerName,
    },
    retellLlmDynamicVariables: {
      caller_name: callerName,
      session_id: sessionId,
    },
  };

  console.log('Creating Retell outbound call:', {
    agentId: callParams.agentId,
    toNumber: maskPhone(toNumber),
    sessionId,
  });

  const call = await retellRequest<RetellCall>('/create-phone-call', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: callParams.agentId,
      to_number: callParams.toNumber,
      from_number: callParams.fromNumber,
      metadata: callParams.metadata,
      retell_llm_dynamic_variables: callParams.retellLlmDynamicVariables,
    }),
  });

  console.log('Retell call created:', call.call_id);
  return call;
}

/**
 * Get call details from Retell
 */
export async function getCall(callId: string): Promise<RetellCall> {
  return retellRequest<RetellCall>(`/get-call/${callId}`);
}

/**
 * End an active call
 */
export async function endCall(callId: string): Promise<void> {
  await retellRequest(`/end-call/${callId}`, {
    method: 'POST',
  });
}

function maskPhone(phone: string): string {
  if (!phone || phone.length < 4) return '****';
  return `(***) ***-${phone.slice(-4)}`;
}
