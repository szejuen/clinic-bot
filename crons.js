// ════════════════════════════════════════════════════════════
//  Scheduled Jobs (Cron Tasks)
//
//  WF3: Send appointment reminders 24 hours before
//  WF4: Send review request 2 hours after appointment
//  WF6: Daily cleanup — release expired slot locks
//
//  All times in Singapore timezone (Asia/Singapore = UTC+8)
//  To add a new scheduled job: add a cron.schedule() call in startCrons()
// ════════════════════════════════════════════════════════════
const cron    = require('node-cron');
const dayjs   = require('dayjs');
const sheets  = require('./sheets');
const wa      = require('./whatsapp');

// ── Get all active clinic sheet IDs ──
// In MVP: just the master sheet from env.
// In production: load from a registry sheet with all clinic sheet IDs.
async function getAllClinicSheets() {
  // MVP: single clinic
  if (process.env.MASTER_SHEET_ID) {
    return [{ sheetId: process.env.MASTER_SHEET_ID, phoneId: process.env.WHATSAPP_PHONE_ID }];
  }
  return [];

  // Production (multiple clinics): uncomment and adapt:
  // const rows = await sheets.readRange(process.env.REGISTRY_SHEET_ID, 'Clinics!A:C');
  // return rows.slice(1).map(r => ({ sheetId: r[1], phoneId: r[2] }));
}

// ════════════════════════════════════
//  WF3: 24-Hour Appointment Reminders
//  Runs daily at 8:00 AM SGT
// ════════════════════════════════════
async function sendReminders() {
  console.log('⏰ [WF3] Running reminder job...');
  const tomorrow = dayjs().add(1, 'day').format('YYYY-MM-DD');
  const clinics = await getAllClinicSheets();

  for (const clinic of clinics) {
    try {
      const pending = await sheets.getPendingReminders(clinic.sheetId, tomorrow);
      console.log(`  → ${pending.length} reminders to send for clinic ${clinic.sheetId}`);

      for (let i = 0; i < pending.length; i++) {
        const r = pending[i];
        const rowIndex = i + 2; // approximate — adjust if needed

        // Send reminder using WhatsApp Template (must be pre-approved by Meta)
        // Template name: "appointment_reminder"
        // Template variables: {{1}}=name, {{2}}=service, {{3}}=date, {{4}}=time
        await wa.sendTemplate(
          clinic.phoneId,
          r[1], // patient phone
          'appointment_reminder',
          [
            { type: 'body', parameters: [
              { type: 'text', text: r[2] || 'there' },   // name
              { type: 'text', text: r[3] || '' },         // service
              { type: 'text', text: dayjs(r[4]).format('ddd, D MMM YYYY') }, // date
              { type: 'text', text: r[5] || '' },         // time
            ]},
          ]
        );

        await sheets.markReminderSent(clinic.sheetId, rowIndex);

        // Small delay between messages to avoid rate limits
        await new Promise(res => setTimeout(res, 500));
      }
    } catch (err) {
      console.error(`❌ [WF3] Error for clinic ${clinic.sheetId}:`, err.message);
    }
  }
}

// ════════════════════════════════════
//  WF4: Post-Visit Review Requests
//  Runs daily at 6:00 PM SGT
//  Sends to patients whose appointment was today
// ════════════════════════════════════
async function sendReviewRequests() {
  console.log('⭐ [WF4] Running review request job...');
  const today = dayjs().format('YYYY-MM-DD');
  const clinics = await getAllClinicSheets();

  for (const clinic of clinics) {
    try {
      // Read completed appointments for today
      const rows = await sheets.readRange(clinic.sheetId, 'Appointments!A:I');
      const todaysAppts = rows.slice(1).filter(r =>
        r[4] === today && r[7] === 'CONFIRMED'
      );

      console.log(`  → ${todaysAppts.length} review requests to send`);

      for (const appt of todaysAppts) {
        // Template name: "review_request" (must be pre-approved)
        // Template variable: {{1}} = patient name or "there"
        await wa.sendTemplate(
          clinic.phoneId,
          appt[1], // patient phone
          'review_request',
          [
            { type: 'body', parameters: [
              { type: 'text', text: appt[2] || 'there' }, // name
            ]},
          ]
        );

        await new Promise(res => setTimeout(res, 500));
      }
    } catch (err) {
      console.error(`❌ [WF4] Error for clinic ${clinic.sheetId}:`, err.message);
    }
  }
}

// ════════════════════════════════════
//  WF6: Daily Slot Cleanup
//  Runs every 15 minutes
//  Releases PENDING slot locks that have expired (>10 min)
// ════════════════════════════════════
async function cleanupExpiredLocks() {
  const clinics = await getAllClinicSheets();
  const now = new Date();

  for (const clinic of clinics) {
    try {
      const rows = await sheets.readRange(clinic.sheetId, 'Slots!A:F');

      for (let i = 1; i < rows.length; i++) {
        if (rows[i][3] === 'PENDING' && rows[i][5]) {
          const lockExpiry = new Date(rows[i][5]);
          if (lockExpiry < now) {
            // Expired lock — release back to OPEN
            await sheets.updateRow(clinic.sheetId, `Slots!D${i+1}:F${i+1}`, ['OPEN', '', '']);
            console.log(`🔓 Released expired slot: ${rows[i][0]} ${rows[i][1]}`);
          }
        }
      }
    } catch (err) {
      console.error(`❌ [WF6] Cleanup error:`, err.message);
    }
  }
}

// ════════════════════════════════════
//  START ALL SCHEDULED JOBS
//  Called from server.js on startup
// ════════════════════════════════════
function startCrons() {
  // WF3: Daily reminders at 8:00 AM Singapore time
  cron.schedule('0 8 * * *', sendReminders, { timezone: 'Asia/Singapore' });
  console.log('✅ WF3: Reminder job scheduled (8:00 AM SGT daily)');

  // WF4: Review requests at 6:00 PM Singapore time
  cron.schedule('0 18 * * *', sendReviewRequests, { timezone: 'Asia/Singapore' });
  console.log('✅ WF4: Review request job scheduled (6:00 PM SGT daily)');

  // WF6: Slot cleanup every 15 minutes
  cron.schedule('*/15 * * * *', cleanupExpiredLocks);
  console.log('✅ WF6: Slot cleanup scheduled (every 15 minutes)');
}

module.exports = { startCrons, sendReminders, sendReviewRequests, cleanupExpiredLocks };
