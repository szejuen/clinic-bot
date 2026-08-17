// ════════════════════════════════════════════════════════════
//  Google Sheets API  —  Helper Functions
//  All database reads/writes go through this file.
//  Each clinic has its own Google Sheet (multi-tenant).
// ════════════════════════════════════════════════════════════
const { google } = require('googleapis');

// ── Authenticate once, reuse the client ──
let _sheetsClient = null;

function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      // Render stores env vars as strings; replace escaped newlines
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// ── LOW-LEVEL: Read a range from a sheet ──
// range example: 'Sessions!A:F'
async function readRange(spreadsheetId, range) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

// ── LOW-LEVEL: Append a row to a sheet ──
async function appendRow(spreadsheetId, range, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

// ── LOW-LEVEL: Update a specific row by row number ──
async function updateRow(spreadsheetId, range, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
}

// ── LOW-LEVEL: Clear a specific row ──
async function clearRow(spreadsheetId, range) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.clear({ spreadsheetId, range });
}

// ════════════════════════════════════════════
//  HIGH-LEVEL: Session Management (WF1 State)
// ════════════════════════════════════════════
// Sessions tab columns: A=phone, B=state, C=context(JSON), D=last_updated

async function getSession(sheetId, phone) {
  const rows = await readRange(sheetId, 'Sessions!A:D');
  for (let i = 1; i < rows.length; i++) { // skip header row
    if (rows[i][0] === phone) {
      return {
        rowIndex: i + 1, // 1-based for Sheets API
        phone:    rows[i][0],
        state:    rows[i][1] || 'IDLE',
        context:  rows[i][2] ? JSON.parse(rows[i][2]) : {},
        updated:  rows[i][3],
      };
    }
  }
  return null; // No session found
}

async function saveSession(sheetId, phone, state, context, existingRowIndex = null) {
  const now = new Date().toISOString();
  const values = [phone, state, JSON.stringify(context), now];

  if (existingRowIndex) {
    await updateRow(sheetId, `Sessions!A${existingRowIndex}:D${existingRowIndex}`, values);
  } else {
    await appendRow(sheetId, 'Sessions!A:D', values);
  }
}

async function deleteSession(sheetId, phone, rowIndex) {
  if (rowIndex) {
    await clearRow(sheetId, `Sessions!A${rowIndex}:D${rowIndex}`);
  }
}

// ════════════════════════════════════════
//  HIGH-LEVEL: Services
// ════════════════════════════════════════
// Services tab columns: A=name, B=duration_min, C=price_sgd, D=active

async function getServices(sheetId) {
  const rows = await readRange(sheetId, 'Services!A:D');
  return rows.slice(1) // skip header
    .filter(r => r[3]?.toLowerCase() !== 'no') // only active services
    .map((r, i) => ({
      index:    i + 1,
      name:     r[0] || '',
      duration: parseInt(r[1]) || 30,
      price:    parseFloat(r[2]) || 0,
    }));
}

// ════════════════════════════════════════
//  HIGH-LEVEL: Slots / Availability
// ════════════════════════════════════════
// Slots tab columns: A=date, B=time, C=staff, D=status(OPEN/PENDING/CONFIRMED), E=booking_id, F=locked_until

async function getAvailableSlots(sheetId, date) {
  const rows = await readRange(sheetId, 'Slots!A:F');
  const now = new Date();

  return rows.slice(1)
    .filter(r => {
      if (r[0] !== date) return false;
      if (r[3] === 'CONFIRMED') return false;
      // Release expired PENDING locks
      if (r[3] === 'PENDING' && r[5] && new Date(r[5]) < now) return true;
      if (r[3] === 'PENDING') return false;
      return true; // OPEN
    })
    .map((r, i) => ({
      rowIndex: i + 2, // approximate — recalculated below
      date:  r[0],
      time:  r[1],
      staff: r[2],
      status: r[3],
    }));
}

// Lock a slot for 10 minutes (PENDING) while patient confirms
async function lockSlot(sheetId, date, time) {
  const rows = await readRange(sheetId, 'Slots!A:F');
  const now = new Date();
  const lockUntil = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // +10 min

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === date && rows[i][1] === time && rows[i][3] === 'OPEN') {
      const rowNum = i + 1;
      await updateRow(sheetId, `Slots!D${rowNum}:F${rowNum}`, ['PENDING', '', lockUntil]);
      return { rowNum, staff: rows[i][2] };
    }
  }
  return null; // Slot no longer available
}

