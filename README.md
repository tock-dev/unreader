# Un-Reader BBS

A retro, brutalist, e-ink style Bulletin Board System (BBS) designed for ultra-low latency, crisp legibility, and high modularity. Un-Reader provides a classic, text-heavy community experience optimized for standard browsers as well as low-refresh-rate devices like e-readers.

---

## Usage

go to: https://unreader-v4yf.onrender.com

## Key Features

- **Unified Dashboard Portal**: The central entrypoint that handles authentication, live session tracking, and display preferences.
- **Chat Space**: Direct-message channels and public chats with instant profile popups.
- **Topic Rooms**: Dynamically categorized custom discussion tags.
- **Neighbourhood Forum**: Classic message board for structured posts and nested comment trees.
- **Moderation Console**: Admin search tools, system bans, timeouts, and live auditor activity logs.
- **Inline Mod Mode**: Dedicated float controls across Chat, Topics, and Neighbourhood allowing authorized moderators to purge/restore posts inline.
- **Display Adaptability**: Direct theme synchronization including ~~Dark Mode, Bold High-Contrast~~, and Monospace Typography. (Both of these are currently disabled by Kodi, unknown reasons)

---

## App Architecture & File Mapping

- [index.html](index.html) - Homepage Dashboard Portal
- [chat.html](chat.html) - Messaging space (Public & DMs)
- [topics.html](topics.html) - Custom room directories
- [neighbourhood.html](neighbourhood.html) - Forum board & commentary
- [portal-2d.html](portal-2d.html) - Flash Portal 2D puzzle game with online level packs (`portal-2d` table, `/api/portal2d/*`)
- [index.js](index.js) - Express & WebSocket PostgreSQL backend

---

## Development Team

Brought to life by the core engineering and design team:

- **[tock-dev](https://github.com/tock-dev)**
- ~**[HackerAUG](https://github.com/HackerAUG)**~ Removed from dev team after some drama. He kinda just threatened us to delete the entire project.
- **[KodiGamingYT](https://github.com/KodiGamingYT)**

---

## Credits

Special thanks and appreciation to:

- **[KodiGamingYT](https://github.com/KodiGamingYT)** — Designed and developed the updated homepage dashboard (`index.html`), introducing unified styling, preferences, and modular portal cards.
On another note, he added a streaming system. It's not in use right now, and probably never will. Just like the dark mode.

- **[SuprUsr124](https://github.com/SuprUsr123)** — Beta Tester, Maintainer (tock almost left the site 4 dead, at least he got his mac back and fixed bugs), Oregon Trail (Kindle Web Port), Reversi (Kindle Web Port), Rewrote Pokedex, and very minor additions.


## Also when can we recruit more this is might put some stress on full time maintenance later (hinting at @blockwobble and @snipecut13 and their RK fork)

## Flash Portal 2D

Chambers advance automatically when you reach the exit. Level gimmicks: no-portal (hatched) surfaces that can be painted on any part of a ceiling, floor, wall or ledge, launch plates, multi-input doors driven by button/trigger wires, directional lasers, and fizzler grids.

- **Copy and edit**: the official chambers are read-only. EDIT, COPY PACK or COPY LVL make you an editable copy that autosaves. TEST plays the level you are editing. PUBLISH shares a pack; publishing a pack you already published offers UPDATE.
- **Official pack** (admins only): open `/portal-2d-editor.html` to use the separate Portal 2D developer editor. LOAD OFFICIAL FOR EDIT, build/edit chambers, and use EXPORT GAME HTML to generate a drop-in replacement for `portal-2d.html`. The editor also supports publishing, bulk official-pack replacement, and adding approved chambers to the server. The pack is stored on the server (`portal-2d` table, username `[official]`) and every player picks it up automatically; RESET OFFICIAL falls back to the chambers baked into `portal-2d.html`.
- **Portal 2D logic entities:** doors can be driven by multiple button/trigger inputs through explicit `wires`; doors support ALL or ANY input logic. Trigger zones activate while the player is inside them, and laser emitters have editable direction/length and can kill the player or destroy a cube on contact.
- **Deleting online packs**: owners, admins and moderators. The server decides who sees a DELETE button.
