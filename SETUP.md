# PLMunTrack Google Sheets + Daily QR Setup

This version changes the QR flow from browser-only demo storage to a Google-backed workflow:

- **Students:** use their institutional school email.
- **Visitors:** use their personal email.
- **QR codes:** a new signed QR is generated for each person every day and expires at the end of that day.
- **Scanner:** your phone can open `scanner.html`, use the rear camera, scan the QR, and send the scan to Google Sheets.
- **Attendance:** the first scan becomes CHECK_IN; the next scan for the same person becomes CHECK_OUT.
- **Excel:** Google Sheets can be downloaded as `.xlsx` after the records are collected.
- **Audit:** the Google account used by the scanner is recorded with each scan.

## 1. Create the Google Sheet

Create one Google Sheet for PLMunTrack. Copy its spreadsheet ID from the URL:

`https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`

Put that value in `google-apps-script/Code.gs` as `SPREADSHEET_ID`.

The Apps Script automatically creates these tabs:

- `People`
- `Attendance`
- `Audit`

## 2. Create Google OAuth credentials

In Google Cloud Console:

1. Create/select a Google Cloud project.
2. Configure the OAuth consent screen.
3. Create an **OAuth Client ID → Web application**.
4. Add your website origin to **Authorized JavaScript origins**.
5. Copy the Web Client ID.
6. Put it in BOTH:
   - `GOOGLE_CLIENT_ID` in `google-apps-script/Code.gs`
   - `GOOGLE_CLIENT_ID` near the top of `js/script.js`

Do not put a client secret in the website.

## 3. Set the institutional email domain

In `google-apps-script/Code.gs`, change:

`INSTITUTIONAL_EMAIL_DOMAIN = 'PASTE_PLmun_INSTITUTIONAL_DOMAIN_HERE';`

to the exact domain used by PLMUN student accounts, for example:

`example.edu.ph`

Do not guess this value; confirm the actual school email domain first.

## 4. Set a strong QR secret

Change `TOKEN_SECRET` to a long random string. Never publish this secret in `js/script.js`.

## 5. Deploy Apps Script

Open **Extensions → Apps Script** from the Google Sheet, paste the contents of `google-apps-script/Code.gs`, save, then:

**Deploy → New deployment → Web app**

Recommended settings for this architecture:

- Execute as: **Me**
- Who has access: **Anyone**

The endpoint itself still requires a valid Google ID token and checks the configured OAuth client ID before accepting create/scan requests.

Copy the `/exec` URL into `GOOGLE_SHEETS_WEB_APP_URL` in `js/script.js`.

## 6. Test the flow

1. Open the website.
2. Sign in with Google.
3. Add a student using the institutional email and institution ID.
4. Add a visitor using a personal email.
5. Open **QR Generator** and select the person.
6. Generate the daily QR.
7. Open **QR Scanner** on the phone and sign in with the Google account used by the scanning station.
8. Start the camera and scan the QR.
9. The scan is written to the `Attendance` sheet.
10. Scan the same person's daily QR again to record checkout.
11. In Google Sheets, use **File → Download → Microsoft Excel (.xlsx)** when you need an Excel file.

## Important production note

The old browser `localStorage`/`window.storage` data is retained only as a local UI cache. Google Sheets is the authoritative attendance record in this version. For a real capstone deployment, host the website on HTTPS because mobile camera access and Google authentication work best in a secure origin.
