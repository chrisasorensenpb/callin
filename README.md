# Call-to-Test Demo

A voice-powered web demo where visitors call a phone number, speak their name and a 4-digit code, and watch the webpage update in real-time via WebSockets.

## Features

- **Auto-generated Session Codes**: Each visitor gets a unique 4-digit pairing code
- **Voice Recognition**: Uses Twilio's speech-to-text to capture spoken responses
- **Real-time Updates**: WebSocket-powered live updates as callers speak
- **No Typing Required**: Entire flow is voice-controlled (name, code, selections)
- **Rate Limiting**: Protection against abuse with attempt tracking and lockouts

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web Browser   │────▶│   Express API   │◀────│     Twilio      │
│   (React SPA)   │◀────│  + Socket.IO    │────▶│   Voice + STT   │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                        ┌────────▼────────┐
                        │   PostgreSQL    │
                        └─────────────────┘
```

## Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Twilio Account with:
  - Account SID
  - Auth Token
  - Voice-enabled phone number

## Twilio Setup

1. **Create a Twilio Account**: Sign up at [twilio.com](https://www.twilio.com)

2. **Buy a Phone Number**:
   - Go to Phone Numbers → Manage → Buy a Number
   - Select a number with Voice capability
   - Note the phone number (e.g., +1234567890)

3. **Configure Webhooks**:
   - Go to Phone Numbers → Manage → Active Numbers
   - Click on your number
   - Under "Voice & Fax", set:
     - **A call comes in**: Webhook → `https://<YOUR_DOMAIN>/twilio/voice`
     - **HTTP POST**
   - Under "Call status changes" (optional):
     - **Status Callback URL**: `https://<YOUR_DOMAIN>/twilio/status`

4. **Get Credentials**:
   - Go to Account → API keys & tokens
   - Copy your Account SID and Auth Token

## Local Development

### 1. Clone and Install

```bash
git clone <repository>
cd callin
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your values
```

Required environment variables:
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/callin"
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_PHONE_NUMBER=+1234567890
BASE_URL=https://your-ngrok-url.ngrok.io
```

### 3. Set Up Database

```bash
# Start PostgreSQL (if using Docker)
docker run -d --name callin-db \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=callin \
  -p 5432:5432 \
  postgres:16-alpine

# Push schema to database
npm run db:push
```

### 4. Expose Local Server (for Twilio)

```bash
# Install ngrok if needed
brew install ngrok  # macOS

# Start ngrok
ngrok http 3000
```

Update your Twilio webhook URL to the ngrok URL.

### 5. Start Development Server

```bash
npm run dev
```

Visit `http://localhost:3000` and call your Twilio number!

## Production Deployment

### Using Docker Compose

```bash
# Set environment variables
export TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export TWILIO_AUTH_TOKEN=your_auth_token
export TWILIO_PHONE_NUMBER=+1234567890
export BASE_URL=https://your-production-domain.com
export SESSION_SECRET=$(openssl rand -hex 32)

# Start services
docker-compose up -d

# Run migrations
docker-compose run --rm migrate
```

### Manual Deployment

```bash
# Build
npm run build

# Set production environment
export NODE_ENV=production
export DATABASE_URL="postgresql://..."
# ... other env vars

# Run migrations
npx prisma db push

# Start server
npm start
```

## API Endpoints

### Session Management

- `POST /api/session` - Create or retrieve session (uses browser token cookie)
- `GET /api/session/:id` - Get session status and events

### WebSocket Events

Connect to `/socket.io` and emit:
- `subscribe` with `sessionId` to receive updates

Receive:
- `paired` - Call connected with caller name
- `vertical_selected` - Industry selection made
- `pain_selected` - Pain point selection made
- `demo_completed` - Demo flow finished

### Twilio Webhooks

- `POST /twilio/voice` - Initial call entry point
- `POST /twilio/name` - Name capture handler
- `POST /twilio/code` - Code pairing handler
- `POST /twilio/vertical` - Industry selection handler
- `POST /twilio/pain` - Pain point selection handler
- `POST /twilio/status` - Call status callbacks

## Acceptance Test

1. Open the homepage → See your 4-digit code and "Waiting for your call..."
2. Call the displayed phone number
3. IVR asks: "What's your name?" → Say "Chris"
4. IVR asks: "Say the four digit code..." → Say "four eight two seven"
5. Website updates to "Connected" with "Hi Chris" within 1 second
6. IVR asks about industry → Say "Real Estate"
7. Website shows industry selection immediately
8. IVR asks about pain points → Say "Spam flags"
9. Website shows pain point selection immediately
10. Demo completes

## Speech Recognition Tips

The system handles various spoken formats:
- "four eight two seven" ✓
- "4827" ✓
- "the code is four eight two seven" ✓
- Common misrecognitions: "for"→4, "ate"→8, etc. ✓

If recognition fails, the IVR will prompt the caller to say digits one at a time.

## Troubleshooting

### Webhooks not receiving calls
- Verify ngrok is running (local) or domain is correct (production)
- Check Twilio console for webhook errors
- Ensure webhook URL ends with `/twilio/voice`

### WebSocket not connecting
- Check browser console for connection errors
- Verify Socket.IO is properly configured in CORS
- Check if firewall is blocking WebSocket connections

### Speech recognition issues
- Ensure caller speaks clearly
- The system supports en-US accent variations
- Check Twilio dashboard for speech recognition logs

## License

MIT
