# Udonarium Development Diary

Feature-focused notes from forking the latest [Udonarium with Fly](https://github.com/NanasuNANA/UdonariumWithFly) through `hktrpg-main`. One feature per entry — bug fixes not included.

Site: https://z01.hktrpg.com/

---

Udonarium Development Diary 01
The old Fly build stopped in 2021; we wanted to catch up with the latest With Fly.
So we rebased the whole fork on a new foundation.
Angular 20, SkyWay 2023, self-hosted backend.
The UI can switch between Traditional Chinese, Simplified Chinese, English, and Japanese.
Guest mode, note inventory, and one-click character-sheet dice were carried over too.

---

Udonarium Development Diary 02
Dragging the mouse all session gets tiring.
So we added keyboard control for pieces.
After selecting, WASD moves and Shift+WASD rotates.
Ctrl+Z/Y undo and redo.
Ctrl+click draws a path; Space walks along it.

---

Udonarium Development Diary 03
We wanted dark rooms and flashlight-in-a-corridor style play.
So we added tabletop lighting and vision.
Maps can be fully dark, with blocking walls and lights.
Characters can declare whose eyes the table uses.
GMs draw walls and place lights with scene tools.

---

Udonarium Development Diary 04
Combat rounds are easy to lose track of.
So we added a combat tracker.
Roll initiative, declare turns, skip defeated combatants.
Character status icons and “down” stay in sync with combat.

---

Udonarium Development Diary 05
We wanted GM, player, and guest roles when opening a room — not one link for everyone.
So we added role-based rooms and invite links.
Each role can be open, password-protected, or disabled.
Copy the matching link; enter the password when prompted.

---

Udonarium Development Diary 06
Static map images felt too dry.
So we added seasonal weather.
Rain, snow, cherry blossoms, autumn leaves, aurora, and more.
Turn it on from map settings.

---

Udonarium Development Diary 07
We wanted dramatic speech and clear death states on tokens.
So we added image effects and floating dialogue.
Grayscale, silhouette, Matrix-style filters on pieces.
Chat wrapped in 「」 floats above the token.
Death state aligns with combat “down.”

---

Udonarium Development Diary 08
Udonarium has no server — forget to save and the whole room is gone.
So we added fully automatic local folder backup.
Bind a folder once in Chrome; room changes write ZIPs automatically.
Multiple rooms get separate slots; flush runs before you leave.

---

Udonarium Development Diary 09
First-time users get lost easily.
So we added a guided tour and hover tips.
First visit shows step-by-step overlays.
Hovering menus shows tutorial boxes.
Skippable; replay from Settings.

---

Udonarium Development Diary 10
Switching day/night or before/after combat on the same map was tedious.
So we added scene presets.
One click saves token positions, weather, lights, walls, and BGM.
Restore later, or “apply but keep current pieces.”

---

Udonarium Development Diary 11
Sessions need more than one BGM — ambience and themes often stack.
So the library became multi-track.
Up to four tracks together, plus local ambience.
20 MB per file; preview is local-only, not broadcast.

---

Udonarium Development Diary 12
Long GM recaps and narration shouldn’t be pasted line by line in chat.
So we added scenario text.
Write ahead; send the whole piece or just the selection to the active chat tab.
Character name plus 「」 triggers floating dialogue.

---

Udonarium Development Diary 13
iPad and phone users found the old UI hard to tap.
So we built a mobile/tablet layout.
Icon grid navigation, half-screen forms, map HUD.
Desktop unchanged; hover tips only on mouse devices.

---

Udonarium Development Diary 14
One scenario often needs several maps; switching maps dropped piece positions.
So we added multi-map placement.
One object can sit on several maps; switching doesn’t lose position.
Per-map rotation and appearance are independent — edits on map B don’t overwrite map A.

---

Udonarium Development Diary 15
Hosts want to control which menus players see; loading old ZIPs shouldn’t let everyone import freely.
So we added menu/load permissions, GM kick, and PWA update prompts.
ZIP load defaults to GM-only; can be opened to players.
Kick from the connection panel; new builds prompt reload.

---

Udonarium Development Diary 16
Many character sheets live in CCFOLIA; rebuilding in Udonarium is painful.
So we added character JSON import/export.
Download JSON from character details; Ctrl+V on desktop pastes it back.
Filename: hktrpg_name_timestamp for archiving.

---

Udonarium Development Diary 17
Dropping a file on the table — token, card, or terrain?
So we added a drag-file picker; chat can attach images too.
Drop on the table asks: token, card, terrain, note, or library only.
Paste/drag images in chat as attachments.

---

Udonarium Development Diary 18
Investigation games hand out photos, PDFs, and video; some notes should stay private.
So notes support media, handouts, self-only visibility, and later flip sides.
Text, images, video, and PDF.
GM can show to selected players; flip to back if present, mirror if not.

---

Udonarium Development Diary 19
We wanted map boards to trigger cut-ins, scene changes, and notes on click.
So map masks got actions.
Alt+double-click triggers (multiple can be checked).
Send chat/dice, play music, cut-in, show note, switch map, apply preset.

---

Udonarium Development Diary 20
Some games don’t need 2.5D — clue walls and top-down tactics work better.
So we added 2D mode.
Camera locked top-down; characters and dice flat on the table.
Notes lie flat; works as a corkboard.

---

Udonarium Development Diary 21
Weather without sound felt fake.
So we added weather effect audio.
Rain, thunderstorm, snow, sandstorm each on its own track.
Plays with weather; can mute individually.

---

Udonarium Development Diary 22
The same character card should look different on map A vs map B.
So tabletop tokens and character cards are separate.
The card is data; the token is the piece on that map.
Graveyard is room-wide; appearance and height follow the token.

---

Udonarium Development Diary 23
Door knocks, gunshots, laughs — don’t hunt through the library.
So the library got a soundboard pad.
Drag short clips into slots; one tap plays.
Under 8 seconds recommended; longer clips ask to confirm.

---

Udonarium Development Diary 24
Hong Kong streets aren’t just box buildings — slopes, footbridges, neon shop signs.
So terrain got slope angles, six-face textures, and neon glow.
Walls and floors can use different images.
Signs: soft glow, tube light, flicker, and more.

---

Udonarium Development Diary 25
We really wanted Hong Kong urban 2.5D sessions.
So we tried importing 3D models.
Drop buildings, footbridges, and other assets directly.
Drag STL/OBJ/glTF/FBX or ZIP onto the table.
Bakes to six-face terrain; L-shapes move as a group.
Shift multi-select to group/un-group and export; slopes, neon signs, corner scale included.

---

Udonarium Development Diary 26
Joining and disconnecting scared people: empty table, ghost rooms, broken invite links with no feedback.
So we tightened connection and invite flow.
Keep local tabletop until join is confirmed with a live map.
Ghost rooms hidden from the list; doesn’t kick seated players.
Auto remesh on disconnect; token/backend errors reopen the room instead of silent lobby dump.
Invite links freeze the UI first; broken links say “invalid or corrupted.”
Second tab in the same room sees tokens/images faster.

---

Udonarium Development Diary 27
4G/LTE joins were flaky; mesh reconnects spammed the console.
So we tightened connection and mesh again.
Weak networks get fewer reconnect storms; mid-session drops keep remeshing.
Failed lobby join doesn’t silently kick — retry is available.
PWA update and SW install failures show icons; connection panel layout stabilized.

---

Udonarium Development Diary 28
Joining waited forever on images and MP3s; note inventory didn’t match character inventory.
So file sync and note inventory got a major pass.
FILES progress bar stays visible during join; images first, then currently playing BGM.
Folder backup can hydrate from media/ without blocking peer downloads.
Note inventory: five tabs and drag-drop; red-string drag updates live; default scenario no longer double-loads.

---

Udonarium Development Diary 32
Hand library・real decks・object preview (2026/09/01)
Straight-tuck hand (hover expand; play face-up/down); draw/deal into hands
Always draw from cover keeping faces; F turns whole deck; lock blocks move/draw
Hover Caption (name→text); Ctrl／⌘ Object Image Preview (pin, dblclick detail)
Face-down cards: no player detail; caption anchors beside the painted card

---

Udonarium Development Diary 33
Print & Play・streetscape・room passwords・shortcuts (2026/09/03–07)
PDF cards: page range, auto-trim, preview zoom／pan／magnetic edges
Streetscape: Open3Dhk／PLATEAU background import + HUD; HK scale; GSI aerial floor
Role passwords kept; early FILES／map images first; cancel picker does not wipe Token images
Locked stacks refuse merge; dice re-roll is R; menus show Ctrl＋C／X／V

---

Udonarium Development Diary 34
Library delete・character sheet edit (2026/09/08–10)
Deleted images／tracks stay gone over P2P; re-import restores
Packed audio／video restore as hash.ext
Unchecked check fields still show option text; compact Edit MODE; note fields remember height

---
