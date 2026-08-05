# Meelad Program - Live Quiz Website

Built for: Registration + Live Quiz (with countdown & anti-cheat) + Leaderboard + Swalath Counter.
Handles 200-300 concurrent users comfortably on the smallest free hosting tier.

## What's inside
- `server.js` — the backend (Node.js + Express + Socket.io)
- `db.js` — database setup (SQLite — a single file, no separate database server needed)
- `public/` — all the pages participants and admin will see
  - `index.html` — Register / auto-login by phone number
  - `dashboard.html` — hub with two buttons
  - `quiz.html` — live quiz screen
  - `swalath.html` — swalath counter
  - `admin.html` — admin control panel (password protected)

## IMPORTANT — before your event
Open `server.js` and change this line to your own secret password:
```
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'meelad2026';
```

## Option A: Run on your own laptop (for testing, or a local WiFi event)
1. Install [Node.js](https://nodejs.org) (LTS version) if you don't have it.
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. The site is now running at `http://localhost:3000`
4. Everyone on the SAME WiFi can access it by typing your laptop's local IP
   address instead of "localhost", e.g. `http://192.168.1.50:3000`
   (Find your IP: Windows → `ipconfig`, Mac → `ifconfig` or System Settings → WiFi → Details)
5. Admin panel: `http://<your-ip>:3000/admin.html`

This option is 100% free and works great if the mosque has decent WiFi and
you don't need it accessible from outside (e.g., over mobile data).

## Option B: Free hosting on the internet (Render.com) — recommended
This way it works over any internet connection, not just local WiFi.

1. Create a free account at https://render.com
2. Create a free account at https://github.com and upload this whole folder
   as a new repository (or ask anyone slightly technical to help with this
   one step — it's just drag-and-drop on github.com).
3. In Render, click **New +** → **Web Service** → connect your GitHub repo.
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free
5. Under **Environment Variables**, add:
   - `ADMIN_PASSWORD` = your chosen password
6. Click **Deploy**. After a couple of minutes you'll get a URL like
   `https://your-app-name.onrender.com` — share this link (or a QR code of it)
   with everyone attending.

**Note on Render's free tier:** it "sleeps" after 15 minutes of no visitors,
and takes ~30-60 seconds to wake up on the next visit. To avoid this during
your live event, open the site yourself about 10 minutes before the program
starts so it's already awake, and keep the admin panel open throughout.

## How to run the program on the day
1. Announce the website link (share as a QR code — search "free QR code
   generator", paste your link) so kids/parents can register early (name,
   phone, age) from `index.html`.
2. Prepare all your quiz questions ahead of time in **Admin Panel → Add
   Question** (category: Kada Prasangam, Mappila Pattu, Song, Speech, etc.)
3. When you're ready for a question, click **Start Live** next to it.
   It instantly appears on every participant's phone with a synced countdown
   (default 20 seconds, editable per question).
4. Display the **Leaderboard** section on a projector/big screen — it shows
   rank and name only, never marks, exactly as requested.
5. After the whole quiz, go to **Admin Panel → Download Results (Excel)**
   for the full sheet: every participant, their answer to each question,
   correct/wrong, and total score (correct = +1, wrong = 0, no deduction).

## About the anti-cheat feature — please read
No website can technically force someone to stay on a page, or stop them
from picking up a second phone to search Google — browsers don't allow that
level of control, and no app legitimately can. What this site DOES do:
- Detects the moment a participant's browser tab/window loses focus, is
  minimized, or they switch to another app.
- The instant that happens, their current question is automatically marked
  **forfeited** (counted as wrong) — they cannot come back and answer it.
- It also requests fullscreen mode to reduce accidental/easy switching.
- Every such incident is timestamped and logged (visible to admin) so you
  can review who left the quiz screen and when.

This is the strongest and most honest form of "lockout" a browser-based
website can offer — same-device tab switching is caught instantly. It won't
stop a determined child from asking a friend or using a second device, but
in practice, with a live 20-second timer, that's very difficult to pull off
anyway.

## Customizing
- Change colors/theme: edit `public/css/style.css`
- Change age-group cutoffs: edit `ageGroupFor()` in `server.js`
- Add more swalath quick-add buttons: edit `public/swalath.html`

Everything here uses free, open-source tools — no paid API, no SMS/OTP costs.
