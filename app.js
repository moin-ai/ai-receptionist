/**
 * AI RECEPTIONIST - Groq Version (FREE)
 * Complete application for real phone calls, AI conversations, calendar booking
 */

const express = require('express');
const twilio = require('twilio');
const Groq = require('groq-sdk').default;
const { google } = require('googleapis');
const fetch = require('node-fetch');
const pdf = require('pdf-parse');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Groq (FREE)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ============================================================================
// PERSISTENCE HELPERS
// ============================================================================

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJSON(filename, fallback) {
  const file = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Error loading ${filename}:`, e.message);
  }
  return fallback;
}

function saveJSON(filename, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`Error saving ${filename}:`, e.message);
  }
}

// Load businesses: file first, then BUSINESS_CONFIG env var as fallback
const businessContexts = loadJSON('businesses.json', {});
if (Object.keys(businessContexts).length === 0 && process.env.BUSINESS_CONFIG) {
  try {
    const envBusinesses = JSON.parse(process.env.BUSINESS_CONFIG);
    Object.assign(businessContexts, envBusinesses);
    console.log(`✅ Loaded ${Object.keys(envBusinesses).length} business(es) from BUSINESS_CONFIG env var`);
  } catch (e) {
    console.error('Error parsing BUSINESS_CONFIG env var:', e.message);
  }
} else if (Object.keys(businessContexts).length > 0) {
  console.log(`✅ Loaded ${Object.keys(businessContexts).length} business(es) from data/businesses.json`);
}

const conversationHistory = {};
const bookings = loadJSON('bookings.json', []);
const callLogs = loadJSON('calllogs.json', []);

// Google OAuth setup
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${BASE_URL}/oauth2callback`
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

// ============================================================================
// OAUTH LOGIN FLOW
// ============================================================================

app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(authUrl);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const code = req.query.code;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    res.send(`
      <h1>✅ Google Calendar Connected!</h1>
      <p>Your refresh token is:</p>
      <code style="background: #f0f0f0; padding: 10px; display: block; word-break: break-all; margin: 10px 0;">
        ${tokens.refresh_token}
      </code>
      <p>Copy this and add to your .env file as:</p>
      <code style="background: #f0f0f0; padding: 10px; display: block;">
        GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}
      </code>
      <p>Then restart the app!</p>
      <p><a href="/">← Back to dashboard</a></p>
    `);
  } catch (error) {
    res.status(500).send(`Error: ${error.message}`);
  }
});

// ============================================================================
// SETUP BUSINESS
// ============================================================================

