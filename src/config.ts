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
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_PHONE_NUMBER',
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0 && config.nodeEnv === 'production') {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (missing.length > 0) {
    console.warn(`Warning: Missing environment variables: ${missing.join(', ')}`);
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
