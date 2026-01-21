import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/callin?schema=public',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },

  retell: {
    apiKey: process.env.RETELL_API_KEY || '',
    agentId: process.env.RETELL_AGENT_ID || '',
    callbackAgentId: process.env.RETELL_CALLBACK_AGENT_ID || '',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    expiryMinutes: parseInt(process.env.SESSION_EXPIRY_MINUTES || '10', 10),
    pairedExpiryMinutes: parseInt(process.env.PAIRED_SESSION_EXPIRY_MINUTES || '30', 10),
  },

  rateLimit: {
    maxAttempts: parseInt(process.env.MAX_PAIRING_ATTEMPTS || '3', 10),
    lockoutSeconds: parseInt(process.env.LOCKOUT_DURATION_SECONDS || '60', 10),
  },
};

export function validateConfig(): void {
  // Twilio is still required for SIP trunk and outbound calls
  const twilioRequired = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
  ];

  // Retell is required for voice AI
  const retellRequired = [
    'RETELL_API_KEY',
    'RETELL_AGENT_ID',
  ];

  const missingTwilio = twilioRequired.filter(key => !process.env[key]);
  const missingRetell = retellRequired.filter(key => !process.env[key]);
  const missing = [...missingTwilio, ...missingRetell];

  if (missing.length > 0 && config.nodeEnv === 'production') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
  }
}

export async function validateRetellCredentials(): Promise<boolean> {
  if (!config.retell.apiKey) {
    console.error('Retell API key not configured');
    return false;
  }

  try {
    const response = await fetch('https://api.retellai.com/v2/agent', {
      headers: {
        'Authorization': `Bearer ${config.retell.apiKey}`,
      },
    });

    if (response.ok) {
      console.log('✓ Retell credentials valid');
      return true;
    } else {
      const errorData = await response.json() as { error?: string; message?: string };
      console.error('✗ Retell credentials invalid:', {
        status: response.status,
        error: errorData.error || errorData.message,
      });
      return false;
    }
  } catch (error) {
    console.error('✗ Failed to validate Retell credentials:', error);
    return false;
  }
}

export async function validateTwilioCredentials(): Promise<boolean> {
  if (!config.twilio.accountSid || !config.twilio.authToken) {
    console.error('Twilio credentials not configured');
    return false;
  }

  try {
    // Use native fetch to test Twilio credentials
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}.json`;
    const auth = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');

    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    });

    if (response.ok) {
      const data = await response.json() as { friendly_name?: string; status?: string };
      console.log('✓ Twilio credentials valid:', {
        accountName: data.friendly_name,
        status: data.status,
      });
      return true;
    } else {
      const errorData = await response.json() as { code?: number; message?: string };
      console.error('✗ Twilio credentials invalid:', {
        status: response.status,
        code: errorData.code,
        message: errorData.message,
      });
      return false;
    }
  } catch (error) {
    console.error('✗ Failed to validate Twilio credentials:', error);
    return false;
  }
}