app.post('/api/setup-business', async (req, res) => {
  try {
    const { businessId, businessName, hours, services, website, googleBusinessUrl, pdfUrl } = req.body;

    let businessContext = `${businessName}\nHours: ${hours}\nServices: ${services}`;

    if (website || googleBusinessUrl) {
      const url = website || googleBusinessUrl;
      try {
        const response = await fetch(url);
        const html = await response.text();
        const text = html.replace(/<[^>]*>/g, ' ').substring(0, 2000);
        businessContext += `\n\nWebsite content:\n${text}`;
      } catch (error) {
        console.error('Error fetching website:', error.message);
      }
    }

    if (pdfUrl) {
      try {
        const response = await fetch(pdfUrl);
        const buffer = await response.buffer();
        const pdfData = await pdf(buffer);
        businessContext += `\n\nDocument content:\n${pdfData.text.substring(0, 2000)}`;
      } catch (error) {
        console.error('Error parsing PDF:', error.message);
      }
    }

    businessContexts[businessId] = {
      name: businessName,
      hours,
      services,
      context: businessContext,
      googleCalendarId: req.body.googleCalendarId || 'primary',
    };

    // Persist to file and generate env var value
    saveJSON('businesses.json', businessContexts);
    const envVarValue = JSON.stringify(businessContexts);

    res.json({
      success: true,
      message: `Business "${businessName}" setup complete`,
      contextLength: businessContext.length,
      envVarValue,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// INCOMING CALL (Twilio Webhook)
// ============================================================================

app.post('/api/incoming-call', async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const businessId = req.query.businessId || req.body.businessId || 'default';

  console.log(`📞 Incoming call: ${callSid} from ${from}`);

  conversationHistory[callSid] = [];
  callLogs.push({
    callSid,
    from,
    businessId,
    startTime: new Date(),
    messages: [],
  });
  saveJSON('calllogs.json', callLogs);

  const business = businessContexts[businessId];
  if (!business) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, this business is not configured yet. Please call back later.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    action: `/api/process-speech?callSid=${callSid}&businessId=${businessId}`,
    method: 'POST',
    input: 'speech',
    timeout: 10,
    language: 'en-US',
    speechTimeout: 'auto',
  });

  gather.say(`Hello! You've reached ${business.name}. How can I help you today?`);
  twiml.redirect(`/api/process-speech?callSid=${callSid}&businessId=${businessId}`);

  res.type('text/xml').send(twiml.toString());
});

// ============================================================================
// PROCESS SPEECH (AI Response using Groq)
// ============================================================================

app.post('/api/process-speech', async (req, res) => {
  const callSid = req.query.callSid;
  const businessId = req.query.businessId;
  const speechResult = req.body.SpeechResult || '';

  if (!speechResult.trim()) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, I did not catch that. Let me try again.');
    twiml.redirect(`/api/incoming-call?businessId=${businessId}`);
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`Speech received: ${speechResult}`);

  try {
    const aiResponse = await getAIResponse(callSid, businessId, speechResult);

    const callLog = callLogs.find((log) => log.callSid === callSid);
    if (callLog) {
      callLog.messages.push({ role: 'caller', text: speechResult, timestamp: new Date() });
      callLog.messages.push({ role: 'ai', text: aiResponse.text, timestamp: new Date() });
    }

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(aiResponse.text);

    if (aiResponse.booking) {
      twiml.say('Great! I am booking your appointment now. You will receive a confirmation shortly.');
      bookings.push(aiResponse.booking);
      saveJSON('bookings.json', bookings);
    }

    const gather = twiml.gather({
      action: `/api/process-speech?callSid=${callSid}&businessId=${businessId}`,
      method: 'POST',
      input: 'speech',
      timeout: 5,
      language: 'en-US',
      speechTimeout: 'auto',
    });
    gather.say('Is there anything else I can help you with?');

    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Error processing speech:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('I encountered an error. Please try again later.');
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ============================================================================
// GET AI RESPONSE (using Groq - FREE)
// ============================================================================

async function getAIResponse(callSid, businessId, userMessage) {
  const business = businessContexts[businessId];

  conversationHistory[callSid].push({ role: 'user', content: userMessage });

  const availableSlots = await getAvailableSlots(business.googleCalendarId);

  const systemPrompt = `You are a friendly AI receptionist for ${business.name}.

BUSINESS INFORMATION:
${business.context}

AVAILABLE APPOINTMENT SLOTS (next 7 days):
${availableSlots.map((slot) => `- ${slot.day} at ${slot.time}`).join('\n') || 'No slots available — ask caller to call back tomorrow.'}

YOUR INSTRUCTIONS:
1. Answer questions about services, pricing, hours, and location
2. Help customers book appointments
3. Extract booking details when customer mentions: service, date/time, name, phone
4. Confirm booking before completing: "So I have you down for [SERVICE] on [DATE] at [TIME]. Does that work for you?"
5. Be warm, professional, and helpful. Sound like a real person, not a robot.
6. Keep responses brief (1-2 sentences) for phone conversations

BOOKING EXTRACTION:
When you have service, date, time, and customer name/phone, respond with:
BOOKING:service=NAME|date=DATE|time=TIME|name=CUSTOMER|phone=PHONE

Example: "BOOKING:service=Haircut|date=Friday 2pm|time=14:00|name=John Smith|phone=555-1234"`;

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 150,
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory[callSid],
    ],
  });

  const assistantMessage = response.choices[0].message.content;

  conversationHistory[callSid].push({ role: 'assistant', content: assistantMessage });

  let booking = null;
  const bookingMatch = assistantMessage.match(
    /BOOKING:service=([^|]+)\|date=([^|]+)\|time=([^|]+)\|name=([^|]+)\|phone=(.+)/
  );

  if (bookingMatch) {
    booking = {
      businessId,
      service: bookingMatch[1],
      date: bookingMatch[2],
      time: bookingMatch[3],
      customerName: bookingMatch[4],
      customerPhone: bookingMatch[5].trim(),
      calendarEventCreated: false,
    };
    createCalendarEvent(businessId, booking).catch(console.error);
  }

  const cleanText = assistantMessage.replace(/BOOKING:.*/, '').trim();

  return { text: cleanText, booking };
}

// ============================================================================
// GOOGLE CALENDAR: Get available slots
// ============================================================================

async function getAvailableSlots(calendarId) {
  try {
    const now = new Date();
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const events = await calendar.events.list({
      calendarId: calendarId || 'primary',
      timeMin: now.toISOString(),
      timeMax: in7Days.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const busyTimes = events.data.items || [];
    const slots = [];

    for (let day = 0; day < 7; day++) {
      const slotDate = new Date(now);
      slotDate.setDate(slotDate.getDate() + day);

      for (let hour = 9; hour < 18; hour++) {
        const slotStart = new Date(slotDate);
        slotStart.setHours(hour, 0, 0, 0);
        const slotEnd = new Date(slotStart);
        slotEnd.setHours(hour + 1, 0, 0, 0);

        const isBooked = busyTimes.some((event) => {
          const eventStart = new Date(event.start.dateTime || event.start.date);
          const eventEnd = new Date(event.end.dateTime || event.end.date);
          return (
            (slotStart >= eventStart && slotStart < eventEnd) ||
            (slotEnd > eventStart && slotEnd <= eventEnd)
          );
        });

        if (!isBooked) {
          slots.push({
            startTime: slotStart.toISOString(),
            endTime: slotEnd.toISOString(),
            day: slotDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }),
            time: `${hour}:00`,
          });
        }
      }
    }

    return slots.slice(0, 10);
  } catch (error) {
    console.error('Error fetching calendar:', error.message);
    return [];
  }
}

// ============================================================================
// GOOGLE CALENDAR: Create event
// ============================================================================

async function createCalendarEvent(businessId, booking) {
  try {
    const business = businessContexts[businessId];

    const eventDateTime = new Date(booking.date);
    if (isNaN(eventDateTime)) {
      console.error('Could not parse date:', booking.date);
      return;
    }

    const event = {
      summary: `Appointment: ${booking.service} - ${booking.customerName}`,
      description: `Customer: ${booking.customerName}\nPhone: ${booking.customerPhone}\nService: ${booking.service}`,
      start: { dateTime: eventDateTime.toISOString(), timeZone: 'UTC' },
      end: {
        dateTime: new Date(eventDateTime.getTime() + 60 * 60 * 1000).toISOString(),
        timeZone: 'UTC',
      },
    };

    const result = await calendar.events.insert({
      calendarId: business.googleCalendarId || 'primary',
      resource: event,
      sendUpdates: 'all',
    });

    console.log(`✅ Calendar event created: ${result.data.id}`);
    await sendConfirmationEmail(booking);

    return result.data;
  } catch (error) {
    console.error('Error creating calendar event:', error.message);
  }
}

// ============================================================================
// EMAIL: Send confirmation
// ============================================================================

async function sendConfirmationEmail(booking) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_USER, // Send to business owner; update for customer email
      subject: `New Appointment: ${booking.service} - ${booking.customerName}`,
      html: `
        <h2>Appointment Confirmed</h2>
        <p>Hi there,</p>
        <p>A new appointment has been booked:</p>
        <ul>
          <li><strong>Customer:</strong> ${booking.customerName}</li>
          <li><strong>Phone:</strong> ${booking.customerPhone}</li>
          <li><strong>Service:</strong> ${booking.service}</li>
          <li><strong>Date & Time:</strong> ${booking.date} at ${booking.time}</li>
        </ul>
        <p>This appointment was booked via your AI Receptionist.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Confirmation email sent`);
  } catch (error) {
    console.error('Error sending email:', error.message);
  }
}

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

