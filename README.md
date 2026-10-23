# 📸 So Temi Shoot App

A mobile-friendly web app I built to help a South African loungewear brand plan and run its launch photoshoot. Instead of a long PDF plan and a busy group chat, the whole team (brand owner, coordinators and models) had one live place to see the plan, their own schedule and what still needed to be done.

**Used for a real shoot** by the brand owner, the coordinators and the models.

## ✨ Features

- **Private access codes:** each person signs in with their own code and only sees what their role allows
- **Three roles:**
  - **Owner** can edit the plan, add or remove shots and choose who is in each one
  - **Coordinators** see everything and tick off progress on the day
  - **Models** see their own page: their schedule, moodboard, props and shots
- **Two modes:** *Planning* for the weeks before, and *Shoot day* for running the day live
- **Shot list** with must-have and bonus priorities, inspiration photos and progress tracking
- **Schedule, rooms and running order** so everyone knows where to be and when
- **Props list** that updates itself when shots are added or removed
- **Live sync:** when one person ticks something off, everyone else sees it
- **Installable on a phone** like a normal app (Progressive Web App)

## 🧠 How it works

| Part | What it does |
|---|---|
| `index.html` | The page layout and styling |
| `app.js` | All the app logic: signing in, drawing each tab, and saving changes |
| `config.js` | Connects the app to the Supabase database (see `config.example.js`) |
| `database/setup.sql` | Creates the database tables and the secure functions the app calls |
| `manifest.webmanifest` | Lets the app be installed on a phone's home screen |
| `_headers` | Netlify security settings (no search-engine indexing, no embedding) |

### 🔒 Security

Every database table has **row level security** switched on with no direct access, so nobody can read the data just by having the database address. The app can only call a small set of database functions, and **every function checks the person's access code and role first**. For example, only the owner can change the plan, and a model can only tick items on her own list.

## 🛠️ Built with

HTML · CSS · JavaScript · Supabase (PostgreSQL) · Netlify

## ▶️ Run your own copy

1. Create a free project on [Supabase](https://supabase.com)
2. In **SQL Editor**, open `database/setup.sql`, replace the `CHANGE-ME` access codes with your own, and run it
3. Copy `config.example.js` to `config.js` and add your Supabase URL and publishable key
4. Drag the folder onto [Netlify Drop](https://app.netlify.com/drop) to put it online

---
👩🏾‍💻 Built by [Vuyolwethu Mpongose](https://www.linkedin.com/in/vuyompongose)
