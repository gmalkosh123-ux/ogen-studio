// Remembering the token. Either only until the tab closes, or on this device encrypted with a
// password (PBKDF2 + AES-GCM). It is never kept readable in permanent storage.
const SESSION = 'ogen-studio-token';
const SEALED = 'ogen-studio-sealed';
const b64 = u => btoa(String.fromCharCode(...u));
const un64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function keyOf(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600_000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const safe = (f, other = null) => { try { return f(); } catch { return other; } };

export const keep = {
  session: () => safe(() => sessionStorage.getItem(SESSION)),
  setSession: token => safe(() => sessionStorage.setItem(SESSION, token)),
  hasSealed: () => !!safe(() => localStorage.getItem(SEALED)),
  async seal(token, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(password, salt), new TextEncoder().encode(token));
    localStorage.setItem(SEALED, JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) }));
  },
  /** null when the password is wrong. */
  async open(password) {
    try {
      const s = JSON.parse(localStorage.getItem(SEALED));
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(s.iv) }, await keyOf(password, un64(s.salt)), un64(s.data));
      return new TextDecoder().decode(plain);
    } catch { return null; }
  },
  lock: () => safe(() => sessionStorage.removeItem(SESSION)),
  forget: () => safe(() => { sessionStorage.removeItem(SESSION); localStorage.removeItem(SEALED); }),
};

/** Unpublished edits, kept in this browser so closing the tab loses nothing. General content only. */
const DRAFT = 'ogen-studio-draft';
export const drafts = {
  read: () => safe(() => JSON.parse(localStorage.getItem(DRAFT))),
  write: d => safe(() => localStorage.setItem(DRAFT, JSON.stringify(d))),
  clear: () => safe(() => localStorage.removeItem(DRAFT)),
};
