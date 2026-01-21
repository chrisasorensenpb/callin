/**
 * Update Render environment variables via API
 *
 * Usage: RENDER_API_KEY=xxx npx tsx scripts/setup-render.ts
 */

const RENDER_API_KEY = process.env.RENDER_API_KEY;

if (!RENDER_API_KEY) {
  console.error('Error: RENDER_API_KEY environment variable is required');
  process.exit(1);
}

const RENDER_API = 'https://api.render.com/v1';

async function renderRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${RENDER_API}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Render API error: ${response.status} - ${error}`);
  }

  return response.json();
}

interface RenderService {
  service: {
    id: string;
    name: string;
    type: string;
  };
}

interface RenderEnvVar {
  envVar: {
    key: string;
    value: string;
  };
}

async function findService(name: string): Promise<string | null> {
  const services = await renderRequest<RenderService[]>('/services?limit=50');

  for (const item of services) {
    if (item.service.name === name || item.service.name.includes(name)) {
      return item.service.id;
    }
  }
  return null;
}

async function updateEnvVar(serviceId: string, key: string, value: string): Promise<void> {
  // Try to update existing, or create new
  try {
    await renderRequest(`/services/${serviceId}/env-vars/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    console.log(`  Updated ${key}`);
  } catch {
    // If update fails, try to create
    await renderRequest(`/services/${serviceId}/env-vars`, {
      method: 'POST',
      body: JSON.stringify([{ key, value }]),
    });
    console.log(`  Created ${key}`);
  }
}

async function main() {
  console.log('='.repeat(50));
  console.log('Updating Render Environment Variables');
  console.log('='.repeat(50));
  console.log('');

  // Find the callin service
  console.log('Finding callin service...');
  const serviceId = await findService('callin');

  if (!serviceId) {
    console.error('Error: Could not find callin service on Render');
    console.log('Available services:');
    const services = await renderRequest<RenderService[]>('/services?limit=50');
    services.forEach(s => console.log(`  - ${s.service.name} (${s.service.id})`));
    process.exit(1);
  }

  console.log(`Found service: ${serviceId}`);
  console.log('');

  // Retell environment variables to add
  const envVars = {
    RETELL_API_KEY: 'key_877427112635d579dd1b7afadd6e',
    RETELL_AGENT_ID: 'agent_160fbb4a742d053b5e996b6f93',
    RETELL_CALLBACK_AGENT_ID: 'agent_4f89a01a67f0f345cfbeba6589',
  };

  console.log('Updating environment variables...');
  for (const [key, value] of Object.entries(envVars)) {
    await updateEnvVar(serviceId, key, value);
  }

  console.log('');
  console.log('='.repeat(50));
  console.log('SUCCESS! Render environment variables updated.');
  console.log('The service will redeploy automatically.');
  console.log('='.repeat(50));
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
