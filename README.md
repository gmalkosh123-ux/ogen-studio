# Ogen Studio

A small static site for editing the content of the Ogen app. No build step, no dependencies, no server.

- It contains no content and no secrets. Everything is read from and written to a private repository through api.github.com, with a fine-grained token the owner pastes in.
- The token is kept for the tab only, or on the device encrypted with a password (PBKDF2, AES-GCM).
- A Content-Security-Policy allows only this site's own code and connections to api.github.com.
- `js/validate.js` mirrors the checks of the app; the app has the last word.
- Fonts: Frank Ruhl Libre and Rubik, SIL Open Font License 1.1 (see `fonts`).
