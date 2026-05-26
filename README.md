# Un-Reader BBS 

A retro, brutalist, e-ink style Bulletin Board System (BBS) designed for ultra-low latency, crisp legibility, and high modularity. Un-Reader provides a classic, text-heavy community experience optimized for standard browsers as well as low-refresh-rate devices like e-readers.

---
## Usage
go to: https://unreader-ui.onrender.com
or alternative url on GitHub pages: https://tock-dev.guthub.io/unreader
## Key Features

- **Unified Dashboard Portal**: The central entrypoint that handles authentication, live session tracking, and display preferences.
- **Chat Space**: Direct-message channels and public chats with instant profile popups.
- **Topic Rooms**: Dynamically categorized custom discussion tags.
- **Neighbourhood Forum**: Classic message board for structured posts and nested comment trees.
- **Moderation Console**: Admin search tools, system bans, timeouts, and live auditor activity logs.
- **Inline Mod Mode**: Dedicated float controls across Chat, Topics, and Neighbourhood allowing authorized moderators to purge/restore posts inline.
- **Display Adaptability**: Direct theme synchronization including Dark Mode, Bold High-Contrast, and Monospace Typography.

---

## App Architecture & File Mapping

- [index.html](index.html) - Homepage Dashboard Portal
- [chat.html](chat.html) - Messaging space (Public & DMs)
- [topics.html](topics.html) - Custom room directories
- [neighbourhood.html](neighbourhood.html) - Forum board & commentary
- [modmenu.html](modmenu.html) - Staff dashboard & user action controls
- [singlepage.html](singlepage.html) - Legacy all-in-one monolith application (Preserved)
- [index.js](index.js) - Express & WebSocket PostgreSQL backend

---

## Development Team

Brought to life by the core engineering and design team:

* **[tock-dev](https://github.com/tock-dev)**
* **[HackerAUG](https://github.com/HackerAUG)**

---

## Credits

Special thanks and appreciation to:

* **[KodiGamingYT](https://github.com/KodiGamingYT)** — Designed and developed the updated homepage dashboard (`index.html`), introducing unified styling, preferences, and modular portal cards.
