// The same checks the app makes (LiveContent.kt). The app is the one that decides; this only tells
// you before publishing. Runs in the browser and in Node (the ogen-content build uses a copy).

const ID = /^[A-Za-z0-9_-]{1,60}$/;
const PATH = /^content\/(?:courses\/)?[A-Za-z0-9_-]{1,80}\.json$/;
const SCALES = { textScale: [0.85, 1.3], cornerScale: [0, 1.6], spacingScale: [0.7, 1.6] };

const channel = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = hex => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel(n >> 16 & 255) + 0.7152 * channel(n >> 8 & 255) + 0.0722 * channel(n & 255);
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** [[text, background, ratio, least]] that cannot be read. */
export const unreadable = (palette, pairs) => pairs
  .map(([t, b, least]) => [t, b, contrast(palette[t], palette[b]), least])
  .filter(p => p[2] < p[3]);

export const isLocked = (text, catalog) => catalog.locked.some(l => text.includes(l));

/** files: path to text. Returns a list of problems in Hebrew (empty = fine). */
export function validate(files, catalog) {
  const problems = [];
  const bad = (file, what) => problems.push(`${file}: ${what}`);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  const str = (o, key, file, max, required = true) => {
    const v = typeof o[key] === 'string' ? o[key].trim() : '';
    if (required && !v) bad(file, `חסר השדה ${key}`);
    if (v.length > max) bad(file, `השדה ${key} ארוך מדי (עד ${max} תווים)`);
    return v;
  };
  const ident = (o, file, seen) => {
    const v = str(o, 'id', file, 60);
    if (v && !ID.test(v)) bad(file, `מזהה לא תקין: ${v}`);
    if (v && seen.has(v)) bad(file, `מזהה כפול: ${v}`);
    seen.add(v);
    return v;
  };
  const list = (o, key, file) => {
    if (o[key] === undefined) return [];
    if (!Array.isArray(o[key])) { bad(file, `${key} חייב להיות רשימה`); return []; }
    return o[key];
  };
  const objects = (o, key, file) => list(o, key, file).filter(v => isObj(v) || (bad(file, `פריט לא תקין ב-${key}`), false));
  const strings = (o, key, file, max) => list(o, key, file).map(v => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || s.length > max) bad(file, `שורה ריקה או ארוכה מדי ב-${key}`);
    return s;
  });

  const data = {};
  for (const [path, text] of Object.entries(files)) {
    if (!PATH.test(path)) { bad(path, 'שם קובץ לא תקין'); continue; }
    if (new TextEncoder().encode(text).length > 1_000_000) bad(path, 'הקובץ גדול מדי');
    try {
      const o = JSON.parse(text);
      if (isObj(o)) data[path] = o; else bad(path, 'הקובץ לא תקין');
    } catch { bad(path, 'הקובץ לא תקין'); }
  }

  const courseIds = new Set(), lessonIds = new Set(), questionIds = new Set();
  const visible = new Set();
  for (const [path, c] of Object.entries(data).filter(([p]) => p.startsWith('content/courses/'))) {
    ident(c, path, courseIds);
    str(c, 'title', path, 60); str(c, 'subtitle', path, 120, false); str(c, 'icon', path, 30, false); str(c, 'tint', path, 20, false);
    for (const l of objects(c, 'lessons', path)) {
      const id = ident(l, path, lessonIds);
      if (!c.hidden) visible.add(id);
      const where = `${path} › ${id}`;
      str(l, 'title', where, 120); str(l, 'practice', where, 1200);
      const cards = objects(l, 'cards', where);
      if (!cards.length) bad(where, 'בשיעור אין כרטיסים');
      for (const k of cards) { str(k, 'title', where, 120); str(k, 'body', where, 3000); }
      const quiz = objects(l, 'quiz', where);
      if (!quiz.length) bad(where, 'בשיעור אין שאלות');
      for (const q of quiz) {
        ident(q, where, questionIds);
        str(q, 'question', where, 400); str(q, 'why', where, 600);
        const options = strings(q, 'options', where, 300);
        if (options.length < 2 || options.length > 6) bad(where, 'בשאלה צריכות להיות 2 עד 6 תשובות');
        if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= options.length) bad(where, 'בשאלה לא סומנה תשובה נכונה');
      }
      if (!strings(l, 'sources', where, 600).length) bad(where, 'בשיעור אין מקורות');
    }
  }
  for (const l of catalog.builtInLessons.filter(x => !courseIds.has(x.track))) {
    visible.add(l.id);
    if (lessonIds.has(l.id)) bad('content/courses/', `מזהה שיעור תפוס: ${l.id}`);
  }
  if (!visible.size) bad('content/courses/', 'לא נשאר אף שיעור');

  const t = data['content/training.json'];
  if (t) {
    const file = 'content/training.json';
    const s = objects(t, 'statements', file);
    for (const x of s) { str(x, 'text', file, 200); if (!catalog.themes.includes(x.theme)) bad(file, `נושא לא מוכר: ${x.theme}`); }
    if (s.filter(x => x.helpful === true).length < 7 || s.filter(x => x.helpful !== true).length < 7) bad(file, 'צריך לפחות 7 משפטים מכל סוג');
    if (!strings(t, 'reframes', file, 200).length) bad(file, 'צריך לפחות משפט מרגיע אחד');
  }

  const d = data['content/design.json'];
  if (d) {
    const file = 'content/design.json';
    for (const mode of ['light', 'dark']) {
      const given = isObj(d[mode]) ? d[mode] : {};
      const ok = {};
      for (const [role, hex] of Object.entries(given)) {
        if (!(role in catalog.palettes.light)) bad(file, `צבע לא מוכר: ${role}`);
        else if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) bad(file, `ערך צבע לא תקין: ${role}`);
        else ok[role] = hex;
      }
      for (const [a, b] of unreadable({ ...catalog.palettes[mode], ...ok }, catalog.contrast))
        bad(file, `${mode === 'light' ? 'מצב בהיר' : 'מצב כהה'}: אין מספיק ניגודיות, ${a} על ${b}`);
    }
    for (const [key, [min, max]] of Object.entries(SCALES))
      if (d[key] !== undefined && !(d[key] >= min && d[key] <= max)) bad(file, `${key} מחוץ לטווח`);
  }

  const h = data['content/home.json'];
  if (h) {
    const file = 'content/home.json';
    const blocks = objects(h, 'blocks', file).map(b => b.id);
    blocks.filter(b => !catalog.homeBlocks.includes(b)).forEach(b => bad(file, `אזור לא מוכר: ${b}`));
    if (new Set(blocks).size !== blocks.length) bad(file, 'אזור מופיע פעמיים');
    const seen = new Set();
    for (const c of objects(h, 'cards', file)) {
      const id = ident(c, file, seen);
      str(c, 'title', file, 80); str(c, 'body', file, 300, false);
      const [lesson, route, url] = [str(c, 'lesson', file, 60, false), str(c, 'route', file, 30, false), str(c, 'url', file, 500, false)];
      if (route && !catalog.routes.includes(route)) bad(file, `מסך לא מוכר: ${route}`);
      if (url && !url.startsWith('https://')) bad(file, 'קישור חייב להתחיל ב-https');
      if (lesson && !visible.has(lesson)) bad(file, `הכרטיס ${id} מוביל לשיעור שלא קיים`);
    }
  }

  const x = data['content/texts.json'];
  if (x) for (const [original, v] of Object.entries(x)) {
    const file = 'content/texts.json';
    if (isLocked(original, catalog)) bad(file, `טקסט נעול (עזרה וחירום): ${original.slice(0, 40)}`);
    else if (typeof v !== 'string' || !v.trim() || v.trim().length > 1000) bad(file, `טקסט ריק או ארוך מדי: ${original.slice(0, 40)}`);
  }

  const chat = data['content/chat.json'];
  if (chat) str(chat, 'style', 'content/chat.json', 2000, false);

  return problems;
}
