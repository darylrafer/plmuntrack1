/**
 * PLMunTrack Google Sheets backend
 *
 * Creates a daily QR token, validates Google login, records scans,
 * and stores student/visitor data in Google Sheets.
 *
 * SHEETS:
 *   People     = registered people / current daily QR record
 *   Attendance = every check-in/check-out event
 *   Audit      = QR creation + scan audit trail
 */

const SPREADSHEET_ID = 'PASTE_YOUR_GOOGLE_SHEET_ID_HERE';
const GOOGLE_CLIENT_ID = 'PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE';
const INSTITUTIONAL_EMAIL_DOMAIN = 'PASTE_PLmun_INSTITUTIONAL_DOMAIN_HERE';
const TIMEZONE = 'Asia/Manila';
const TOKEN_SECRET = 'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET';

function doGet() {
  return json_({ok:true,service:'PLMunTrack',message:'Google Sheets backend is online.'});
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const email = verifyGoogleIdToken_(body.idToken);
    switch (body.action) {
      case 'createQr': return json_(createQr_(email, body.person));
      case 'recordScan': return json_(recordScan_(email, body.token, body.scannerEmail));
      default: throw new Error('Unknown action.');
    }
  } catch (err) {
    return json_({ok:false,error:err.message || String(err)});
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function verifyGoogleIdToken_(idToken) {
  if (!idToken) throw new Error('Google login is required.');
  const url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken);
  const response = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
  if (response.getResponseCode() !== 200) throw new Error('Invalid Google login token.');
  const data = JSON.parse(response.getContentText());
  if (data.aud !== GOOGLE_CLIENT_ID) throw new Error('Google client ID does not match the backend configuration.');
  if (String(data.email_verified) !== 'true') throw new Error('Google email is not verified.');
  return String(data.email || '').toLowerCase();
}

function createQr_(adminEmail, person) {
  if (!person || !person.id || !person.name || !person.email || !person.type) throw new Error('Complete person information is required.');
  validateEmail_(person.type, person.email);

  const today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  const expiresAt = new Date(today + 'T23:59:59+08:00').getTime();
  const nonce = Utilities.getUuid();
  const payload = {t: person.id, d: today, n: nonce};
  payload.s = hmac_(JSON.stringify(payload));
  const token = Utilities.base64EncodeWebSafe(JSON.stringify(payload));

  const props = PropertiesService.getScriptProperties();
  props.setProperty('QR_' + person.id + '_' + today, JSON.stringify({
    token: token,
    person: person,
    createdBy: adminEmail,
    createdAt: Date.now(),
    expiresAt: expiresAt
  }));

  const ss = getSheet_();
  const people = getOrCreateSheet_(ss, 'People', [
    'Person ID','Type','Name','Email','Phone','Institution ID','Purpose','Host','QR Date','QR Token','QR Expires','Created By'
  ]);
  upsertPerson_(people, person, today, token, expiresAt, adminEmail);
  appendAudit_(ss, ['CREATE_QR', Date.now(), adminEmail, person.id, person.email, today]);

  return {ok:true,token:token,expiresAt:expiresAt,date:today,person:person};
}

