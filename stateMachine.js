// ════════════════════════════════════════════════════════════
//  WF1  —  Session State Machine  (THE BRAIN OF THE BOT)
//
//  STATE FLOW:
//
//  IDLE ──► GREETING ──► SERVICE_SELECT ──► DATE_SELECT
//                                               │
//                                          TIME_SELECT
//                                               │
//                                            CONFIRM
//                                               │
//                                    ┌── YES ──►CONFIRMED ──► (done)
//                                    └── NO  ──► IDLE (restart)
//
//  From CONFIRMED:
//    "cancel"     ──► CANCEL_CONFIRM ──► YES → CANCELLED
//    "reschedule" ──► RESCHEDULE_DATE ──► RESCHEDULE_TIME ──► RESCHEDULE_CONFIRM
//
//  TO ADD A NEW FEATURE: Add a new state constant below,
//  add a handler in HANDLERS, and update transitions as needed.
// ════════════════════════════════════════════════════════════
const dayjs = require('dayjs');
const sheets = require('./sheets');
const wa     = require('./whatsapp');

// ── State Constants (add new states here) ──
const STATES = {
  IDLE:               'IDLE',
  GREETING:           'GREETING',
  SERVICE_SELECT:     'SERVICE_SELECT',
  DATE_SELECT:        'DATE_SELECT',
  TIME_SELECT:        'TIME_SELECT',
  CONFIRM:            'CONFIRM',
  CONFIRMED:          'CONFIRMED',
  CANCEL_CONFIRM:     'CANCEL_CONFIRM',
  RESCHEDULE_DATE:    'RESCHEDULE_DATE',
  RESCHEDULE_TIME:    'RESCHEDULE_TIME',
  RESCHEDULE_CONFIRM: 'RESCHEDULE_CONFIRM',
};

// ── Clinic sheet lookup: phone number → sheet ID ──
// When you onboard a new clinic, add their WhatsApp phone ID and sheet ID here.
// Or load this from a master registry sheet if you have many clinics.
function getClinicSheetId(phoneId) {
  const registry = {
    // 'WHATSAPP_PHONE_ID': 'GOOGLE_SHEET_ID',
    // Example:
    // '123456789012345': '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
  };

  // Fallback to env var for single-clinic setup (MVP phase)
  return registry[phoneId] || process.env.MASTER_SHEET_ID;
}

// ── Date helpers ──
function isValidDate(str) {
  // Accepts: "25 Jan", "25/1", "25-01-2025", "tomorrow", "Monday" etc.
  const parsed = dayjs(str, ['D MMM', 'D/M', 'D-M-YYYY', 'YYYY-MM-DD'], true);
  if (parsed.isValid() && parsed.isAfter(dayjs().subtract(1, 'day'))) return parsed;

  const lower = str.toLowerCase().trim();
  if (lower === 'tomorrow') return dayjs().add(1, 'day');
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const dayIdx = days.indexOf(lower);
  if (dayIdx !== -1) {
    let d = dayjs().day(dayIdx);
    if (d.isBefore(dayjs(), 'day')) d = d.add(7, 'day');
    return d;
  }
  return null;
}

function formatDate(dayjsObj) { return dayjsObj.format('YYYY-MM-DD'); }
function displayDate(str)     { return dayjs(str).format('ddd, D MMM YYYY'); }

// ═══════════════════════════════════════════
//  STATE HANDLERS
//  Each handler receives: { phoneId, from, text, session, sheetId }
//  Each handler must call saveSession and send a reply.
// ═══════════════════════════════════════════