// Confirm a slot after patient says Yes
async function confirmSlot(sheetId, slotRow, bookingId) {
  await updateRow(sheetId, `Slots!D${slotRow}:F${slotRow}`, ['CONFIRMED', bookingId, '']);
}

// Release a slot (cancellation)
async function releaseSlot(sheetId, date, time) {
  const rows = await readRange(sheetId, 'Slots!A:F');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === date && rows[i][1] === time) {
      await updateRow(sheetId, `Slots!D${i+1}:F${i+1}`, ['OPEN', '', '']);
      return;
    }
  }
}

// ════════════════════════════════════════
//  HIGH-LEVEL: Appointments
// ════════════════════════════════════════
// Appointments tab: A=id, B=phone, C=name, D=service, E=date, F=time, G=staff, H=status, I=created_at

async function createAppointment(sheetId, data) {
  const id = `APT-${Date.now()}`;
  await appendRow(sheetId, 'Appointments!A:I', [
    id,
    data.phone,
    data.name     || '',
    data.service  || '',
    data.date     || '',
    data.time     || '',
    data.staff    || '',
    'CONFIRMED',
    new Date().toISOString(),
  ]);
  return id;
}

async function getAppointment(sheetId, phone) {
  const rows = await readRange(sheetId, 'Appointments!A:I');
  // Return latest confirmed appointment for this phone
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][1] === phone && rows[i][7] === 'CONFIRMED') {
      return {
        rowIndex: i + 1,
        id:      rows[i][0],
        phone:   rows[i][1],
        name:    rows[i][2],
        service: rows[i][3],
        date:    rows[i][4],
        time:    rows[i][5],
        staff:   rows[i][6],
        status:  rows[i][7],
      };
    }
  }
  return null;
}

async function cancelAppointment(sheetId, rowIndex) {
  const rows = await readRange(sheetId, `Appointments!H${rowIndex}:H${rowIndex}`);
  await updateRow(sheetId, `Appointments!H${rowIndex}`, ['CANCELLED']);
}

// ════════════════════════════════════════
//  HIGH-LEVEL: Patients
// ════════════════════════════════════════
// Patients tab: A=phone, B=name, C=email, D=dob, E=first_visit, F=last_visit, G=visit_count, H=opted_in_marketing

async function upsertPatient(sheetId, phone, name) {
  const rows = await readRange(sheetId, 'Patients!A:H');
  const today = new Date().toISOString().split('T')[0];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone) {
      // Update last_visit and visit_count
      const count = parseInt(rows[i][6] || 0) + 1;
      await updateRow(sheetId, `Patients!F${i+1}:G${i+1}`, [today, count]);
      return;
    }
  }

  // New patient
  await appendRow(sheetId, 'Patients!A:H', [phone, name, '', '', today, today, 1, 'YES']);
}

// ════════════════════════════════════════
//  HIGH-LEVEL: Clinic Config
// ════════════════════════════════════════
// Config tab: A=key, B=value
// Keys: clinic_name, clinic_phone, opening_hours, whatsapp_phone_id, sheet_id

async function getConfig(sheetId) {
  const rows = await readRange(sheetId, 'Config!A:B');
  const config = {};
  rows.slice(1).forEach(r => { if (r[0]) config[r[0]] = r[1]; });
  return config;
}

// ════════════════════════════════════════
//  HIGH-LEVEL: Reminders Queue
// ════════════════════════════════════════
// Reminders tab: A=appointment_id, B=phone, C=name, D=service, E=date, F=time, G=status, H=sent_at

async function getPendingReminders(sheetId, targetDate) {
  const rows = await readRange(sheetId, 'Reminders!A:H');
  return rows.slice(1).filter(r => r[4] === targetDate && r[6] !== 'SENT');
}

async function markReminderSent(sheetId, rowIndex) {
  await updateRow(sheetId, `Reminders!G${rowIndex}:H${rowIndex}`, ['SENT', new Date().toISOString()]);
}

module.exports = {
  readRange, appendRow, updateRow,
  getSession, saveSession, deleteSession,
  getServices,
  getAvailableSlots, lockSlot, confirmSlot, releaseSlot,
  createAppointment, getAppointment, cancelAppointment,
  upsertPatient,
  getConfig,
  getPendingReminders, markReminderSent,
};