app.get('/api/calls', (req, res) => res.json(callLogs));
app.get('/api/bookings', (req, res) => res.json(bookings));

app.get('/api/business/:businessId', (req, res) => {
  const business = businessContexts[req.params.businessId];
  if (!business) return res.status(404).json({ error: 'Business not configured' });
  res.json(business);
});

// ============================================================================
// ADMIN DASHBOARD
// ============================================================================

app.get('/', (req, res) => {
  const hasRefreshToken = !!process.env.GOOGLE_REFRESH_TOKEN;
  const usingGroq = !!process.env.GROQ_API_KEY;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>AI Receptionist (Groq - FREE)</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
        .container { max-width: 900px; margin: 0 auto; }
        .section { margin: 30px 0; padding: 20px; border-radius: 8px; background: white; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        h1 { color: #667eea; }
        h2 { color: #333; border-bottom: 2px solid #667eea; padding-bottom: 10px; }
        input, textarea { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid #ddd; border-radius: 4px; font-family: Arial; box-sizing: border-box; }
        button { padding: 10px 20px; background: #667eea; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; margin-top: 10px; }
        button:hover { background: #5568d3; }
        .success { background: #d4edda; border: 1px solid #28a745; padding: 15px; border-radius: 4px; color: #155724; margin-bottom: 20px; }
        .warning { background: #fff3cd; border: 1px solid #ffc107; padding: 15px; border-radius: 4px; color: #856404; margin-bottom: 20px; }
        .call-log { background: #f9f9f9; padding: 12px; margin: 10px 0; border-left: 4px solid #667eea; border-radius: 4px; }
        .booking { background: #e3f2fd; padding: 12px; margin: 10px 0; border-left: 4px solid #2196f3; border-radius: 4px; }
        .status { margin-top: 10px; padding: 10px; border-radius: 4px; background: #cfe8fc; color: #084298; }
        a { color: #0066cc; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 AI Receptionist (Groq - FREE)</h1>

        ${usingGroq
          ? `<div class="success">✅ Groq API connected (Cost: $0 per call)</div>`
          : `<div class="warning">⚠️ Groq API not configured. Add GROQ_API_KEY to .env</div>`}

        ${!hasRefreshToken
          ? `<div class="warning">
              <strong>⚠️ Google Calendar not connected yet</strong>
              <p><a href="/auth">👉 Click here to connect Google Calendar →</a></p>
              <p>After connecting, copy the refresh token into .env as GOOGLE_REFRESH_TOKEN, then restart.</p>
            </div>`
          : `<div class="success">✅ Google Calendar is connected and ready</div>`}

        <div class="section">
          <h2>📱 Setup Business</h2>
          <input type="text" id="businessId" placeholder="Business ID (e.g., clinic-001)" value="clinic-001">
          <input type="text" id="businessName" placeholder="Business Name" value="Smile Dental Clinic">
          <input type="text" id="hours" placeholder="Hours" value="Mon-Fri 9AM-6PM, Sat 10AM-2PM">
          <textarea id="services" placeholder="Services" style="height:80px;">Cleaning $50, Root Canal $400, Whitening $150, Extraction $200</textarea>
          <input type="text" id="website" placeholder="Website URL (optional)">
          <input type="text" id="googleCalendarId" placeholder="Google Calendar ID (your email, optional)">
          <button onclick="setupBusiness()">💾 Save Business Setup</button>
          <p id="setupStatus" class="status" style="display:none;"></p>
        </div>

        <div class="section">
          <h2>📞 Incoming Calls</h2>
          <button onclick="loadCalls()">🔄 Refresh</button>
          <div id="calls" style="margin-top:15px;"></div>
        </div>

        <div class="section">
          <h2>📅 Bookings</h2>
          <button onclick="loadBookings()">🔄 Refresh</button>
          <div id="bookings" style="margin-top:15px;"></div>
        </div>
      </div>

      <script>
        async function setupBusiness() {
          const data = {
            businessId: document.getElementById('businessId').value,
            businessName: document.getElementById('businessName').value,
            hours: document.getElementById('hours').value,
            services: document.getElementById('services').value,
            website: document.getElementById('website').value,
            googleCalendarId: document.getElementById('googleCalendarId').value,
          };
          const response = await fetch('/api/setup-business', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          });
          const result = await response.json();
          const s = document.getElementById('setupStatus');
          if (result.success) {
            s.innerHTML = \`✅ \${result.message}<br><br>
              <strong>📌 To persist across deploys, add this to Render Environment Variables:</strong><br>
              <strong>Key:</strong> <code>BUSINESS_CONFIG</code><br>
              <strong>Value:</strong><br>
              <textarea onclick="this.select()" style="width:100%;height:80px;font-size:11px;margin-top:5px;">\${result.envVarValue}</textarea>\`;
          } else {
            s.innerText = result.error;
          }
          s.style.display = 'block';
        }

        async function loadCalls() {
          const calls = await (await fetch('/api/calls')).json();
          document.getElementById('calls').innerHTML = calls.length
            ? calls.map(c => \`<div class="call-log"><strong>📱 From: \${c.from}</strong> | \${new Date(c.startTime).toLocaleString()}<br>Messages: \${c.messages.length}</div>\`).join('')
            : '<p style="color:#999;">No calls yet.</p>';
        }

        async function loadBookings() {
          const bks = await (await fetch('/api/bookings')).json();
          document.getElementById('bookings').innerHTML = bks.length
            ? bks.map(b => \`<div class="booking"><strong>👤 \${b.customerName}</strong> - \${b.service}<br>📅 \${b.date} at \${b.time}<br>📞 \${b.customerPhone}</div>\`).join('')
            : '<p style="color:#999;">No bookings yet.</p>';
        }

        loadCalls();
        loadBookings();
        setInterval(() => { loadCalls(); loadBookings(); }, 5000);
      </script>
    </body>
    </html>
  `);
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 AI Receptionist is RUNNING!`);
  console.log(`\n📊 Admin Dashboard: http://localhost:${PORT}`);
  console.log(`\n🔐 First time? Visit http://localhost:${PORT}/auth to connect Google Calendar`);
  console.log(`\n💰 Cost: $0 (using Groq free tier)`);
  console.log(`\n📞 Twilio webhook URL: ${process.env.BASE_URL || 'https://your-domain.com'}/api/incoming-call\n`);
});