const HANDLERS = {

  // ── IDLE / No session: send welcome greeting ──
  [STATES.IDLE]: async ({ phoneId, from, text, sheetId }) => {
    const config = await sheets.getConfig(sheetId);
    const clinicName = config.clinic_name || 'our clinic';

    await wa.sendButtons(phoneId, from,
      `👋 Hi! Welcome to *${clinicName}*.\n\nHow can I help you today?`,
      [
        { id: 'book',        title: '📅 Book Appointment' },
        { id: 'my_booking',  title: '🔍 My Booking' },
        { id: 'help',        title: '❓ Help' },
      ]
    );

    await sheets.saveSession(sheetId, from, STATES.GREETING, {});
  },

  // ── GREETING: process what they chose ──
  [STATES.GREETING]: async ({ phoneId, from, text, session, sheetId }) => {
    const lower = text.toLowerCase();

    if (lower.includes('book') || lower === 'book') {
      // Load services from sheet
      const services = await sheets.getServices(sheetId);

      if (services.length === 0) {
        await wa.sendText(phoneId, from, '⚠️ No services are available at the moment. Please call us directly.');
        await sheets.deleteSession(sheetId, from, session.rowIndex);
        return;
      }

      const sections = [{
        title: 'Our Services',
        rows: services.map(s => ({
          id:          `svc_${s.index}`,
          title:       s.name.substring(0, 24),
          description: `${s.duration} min • SGD ${s.price.toFixed(2)}`,
        })),
      }];

      await wa.sendList(phoneId, from,
        '🏥 Book an Appointment',
        'Please select the service you need:',
        'View Services',
        sections
      );

      await sheets.saveSession(sheetId, from, STATES.SERVICE_SELECT, { services }, session.rowIndex);

    } else if (lower.includes('booking') || lower.includes('appointment') || lower === 'my_booking') {
      // Check existing booking
      const appt = await sheets.getAppointment(sheetId, from);
      if (appt) {
        await wa.sendButtons(phoneId, from,
          `📋 *Your Appointment*\n\n` +
          `Service: ${appt.service}\n` +
          `Date: ${displayDate(appt.date)}\n` +
          `Time: ${appt.time}\n` +
          `Staff: ${appt.staff || 'Any available'}\n\n` +
          `What would you like to do?`,
          [
            { id: 'reschedule', title: '🔄 Reschedule' },
            { id: 'cancel',     title: '❌ Cancel' },
            { id: 'done',       title: '✅ Nothing, Thanks' },
          ]
        );
        await sheets.saveSession(sheetId, from, STATES.CONFIRMED, { appointment: appt }, session.rowIndex);
      } else {
        await wa.sendText(phoneId, from, `I couldn't find an upcoming appointment for your number.\n\nWould you like to book one? Just type *book*.`);
        await sheets.deleteSession(sheetId, from, session.rowIndex);
      }

    } else if (lower === 'help' || lower.includes('help')) {
      const config = await sheets.getConfig(sheetId);
      await wa.sendText(phoneId, from,
        `ℹ️ *Help*\n\n` +
        `• Type *book* to book an appointment\n` +
        `• Type *my booking* to view or change your appointment\n` +
        `• Type *cancel* to cancel your appointment\n` +
        `• Type *reschedule* to change your appointment date/time\n\n` +
        `📞 Call us: ${config.clinic_phone || 'see clinic signage'}\n` +
        `🕐 Hours: ${config.opening_hours || 'Mon–Fri 9am–6pm'}`
      );
      await sheets.deleteSession(sheetId, from, session.rowIndex);

    } else {
      await wa.sendText(phoneId, from, `Sorry, I didn't understand that. Please type *book*, *my booking*, or *help*.`);
    }
  },

  // ── SERVICE_SELECT: patient picked a service ──
  [STATES.SERVICE_SELECT]: async ({ phoneId, from, text, session, sheetId }) => {
    const { services } = session.context;

    // Match by list reply ID (svc_1, svc_2...) or by name text
    let chosen = null;
    if (text.startsWith('svc_')) {
      const idx = parseInt(text.replace('svc_', '')) - 1;
      chosen = services[idx];
    } else {
      chosen = services.find(s => s.name.toLowerCase().includes(text.toLowerCase()));
    }

    if (!chosen) {
      await wa.sendText(phoneId, from, `I couldn't match that to a service. Please tap one from the list, or type the service name.`);
      return; // Stay in SERVICE_SELECT
    }

    await wa.sendText(phoneId, from,
      `Great choice! *${chosen.name}* (${chosen.duration} min).\n\n` +
      `📅 What date would you like?\n\n` +
      `You can type:\n• *Tomorrow*\n• *Monday* (next Monday)\n• *25 Jan*\n• *2025-01-25*`
    );

    await sheets.saveSession(sheetId, from, STATES.DATE_SELECT, { service: chosen }, session.rowIndex);
  },

  // ── DATE_SELECT: patient typed a date ──
  [STATES.DATE_SELECT]: async ({ phoneId, from, text, session, sheetId }) => {
    const parsed = isValidDate(text);

    if (!parsed) {
      await wa.sendText(phoneId, from,
        `I couldn't understand that date. Please try:\n• *Tomorrow*\n• *Monday*\n• *25 Jan*`
      );
      return; // Stay in DATE_SELECT
    }

    const dateStr = formatDate(parsed);
    const slots = await sheets.getAvailableSlots(sheetId, dateStr);

    if (slots.length === 0) {
      await wa.sendButtons(phoneId, from,
        `😔 Sorry, no slots available on *${displayDate(dateStr)}*.\n\nWould you like to try another date?`,
        [
          { id: 'try_another', title: '📅 Try Another Date' },
          { id: 'cancel_book', title: '❌ Cancel' },
        ]
      );
      return; // Stay in DATE_SELECT (patient will pick another date or cancel)
    }

    // Show available times as buttons or list
    const timeRows = slots.slice(0, 10).map(s => ({
      id:    `time_${s.time.replace(':', '')}`,
      title: s.time,
      description: s.staff ? `with ${s.staff}` : 'Any available staff',
    }));

    await wa.sendList(phoneId, from,
      `📅 ${displayDate(dateStr)}`,
      `${slots.length} slot(s) available. Please choose a time:`,
      'View Times',
      [{ title: 'Available Times', rows: timeRows }]
    );

    await sheets.saveSession(sheetId, from, STATES.TIME_SELECT,
      { ...session.context, date: dateStr, slots },
      session.rowIndex
    );
  },

  // ── TIME_SELECT: patient picked a time ──
  [STATES.TIME_SELECT]: async ({ phoneId, from, text, session, sheetId }) => {
    const { date, slots, service } = session.context;

    // Extract time from list reply ID or plain text
    let time = '';
    if (text.startsWith('time_')) {
      const raw = text.replace('time_', '');
      time = raw.substring(0, 2) + ':' + raw.substring(2); // "0900" → "09:00"
    } else {
      // Try to match plain text e.g. "9am", "09:00", "9:00"
      const match = text.match(/(\d{1,2})[:\s]?(\d{2})?\s*(am|pm)?/i);
      if (match) {
        let h = parseInt(match[1]);
        const m = match[2] ? parseInt(match[2]) : 0;
        if (match[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
        time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      }
    }

    const slot = slots.find(s => s.time === time);
    if (!slot) {
      await wa.sendText(phoneId, from, `I couldn't match that time. Please tap one of the available times from the list.`);
      return; // Stay in TIME_SELECT
    }

    // Lock the slot for 10 minutes
    const locked = await sheets.lockSlot(sheetId, date, time);
    if (!locked) {
      await wa.sendText(phoneId, from, `😔 Sorry, that slot was just taken. Please choose another time.`);
      // Reload slots
      const freshSlots = await sheets.getAvailableSlots(sheetId, date);
      await sheets.saveSession(sheetId, from, STATES.TIME_SELECT,
        { ...session.context, slots: freshSlots }, session.rowIndex);
      return;
    }

    await wa.sendButtons(phoneId, from,
      `✅ *Please Confirm Your Booking*\n\n` +
      `🏥 Service: ${service.name}\n` +
      `📅 Date: ${displayDate(date)}\n` +
      `⏰ Time: ${time}\n` +
      `👤 Staff: ${locked.staff || 'Any available'}\n` +
      `💰 Price: SGD ${service.price.toFixed(2)}\n\n` +
      `⏳ This slot is held for *10 minutes*.`,
      [
        { id: 'confirm_yes', title: '✅ Confirm' },
        { id: 'confirm_no',  title: '❌ Change' },
      ]
    );

    await sheets.saveSession(sheetId, from, STATES.CONFIRM,
      { ...session.context, time, staff: locked.staff, slotRow: locked.rowNum },
      session.rowIndex
    );
  },

  // ── CONFIRM: patient says yes or no ──
  [STATES.CONFIRM]: async ({ phoneId, from, text, session, sheetId }) => {
    const { date, time, service, staff, slotRow } = session.context;
    const lower = text.toLowerCase();

    if (lower.includes('confirm') || lower.includes('yes') || lower === 'confirm_yes') {
      // Create the appointment
      const apptId = await sheets.createAppointment(sheetId, {
        phone: from, name: '', service: service.name, date, time, staff,
      });

      // Confirm the slot in Slots tab
      await sheets.confirmSlot(sheetId, slotRow, apptId);

      // Update patient record
      await sheets.upsertPatient(sheetId, from, '');

      await wa.sendText(phoneId, from,
        `🎉 *Booking Confirmed!*\n\n` +
        `📋 Booking ID: ${apptId}\n` +
        `🏥 ${service.name}\n` +
        `📅 ${displayDate(date)} at ${time}\n\n` +
        `We'll send you a reminder 24 hours before.\n\n` +
        `To cancel or reschedule, type *my booking* anytime.`
      );

      await sheets.saveSession(sheetId, from, STATES.CONFIRMED, { appointment: { id: apptId, service: service.name, date, time, staff } }, session.rowIndex);

    } else if (lower.includes('no') || lower.includes('change') || lower === 'confirm_no') {
      // Release the slot lock
      await sheets.releaseSlot(sheetId, date, time);

      await wa.sendText(phoneId, from, `No problem! Let's start over.\n\nWhat service would you like to book?`);

      // Re-fetch services and go back to SERVICE_SELECT
      const services = await sheets.getServices(sheetId);
      const sections = [{ title: 'Our Services', rows: services.map(s => ({
        id: `svc_${s.index}`, title: s.name.substring(0,24), description: `${s.duration} min • SGD ${s.price.toFixed(2)}`
      })) }];
      await wa.sendList(phoneId, from, '🏥 Book an Appointment', 'Select a service:', 'View Services', sections);
      await sheets.saveSession(sheetId, from, STATES.SERVICE_SELECT, { services }, session.rowIndex);

    } else {
      await wa.sendText(phoneId, from, `Please tap ✅ Confirm or ❌ Change.`);
    }
  },

  // ── CONFIRMED: patient has a booking — handle cancel / reschedule ──
  [STATES.CONFIRMED]: async ({ phoneId, from, text, session, sheetId }) => {
    const lower = text.toLowerCase();

    if (lower.includes('cancel') || lower === 'cancel') {
      const appt = session.context.appointment;
      await wa.sendButtons(phoneId, from,
        `❌ Are you sure you want to cancel?\n\n${appt?.service} on ${appt?.date ? displayDate(appt.date) : ''} at ${appt?.time || ''}`,
        [
          { id: 'cancel_yes', title: '✅ Yes, Cancel' },
          { id: 'cancel_no',  title: '❌ Keep Booking' },
        ]
      );
      await sheets.saveSession(sheetId, from, STATES.CANCEL_CONFIRM, session.context, session.rowIndex);

    } else if (lower.includes('reschedule') || lower === 'reschedule') {
      await wa.sendText(phoneId, from,
        `🔄 *Reschedule*\n\nWhat new date would you like?\n\n• Tomorrow\n• Monday\n• 25 Jan`
      );
      await sheets.saveSession(sheetId, from, STATES.RESCHEDULE_DATE, session.context, session.rowIndex);

    } else {
      await wa.sendButtons(phoneId, from,
        `How can I help you?`,
        [
          { id: 'reschedule', title: '🔄 Reschedule' },
          { id: 'cancel',     title: '❌ Cancel' },
          { id: 'help',       title: '❓ Help' },
        ]
      );
    }
  },

  // ── CANCEL_CONFIRM ──
  [STATES.CANCEL_CONFIRM]: async ({ phoneId, from, text, session, sheetId }) => {
    const lower = text.toLowerCase();

    if (lower.includes('yes') || lower === 'cancel_yes') {
      const appt = session.context.appointment;
      if (appt?.rowIndex) {
        await sheets.cancelAppointment(sheetId, appt.rowIndex);
        await sheets.releaseSlot(sheetId, appt.date, appt.time);
      }
      await wa.sendText(phoneId, from,
        `✅ Your appointment has been cancelled.\n\nType *book* anytime to make a new booking.`
      );
      await sheets.deleteSession(sheetId, from, session.rowIndex);

    } else {
      await wa.sendText(phoneId, from, `✅ Your booking is kept. See you then! 😊`);
      await sheets.saveSession(sheetId, from, STATES.CONFIRMED, session.context, session.rowIndex);
    }
  },

  // ── RESCHEDULE_DATE ──
  [STATES.RESCHEDULE_DATE]: async ({ phoneId, from, text, session, sheetId }) => {
    const parsed = isValidDate(text);
    if (!parsed) {
      await wa.sendText(phoneId, from, `I couldn't understand that date. Try: *Tomorrow*, *Monday*, or *25 Jan*.`);
      return;
    }

    const dateStr = formatDate(parsed);
    const slots = await sheets.getAvailableSlots(sheetId, dateStr);

    if (slots.length === 0) {
      await wa.sendText(phoneId, from, `😔 No slots on ${displayDate(dateStr)}. Please try another date.`);
      return;
    }

    const timeRows = slots.slice(0, 10).map(s => ({
      id: `time_${s.time.replace(':','')}`, title: s.time,
      description: s.staff ? `with ${s.staff}` : 'Any available',
    }));

    await wa.sendList(phoneId, from, `📅 ${displayDate(dateStr)}`, 'Choose a new time:', 'View Times',
      [{ title: 'Available Times', rows: timeRows }]
    );

    await sheets.saveSession(sheetId, from, STATES.RESCHEDULE_TIME,
      { ...session.context, newDate: dateStr, slots }, session.rowIndex);
  },

  // ── RESCHEDULE_TIME ──
  [STATES.RESCHEDULE_TIME]: async ({ phoneId, from, text, session, sheetId }) => {
    const { newDate, slots, appointment } = session.context;

    let time = '';
    if (text.startsWith('time_')) {
      const raw = text.replace('time_', '');
      time = raw.substring(0,2) + ':' + raw.substring(2);
    } else {
      const match = text.match(/(\d{1,2})[:\s]?(\d{2})?\s*(am|pm)?/i);
      if (match) {
        let h = parseInt(match[1]);
        const m = match[2] ? parseInt(match[2]) : 0;
        if (match[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
        time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      }
    }

    const slot = slots?.find(s => s.time === time);
    if (!slot) {
      await wa.sendText(phoneId, from, `Please tap one of the available times.`);
      return;
    }

    const locked = await sheets.lockSlot(sheetId, newDate, time);
    if (!locked) {
      await wa.sendText(phoneId, from, `That slot was just taken. Please choose another.`);
      return;
    }

    await wa.sendButtons(phoneId, from,
      `🔄 *Confirm Reschedule*\n\n` +
      `Old: ${appointment?.date ? displayDate(appointment.date) : ''} at ${appointment?.time || ''}\n` +
      `New: ${displayDate(newDate)} at ${time}\n\n` +
      `⏳ Held for 10 minutes.`,
      [
        { id: 'reschedule_yes', title: '✅ Confirm' },
        { id: 'reschedule_no',  title: '❌ Cancel' },
      ]
    );

    await sheets.saveSession(sheetId, from, STATES.RESCHEDULE_CONFIRM,
      { ...session.context, newTime: time, newStaff: locked.staff, newSlotRow: locked.rowNum },
      session.rowIndex
    );
  },

  // ── RESCHEDULE_CONFIRM ──
  [STATES.RESCHEDULE_CONFIRM]: async ({ phoneId, from, text, session, sheetId }) => {
    const lower = text.toLowerCase();
    const { appointment, newDate, newTime, newStaff, newSlotRow } = session.context;

    if (lower.includes('confirm') || lower.includes('yes') || lower === 'reschedule_yes') {
      // Release old slot
      if (appointment?.date && appointment?.time) {
        await sheets.releaseSlot(sheetId, appointment.date, appointment.time);
      }

      // Confirm new slot
      await sheets.confirmSlot(sheetId, newSlotRow, appointment?.id || '');

      // Update appointment row if we have it
      await wa.sendText(phoneId, from,
        `✅ *Rescheduled!*\n\n` +
        `📅 ${displayDate(newDate)} at ${newTime}\n\n` +
        `We'll send a new reminder 24 hours before. See you then! 😊`
      );

      await sheets.saveSession(sheetId, from, STATES.CONFIRMED,
        { appointment: { ...appointment, date: newDate, time: newTime, staff: newStaff } },
        session.rowIndex
      );

    } else {
      // Cancel reschedule — release new slot lock
      await sheets.releaseSlot(sheetId, newDate, newTime);
      await wa.sendText(phoneId, from, `✅ Reschedule cancelled. Your original booking is kept.`);
      await sheets.saveSession(sheetId, from, STATES.CONFIRMED,
        { appointment }, session.rowIndex);
    }
  },
};

// ═══════════════════════════════════════════
//  MAIN ENTRY POINT
//  Called by server.js for every incoming message
// ═══════════════════════════════════════════
async function handleMessage({ phoneId, from, text, messageId }) {

  // Get which clinic's sheet to use
  const sheetId = getClinicSheetId(phoneId);
  if (!sheetId) {
    console.error(`❌ No sheet ID for phone ID: ${phoneId}`);
    return;
  }

  // Load current session (or null if none)
  let session = await sheets.getSession(sheetId, from);

  // Check for expired sessions (>30 min idle = restart)
  if (session && session.updated) {
    const idleMinutes = (Date.now() - new Date(session.updated).getTime()) / 60000;
    if (idleMinutes > 30 && session.state !== STATES.CONFIRMED) {
      await sheets.deleteSession(sheetId, from, session.rowIndex);
      session = null;
    }
  }

  // Determine current state
  const state = session?.state || STATES.IDLE;

  // Global override: typing "hi", "hello", "start", "menu" always restarts
  const lower = text.toLowerCase().trim();
  const isRestart = ['hi','hello','start','menu','restart','back'].includes(lower);
  if (isRestart && state !== STATES.IDLE) {
    if (session?.context?.slotRow) {
      // Release any pending slot lock before restarting
      await sheets.releaseSlot(sheetId,
        session.context.date || session.context.newDate,
        session.context.time || session.context.newTime
      ).catch(() => {});
    }
    await sheets.deleteSession(sheetId, from, session?.rowIndex);
    session = null;
  }

  // Get the handler for the current state
  const handler = HANDLERS[isRestart ? STATES.IDLE : state] || HANDLERS[STATES.IDLE];

  try {
    await handler({ phoneId, from, text, session, sheetId });
  } catch (err) {
    console.error(`❌ State machine error [${state}]:`, err.message);
    // Send a graceful fallback message
    await wa.sendText(phoneId, from,
      `😔 Something went wrong on our end. Please try again or type *hi* to restart.\n\nIf the problem persists, please call us directly.`
    );
  }
}

module.exports = { handleMessage, STATES };