function recordScan_(authEmail, token, scannerEmail) {
  if (!token) throw new Error('QR token is missing.');
  const payload = parseToken_(token);
  const today = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  if (payload.d !== today) throw new Error('This QR code is from another day and has expired.');

  const saved = PropertiesService.getScriptProperties().getProperty('QR_' + payload.t + '_' + payload.d);
  if (!saved) throw new Error('QR code is not registered for today. Generate a new daily QR code.');
  const qr = JSON.parse(saved);
  if (qr.token !== token) throw new Error('Invalid QR code.');
  if (Date.now() > qr.expiresAt) throw new Error('QR code has expired.');

  const person = qr.person;
  const ss = getSheet_();
  const attendance = getOrCreateSheet_(ss, 'Attendance', [
    'Timestamp','Date','Time','Person ID','Type','Name','Email','Institution ID','Purpose','Host','Action','Scanner Google Account','QR Date','QR Token'
  ]);

  const rows = attendance.getDataRange().getValues();
  let open = false;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][3]) === String(person.id)) {
      const action = String(rows[i][10]);
      if (action === 'CHECK_IN') { open = true; break; }
      if (action === 'CHECK_OUT') { open = false; break; }
    }
  }

  const now = new Date();
  const action = open ? 'CHECK_OUT' : 'CHECK_IN';
  const scanner = scannerEmail || authEmail;
  attendance.appendRow([
    now,
    Utilities.formatDate(now, TIMEZONE, 'yyyy-MM-dd'),
    Utilities.formatDate(now, TIMEZONE, 'HH:mm:ss'),
    person.id, person.type, person.name, person.email, person.institutionId || '',
    person.purpose || '', person.host || '', action, scanner, payload.d, token
  ]);

  appendAudit_(ss, ['SCAN', Date.now(), authEmail, person.id, person.email, action]);

  return {
    ok:true,
    action: action === 'CHECK_IN' ? 'check-in' : 'check-out',
    status: action === 'CHECK_IN' ? 'in' : 'out',
    timestamp: now.getTime(),
    checkin: action === 'CHECK_IN' ? now.getTime() : findOpenTime_(rows, person.id),
    checkout: action === 'CHECK_OUT' ? now.getTime() : null,
    duration: action === 'CHECK_OUT' ? durationFromRows_(rows, person.id, now) : null,
    person: person
  };
}

function parseToken_(token) {
  try {
    const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString());
    const copy = {t:payload.t,d:payload.d,n:payload.n};
    if (!payload.t || !payload.d || !payload.n || !payload.s) throw new Error('Malformed QR code.');
    if (hmac_(JSON.stringify(copy)) !== payload.s) throw new Error('QR signature mismatch.');
    return payload;
  } catch (err) {
    throw new Error('Invalid or tampered QR code.');
  }
}

function validateEmail_(type, email) {
  const domain = INSTITUTIONAL_EMAIL_DOMAIN.toLowerCase().replace(/^@/, '');
  const normalized = email.toLowerCase();
  const isInstitutional = normalized.endsWith('@' + domain);
  if (type === 'student' && !isInstitutional) throw new Error('Students must use their institutional school email.');
  if (type === 'visitor' && isInstitutional) throw new Error('Visitors must use a personal email address.');
}

function hmac_(text) {
  const bytes = Utilities.computeHmacSha256Signature(text, TOKEN_SECRET, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,'');
}

function getSheet_() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID.indexOf('PASTE_') === 0) throw new Error('Configure SPREADSHEET_ID in Code.gs first.');
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getOrCreateSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(headers);
  return sh;
}

function upsertPerson_(sh, person, date, token, expiresAt, adminEmail) {
  const values = sh.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(person.id)) {
      sh.getRange(i + 1, 1, 1, 12).setValues([[
        person.id, person.type, person.name, person.email, person.phone || '', person.institutionId || '',
        person.purpose || '', person.host || '', date, token, new Date(expiresAt), adminEmail
      ]]);
      return;
    }
  }
  sh.appendRow([person.id, person.type, person.name, person.email, person.phone || '', person.institutionId || '', person.purpose || '', person.host || '', date, token, new Date(expiresAt), adminEmail]);
}

function appendAudit_(ss, row) {
  const sh = getOrCreateSheet_(ss, 'Audit', ['Event','Timestamp','Google Account','Person ID','Email','Details']);
  sh.appendRow(row);
}

function findOpenTime_(rows, personId) {
  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][3]) === String(personId) && String(rows[i][10]) === 'CHECK_IN') return new Date(rows[i][0]).getTime();
  }
  return null;
}

function durationFromRows_(rows, personId, now) {
  const start = findOpenTime_(rows, personId);
  if (!start) return null;
  const mins = Math.max(0, Math.round((now.getTime() - start) / 60000));
  return mins < 60 ? mins + ' min' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
}
