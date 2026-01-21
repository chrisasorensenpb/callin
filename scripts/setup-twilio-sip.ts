/**
 * Configure Twilio SIP Trunk to route calls to Retell AI
 *
 * Usage: npx tsx scripts/setup-twilio-sip.ts
 */

import dotenv from 'dotenv';
dotenv.config();

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('Error: Missing Twilio credentials in .env');
  process.exit(1);
}

const TWILIO_API = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`;
const TWILIO_TRUNKING_API = `https://trunking.twilio.com/v1`;

// Retell's SIP server
const RETELL_SIP_URI = 'sip:sip.retellai.com';

function getAuthHeader(): string {
  return 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
}

async function twilioRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': getAuthHeader(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twilio API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function twilioFormRequest<T>(url: string, data: Record<string, string>): Promise<T> {
  const formData = new URLSearchParams(data);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Twilio API error: ${response.status} - ${error}`);
  }

  return response.json();
}

interface TwilioTrunk {
  sid: string;
  friendly_name: string;
  domain_name: string;
}

interface TwilioPhoneNumber {
  sid: string;
  phone_number: string;
  voice_url: string;
}

interface TwilioOriginationUrl {
  sid: string;
  sip_url: string;
}

async function findOrCreateTrunk(): Promise<TwilioTrunk> {
  // List existing trunks
  const trunksResponse = await twilioRequest<{ trunks: TwilioTrunk[] }>(
    `${TWILIO_TRUNKING_API}/Trunks`
  );

  // Check if we already have a Retell trunk
  const existingTrunk = trunksResponse.trunks?.find(t =>
    t.friendly_name.toLowerCase().includes('retell')
  );

  if (existingTrunk) {
    console.log(`  Found existing trunk: ${existingTrunk.friendly_name}`);
    return existingTrunk;
  }

  // Create new trunk
  console.log('  Creating new SIP trunk...');
  const trunk = await twilioFormRequest<TwilioTrunk>(
    `${TWILIO_TRUNKING_API}/Trunks`,
    {
      FriendlyName: 'Retell AI Voice Agent',
    }
  );

  console.log(`  Created trunk: ${trunk.sid}`);
  return trunk;
}

async function configureOriginationUri(trunkSid: string): Promise<void> {
  // List existing origination URIs
  const origResponse = await twilioRequest<{ origination_urls: TwilioOriginationUrl[] }>(
    `${TWILIO_TRUNKING_API}/Trunks/${trunkSid}/OriginationUrls`
  );

  // Check if Retell URI already exists
  const existingUri = origResponse.origination_urls?.find(u =>
    u.sip_url.includes('retellai.com') || u.sip_url.includes('livekit.cloud')
  );

  if (existingUri) {
    console.log(`  Origination URI already configured: ${existingUri.sip_url}`);
    return;
  }

  // Add Retell's SIP URI as origination
  console.log('  Adding Retell origination URI...');
  await twilioFormRequest(
    `${TWILIO_TRUNKING_API}/Trunks/${trunkSid}/OriginationUrls`,
    {
      FriendlyName: 'Retell AI',
      SipUrl: RETELL_SIP_URI,
      Priority: '1',
      Weight: '1',
      Enabled: 'true',
    }
  );
  console.log(`  Added origination URI: ${RETELL_SIP_URI}`);
}

async function findPhoneNumberSid(): Promise<string> {
  const response = await twilioRequest<{ incoming_phone_numbers: TwilioPhoneNumber[] }>(
    `${TWILIO_API}/IncomingPhoneNumbers.json`
  );

  const phoneNumber = response.incoming_phone_numbers?.find(p =>
    p.phone_number === TWILIO_PHONE_NUMBER
  );

  if (!phoneNumber) {
    throw new Error(`Phone number ${TWILIO_PHONE_NUMBER} not found in account`);
  }

  return phoneNumber.sid;
}

async function assignPhoneToTrunk(trunkSid: string, phoneNumberSid: string): Promise<void> {
  // Check if already assigned
  const phonesResponse = await twilioRequest<{ phone_numbers: { sid: string }[] }>(
    `${TWILIO_TRUNKING_API}/Trunks/${trunkSid}/PhoneNumbers`
  );

  const alreadyAssigned = phonesResponse.phone_numbers?.some(p => p.sid === phoneNumberSid);

  if (alreadyAssigned) {
    console.log(`  Phone number already assigned to trunk`);
    return;
  }

  // Assign phone number to trunk
  console.log('  Assigning phone number to SIP trunk...');
  await twilioFormRequest(
    `${TWILIO_TRUNKING_API}/Trunks/${trunkSid}/PhoneNumbers`,
    {
      PhoneNumberSid: phoneNumberSid,
    }
  );
  console.log(`  Assigned ${TWILIO_PHONE_NUMBER} to trunk`);
}

async function main() {
  console.log('='.repeat(50));
  console.log('Configuring Twilio SIP Trunk for Retell AI');
  console.log('='.repeat(50));
  console.log('');

  try {
    // Step 1: Find or create SIP trunk
    console.log('Step 1: Setting up SIP trunk...');
    const trunk = await findOrCreateTrunk();

    // Step 2: Configure origination URI
    console.log('');
    console.log('Step 2: Configuring origination URI...');
    await configureOriginationUri(trunk.sid);

    // Step 3: Find phone number SID
    console.log('');
    console.log('Step 3: Finding phone number...');
    const phoneNumberSid = await findPhoneNumberSid();
    console.log(`  Found: ${TWILIO_PHONE_NUMBER} (${phoneNumberSid})`);

    // Step 4: Assign phone to trunk
    console.log('');
    console.log('Step 4: Assigning phone to trunk...');
    await assignPhoneToTrunk(trunk.sid, phoneNumberSid);

    console.log('');
    console.log('='.repeat(50));
    console.log('SUCCESS! Twilio SIP trunk configured for Retell AI');
    console.log('='.repeat(50));
    console.log('');
    console.log('Your phone number is now routed through the SIP trunk to Retell.');
    console.log('Incoming calls to', TWILIO_PHONE_NUMBER, 'will be handled by Retell AI.');
    console.log('');
    console.log('NOTE: You still need to import this number in Retell dashboard:');
    console.log('1. Go to https://dashboard.retellai.com');
    console.log('2. Select your agent → Phone Numbers → Import');
    console.log('3. Choose "Twilio SIP Trunk" and enter your number');

  } catch (error) {
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

main();
