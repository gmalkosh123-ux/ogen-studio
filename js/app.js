import { github, GitHubError } from './github.js';
import { validate, unreadable, contrast, isLocked } from './validate.js';
import { keep, drafts } from './keep.js';

const REPO = 'gmalkosh123-ux/ogen-content';
const root = document.getElementById('app');

// ---------------------------------------------------------------- small helpers
// All text goes in through textContent, so nothing typed or loaded can become code.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(9).filter(k => k !== null && k !== undefined && k !== false));
  return el;
}
const show = (...kids) => root.replaceChildren(...kids);
const button = (label, onclick, cls = '', extra = {}) => h('button', { type: 'button', class: cls, onclick, ...extra }, label);
const when = iso => new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });

function toast(text, bad = false) {
  const el = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

/** A dialog that resolves to the value of the button that was pressed (null = closed). */
function ask(title, body, buttons) {
  return new Promise(resolve => {
    const d = h('dialog', { 'aria-label': title }, h('h2', {}, title), body,
      h('div', { class: 'row end' }, buttons.map(([label, value, cls]) => button(label, () => { d.close(); d.remove(); resolve(typeof value === 'function' ? value() : value); }, cls))));
    d.addEventListener('cancel', () => resolve(null));
    d.addEventListener('close', () => d.remove());
    document.body.append(d);
    d.showModal();
  });
}
const confirm = async (title, text, yes) => await ask(title, h('p', {}, text), [['ביטול', null, 'quiet'], [yes, true, 'danger']]) === true;

// ---------------------------------------------------------------- state
const S = { gh: null, base: '', files: {}, catalog: null, edited: {}, page: 'courses', course: '', lesson: '', mode: 'light', filter: '' };

const stringify = o => JSON.stringify(o, null, 2) + '\n';
const parsed = new Map();
/** The edited version of a file if there is one, otherwise the published one. */
function get(path) {
  if (path in S.edited) return S.edited[path];
  if (!parsed.has(path)) { try { parsed.set(path, JSON.parse(S.files[path] ?? 'null')); } catch { parsed.set(path, null); } }
  return parsed.get(path);
}
/** Change a file: fn gets a copy that becomes the edited version. */
function edit(path, fn, redraw = true) {
  const o = path in S.edited && S.edited[path] ? S.edited[path] : structuredClone(get(path) ?? {});
  fn(o);
  S.edited[path] = o;
  saveDraft();
  if (redraw) draw(); else updateBar();
}
function saveDraft() {
  if (Object.keys(changes()).length) drafts.write({ base: S.base, edited: S.edited });
  else drafts.clear();
}
/** Path to text (or null = deleted) for every file that differs from what is published. */
function changes() {
  const out = {};
  for (const [path, o] of Object.entries(S.edited)) {
    if (o === null) { if (path in S.files) out[path] = null; continue; }
    let old = null;
    try { old = JSON.stringify(JSON.parse(S.files[path] ?? 'null')); } catch { /* damaged file: any edit is a change */ }
    if (JSON.stringify(o) !== old) out[path] = stringify(o);
  }
  return out;
}
function allFiles() {
  const out = { ...S.files };
  for (const [p, t] of Object.entries(changes())) { if (t === null) delete out[p]; else out[p] = t; }
  return out;
}
const coursePaths = () => [...new Set([...Object.keys(S.files), ...Object.keys(S.edited)])]
  .filter(p => p.startsWith('content/courses/') && get(p))
  .sort((a, b) => (get(a).order ?? 100) - (get(b).order ?? 100));
const allLessons = () => coursePaths().flatMap(p => (get(p).lessons ?? []).map(l => ({ id: l.id, title: l.title, course: get(p).title })));

/** A new id that nothing uses yet. */
function freshId(prefix, used) {
  for (let i = 1; ; i++) if (!used.has(prefix + i)) return prefix + i;
}

// ---------------------------------------------------------------- sign in
function signIn(message = '') {
  const note = h('p', { class: 'error', role: 'alert' }, message);
  const busy = async fn => { note.textContent = 'רגע…'; try { await fn(); } catch (e) { note.textContent = e instanceof GitHubError ? e.message : 'משהו השתבש. אפשר לנסות שוב.'; } };
  const start = async token => {
    S.gh = github(token, REPO);
    await reload();
    await restoreDraft();
    keep.setSession(token);
    draw();
  };
  const cards = [];
  if (keep.hasSealed()) {
    const pass = h('input', { type: 'password', autocomplete: 'current-password', id: 'pass' });
    cards.push(h('form', { class: 'card', onsubmit: e => {
      e.preventDefault();
      busy(async () => {
        const token = await keep.open(pass.value);
        if (!token) { note.textContent = 'הסיסמה לא נכונה.'; return; }
        await start(token);
      });
    } }, h('label', { for: 'pass' }, 'סיסמת הסטודיו במכשיר הזה'), pass, h('button', { type: 'submit', class: 'primary' }, 'להיכנס'),
      button('לשכוח את המכשיר הזה', () => { keep.forget(); signIn(); }, 'link')));
  } else {
    const token = h('input', { type: 'password', autocomplete: 'off', id: 'token', spellcheck: 'false' });
    const pass = h('input', { type: 'password', autocomplete: 'new-password', id: 'newpass', minlength: '8' });
    cards.push(h('form', { class: 'card', onsubmit: e => {
      e.preventDefault();
      busy(async () => {
        const t = token.value.trim();
        if (pass.value && pass.value.length < 8) { note.textContent = 'הסיסמה צריכה לפחות 8 תווים.'; return; }
        await start(t);
        if (pass.value) await keep.seal(t, pass.value);
      });
    } },
      h('label', { for: 'token' }, 'טוקן לעריכה של ogen-content'), token,
      h('label', { for: 'newpass' }, 'סיסמה לזכור במכשיר הזה (לא חובה)'), pass,
      h('p', { class: 'hint' }, 'בלי סיסמה, הטוקן נשמר רק עד שסוגרים את הלשונית. עם סיסמה הוא נשמר כאן מוצפן.'),
      h('button', { type: 'submit', class: 'primary' }, 'להתחבר')));
  }
  show(h('main', { class: 'signin' }, h('h1', {}, 'סטודיו עוגן'), h('p', {}, 'כאן עורכים את הקורסים, הטקסטים והעיצוב של עוגן.'), cards, note));
}

async function reload() {
  const r = await S.gh.load();
  S.base = r.sha; S.files = r.files; S.catalog = r.catalog;
  parsed.clear();
}

// ---------------------------------------------------------------- frame
const PAGES = { courses: 'קורסים', training: 'אימון מחשבות', design: 'עיצוב', home: 'מסך הבית', texts: 'טקסטים', chat: 'סגנון השיחה', history: 'היסטוריה' };

function draw() {
  const scroll = window.scrollY;
  const view = { courses: coursesPage, training: trainingPage, design: designPage, home: homePage, texts: textsPage, chat: chatPage, history: historyPage }[S.page];
  show(
    h('header', {},
      h('strong', { class: 'brand' }, 'סטודיו עוגן'),
      h('nav', { 'aria-label': 'אזורים' }, Object.entries(PAGES).map(([id, label]) =>
        button(label, () => { S.page = id; S.course = S.lesson = ''; draw(); window.scrollTo(0, 0); }, S.page === id ? 'on' : '', S.page === id ? { 'aria-current': 'page' } : {}))),
      button('לנעול', () => { keep.lock(); S.gh = null; signIn(); }, 'link')),
    h('main', {}, view()),
    h('footer', { id: 'bar' }));
  updateBar();
  window.scrollTo(0, scroll);
}

function updateBar() {
  const bar = document.getElementById('bar');
  if (!bar) return;
  const n = Object.keys(changes()).length;
  const problems = n ? validate(allFiles(), S.catalog) : [];
  bar.hidden = n === 0;
  bar.replaceChildren(...[
    h('span', {}, problems.length ? `${problems.length} דברים לתקן לפני פרסום` : n === 1 ? 'קובץ אחד השתנה' : `${n} קבצים השתנו`),
    problems.length ? button('מה לתקן', () => ask('לפני פרסום', h('ul', {}, problems.slice(0, 30).map(p => h('li', {}, p))), [['סגירה', null]]), 'quiet') : null,
    button('לבטל שינויים', async () => {
      if (await confirm('לבטל את כל השינויים?', 'כל מה שערכת מאז הפרסום האחרון יימחק מהדפדפן.', 'לבטל שינויים')) { S.edited = {}; drafts.clear(); S.lesson = ''; if (S.course && !get(S.course)) S.course = ''; draw(); }
    }, 'quiet'),
    button('לפרסם', publish, 'primary', { disabled: problems.length > 0 }),
  ].filter(Boolean));
}

async function publish() {
  const c = changes();
  const note = h('input', { id: 'note', maxlength: '120', placeholder: 'למשל: קורס חדש על שינה' });
  const message = await ask('לפרסם לאפליקציה?', h('div', {},
    h('ul', {}, Object.entries(c).map(([p, t]) => h('li', {}, `${t === null ? 'נמחק' : p in S.files ? 'השתנה' : 'חדש'}: ${p.replace('content/', '')}`))),
    h('label', { for: 'note' }, 'מה השתנה'), note), [['ביטול', null, 'quiet'], ['לפרסם', () => note.value.trim() || 'עדכון תוכן', 'primary']]);
  if (!message) return;
  try {
    await S.gh.publish(S.base, c, message);
    S.edited = {}; drafts.clear();
    await reload();
    toast('פורסם. באפליקציה: כלים › עדכונים › לעדכן תוכן.');
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) await newerVersion();
    else toast(e.message || 'הפרסום לא הצליח.', true);
  }
  draw();
}

/** Someone else (or Claude) published meanwhile: load it and keep the edits of files it did not touch. */
async function newerVersion() {
  const before = { ...S.files };
  const mine = changes();
  try { await reload(); } catch (e) { toast(e.message, true); return; }
  const clash = Object.keys(mine).filter(p => before[p] !== S.files[p]);
  if (!clash.length) { toast('נטענה גרסה חדשה שפורסמה בינתיים. השינויים שלך נשמרו, ואפשר לפרסם.'); saveDraft(); return; }
  const answer = await ask('אותו קובץ השתנה פעמיים', h('div', {}, h('p', {}, 'בזמן שערכת, פורסמה גרסה אחרת של:'), h('ul', {}, clash.map(p => h('li', {}, p)))),
    [['לקחת את הגרסה שפורסמה', 'theirs', 'quiet'], ['להשאיר את שלי', 'mine', 'primary']]);
  if (answer === 'theirs') clash.forEach(p => delete S.edited[p]);
  saveDraft();
}

// ---------------------------------------------------------------- form pieces
let fieldNo = 0;
function field(label, value, onchange, { area = false, max, type = 'text', hint, dir } = {}) {
  const id = 'f' + ++fieldNo;
  const input = h(area ? 'textarea' : 'input', { id, value: value ?? '', maxlength: max, type: area ? undefined : type, dir, oninput: e => { onchange(e.target.value); grow(e.target); } });
  const grow = el => { if (area) { el.rows = Math.min(16, Math.max(3, Math.ceil(el.value.length / 70) + el.value.split('\n').length - 1)); } };
  grow(input);
  return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
}
function select(label, value, options, onchange) {
  const id = 'f' + ++fieldNo;
  return h('div', { class: 'field' }, h('label', { for: id }, label),
    h('select', { id, onchange: e => onchange(e.target.value) }, options.map(([v, text]) => h('option', { value: v, selected: v === value }, text))));
}
function toggle(label, value, onchange) {
  return h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: value, onchange: e => onchange(e.target.checked) }), label);
}
const swap = (list, i, j) => { [list[i], list[j]] = [list[j], list[i]]; };
function mover(i, count, move) {
  return h('span', { class: 'mover' },
    button('▲', () => move(i, i - 1), 'icon', { 'aria-label': 'להעלות', disabled: i === 0 }),
    button('▼', () => move(i, i + 1), 'icon', { 'aria-label': 'להוריד', disabled: i === count - 1 }));
}

// ---------------------------------------------------------------- courses
const TINTS = [['primary', 'ים'], ['secondary', 'ירוק'], ['tertiary', 'שחר'], ['neutral', 'חול']];

function coursesPage() {
  if (S.lesson) return lessonPage();
  if (S.course) return coursePage();
  const paths = coursePaths();
  return [
    h('div', { class: 'row between' }, h('h1', {}, 'קורסים'), h('div', { class: 'row' }, button('להדביק קורס מ-Claude', pasteCourse, 'quiet'), button('קורס חדש', newCourse, 'primary'))),
    h('p', { class: 'hint' }, `${allLessons().length} שיעורים ב-${paths.length} קורסים. הסדר כאן הוא הסדר באפליקציה.`),
    h('ol', { class: 'cards' }, paths.map((p, i) => {
      const c = get(p);
      return h('li', { class: 'card item' + (c.hidden ? ' dim' : '') },
        button([h('strong', {}, c.title || 'בלי שם'), h('span', {}, `${c.subtitle || ''}`), h('small', {}, `${c.lessons?.length ?? 0} שיעורים${c.hidden ? ' · מוסתר' : ''}`)], () => { S.course = p; draw(); window.scrollTo(0, 0); }, 'open'),
        mover(i, paths.length, (a, b) => {
          const order = [...paths]; swap(order, a, b);
          order.forEach((q, n) => { if (get(q).order !== n + 1) edit(q, o => { o.order = n + 1; }, false); });
          draw();
        }));
    })),
  ];
}

function newCourse() {
  const used = new Set(coursePaths().map(p => get(p).id));
  const id = freshId('course', used);
  const path = `content/courses/${id}.json`;
  S.edited[path] = { id, title: 'קורס חדש', subtitle: '', icon: 'book', tint: 'secondary', order: coursePaths().length + 1, hidden: false, lessons: [] };
  saveDraft();
  S.course = path;
  draw();
}

async function pasteCourse() {
  const area = h('textarea', { rows: '12', dir: 'ltr', 'aria-label': 'JSON של קורס' });
  const text = await ask('להדביק קורס', h('div', {}, h('p', { class: 'hint' }, 'מדביקים כאן את ה-JSON ש-Claude כתב. הוא נבדק לפני שאפשר לפרסם.'), area), [['ביטול', null, 'quiet'], ['להוסיף', () => area.value, 'primary']]);
  if (!text) return;
  let c;
  try { c = JSON.parse(text); } catch { toast('זה לא JSON תקין.', true); return; }
  if (!c || typeof c !== 'object' || !/^[A-Za-z0-9_-]{1,60}$/.test(c.id ?? '')) { toast('חסר מזהה תקין לקורס.', true); return; }
  const existing = coursePaths().find(p => get(p).id === c.id);
  if (existing && !await confirm('הקורס כבר קיים', `להחליף את ״${get(existing).title}״?`, 'להחליף')) return;
  const path = existing ?? `content/courses/${c.id.toLowerCase()}.json`;
  S.edited[path] = { icon: 'book', tint: 'secondary', order: coursePaths().length + 1, hidden: false, lessons: [], ...c };
  saveDraft();
  S.course = path;
  draw();
}

function coursePage() {
  const path = S.course;
  const c = get(path);
  const core = S.catalog.coreTracks.includes(c.id);
  const set = (k, redraw) => v => edit(path, o => { o[k] = v; }, redraw);
  const lessons = c.lessons ?? [];
  return [
    button('› כל הקורסים', () => { S.course = ''; draw(); }, 'link'),
    h('h1', {}, c.title),
    h('section', { class: 'card grid' },
      field('שם', c.title, set('title', false), { max: 60 }),
      field('תיאור קצר', c.subtitle, set('subtitle', false), { max: 120 }),
      select('אייקון', c.icon, S.catalog.icons.map(i => [i, i]), set('icon', false)),
      select('צבע', c.tint, TINTS, set('tint', false)),
      toggle('להסתיר באפליקציה', !!c.hidden, set('hidden', true))),
    h('div', { class: 'row between' }, h('h2', {}, 'שיעורים'), button('שיעור חדש', () => {
      const id = freshId(c.id.toLowerCase() + '_', new Set(allLessons().map(l => l.id)));
      edit(path, o => { (o.lessons ??= []).push({ id, title: 'שיעור חדש', minutes: 3, cards: [{ title: '', body: '' }], quiz: [{ id: id + '_q1', question: '', options: ['', ''], correct: 0, why: '' }], practice: '', sources: [''] }); }, false);
      S.lesson = id; draw(); window.scrollTo(0, 0);
    }, 'primary')),
    h('ol', { class: 'cards' }, lessons.map((l, i) => h('li', { class: 'card item' },
      button([h('strong', {}, l.title || 'בלי שם'), h('small', {}, `${l.minutes} דקות · ${l.cards?.length ?? 0} כרטיסים · ${l.quiz?.length ?? 0} שאלות`)], () => { S.lesson = l.id; draw(); window.scrollTo(0, 0); }, 'open'),
      mover(i, lessons.length, (a, b) => edit(path, o => swap(o.lessons, a, b)))))),
    core ? h('p', { class: 'hint' }, 'זה קורס מהליבה של עוגן. אפשר לערוך ולהסתיר אותו, אבל לא למחוק.')
      : button('למחוק את הקורס', async () => {
        if (!await confirm('למחוק את הקורס?', `״${c.title}״ יוסר מהאפליקציה בפרסום הבא. אפשר לשחזר מההיסטוריה.`, 'למחוק')) return;
        if (path in S.files) S.edited[path] = null; else delete S.edited[path];
        saveDraft(); S.course = ''; draw();
      }, 'danger'),
  ];
}

function lessonPage() {
  const path = S.course;
  const i = (get(path)?.lessons ?? []).findIndex(l => l.id === S.lesson);
  if (i < 0) { S.lesson = ''; return coursePage(); }
  const l = get(path).lessons[i];
  const set = (fn, redraw = false) => edit(path, o => fn(o.lessons[i]), redraw);
  const remover = (key, n, label) => button(label, async () => { if (await confirm(label + '?', 'אפשר לבטל עד הפרסום.', 'למחוק')) set(x => x[key].splice(n, 1), true); }, 'link danger');
  return [
    button('› ' + get(path).title, () => { S.lesson = ''; draw(); }, 'link'),
    h('h1', {}, l.title || 'שיעור'),
    h('section', { class: 'card grid' },
      field('כותרת', l.title, v => set(x => { x.title = v; }), { max: 120 }),
      field('דקות', l.minutes, v => set(x => { x.minutes = Math.max(1, Math.min(60, parseInt(v) || 1)); }), { type: 'number' })),
    h('h2', {}, 'כרטיסים'),
    (l.cards ?? []).map((c, n) => h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('small', {}, `כרטיס ${n + 1}`), h('span', { class: 'row' }, mover(n, l.cards.length, (a, b) => set(x => swap(x.cards, a, b), true)), remover('cards', n, 'למחוק כרטיס'))),
      field('כותרת', c.title, v => set(x => { x.cards[n].title = v; }), { max: 120 }),
      field('טקסט', c.body, v => set(x => { x.cards[n].body = v; }), { area: true, max: 3000 }))),
    button('להוסיף כרטיס', () => set(x => (x.cards ??= []).push({ title: '', body: '' }), true), 'quiet'),
    h('h2', {}, 'שאלות'),
    h('p', { class: 'hint' }, 'השאלות חוזרות אחרי כמה ימים כדי לחזק את הזיכרון. מסמנים את התשובה הנכונה.'),
    (l.quiz ?? []).map((q, n) => h('section', { class: 'card' },
      h('div', { class: 'row between' }, h('small', {}, `שאלה ${n + 1}`), remover('quiz', n, 'למחוק שאלה')),
      field('שאלה', q.question, v => set(x => { x.quiz[n].question = v; }), { max: 400 }),
      h('fieldset', {}, h('legend', {}, 'תשובות'), q.options.map((o, k) => h('div', { class: 'row answer' },
        h('input', { type: 'radio', name: 'q' + n, checked: q.correct === k, 'aria-label': `תשובה ${k + 1} נכונה`, onchange: () => set(x => { x.quiz[n].correct = k; }) }),
        h('input', { value: o, maxlength: '300', 'aria-label': `תשובה ${k + 1}`, oninput: e => set(x => { x.quiz[n].options[k] = e.target.value; }) }),
        q.options.length > 2 ? button('✕', () => set(x => { const y = x.quiz[n]; y.options.splice(k, 1); if (y.correct === k) y.correct = 0; else if (y.correct > k) y.correct--; }, true), 'icon', { 'aria-label': 'למחוק תשובה' }) : null)),
        q.options.length < 6 ? button('עוד תשובה', () => set(x => x.quiz[n].options.push(''), true), 'link') : null),
      field('למה זו התשובה', q.why, v => set(x => { x.quiz[n].why = v; }), { area: true, max: 600 }))),
    button('להוסיף שאלה', () => set(x => {
      const used = new Set(coursePaths().flatMap(p => get(p).lessons ?? []).flatMap(y => y.quiz ?? []).map(q => q.id));
      (x.quiz ??= []).push({ id: freshId(x.id + '_q', used), question: '', options: ['', ''], correct: 0, why: '' });
    }, true), 'quiet'),
    h('h2', {}, 'תרגול ומקורות'),
    h('section', { class: 'card' },
      field('תרגול קטן לחיים', l.practice, v => set(x => { x.practice = v; }), { area: true, max: 1200 }),
      field('מקורות (כל מקור בשורה)', (l.sources ?? []).join('\n'), v => set(x => { x.sources = v.split('\n').map(s => s.trim()).filter(Boolean); }), { area: true, hint: 'חובה לפחות מקור אחד. כדאי לוודא שהמקור קיים באמת.' })),
    button('למחוק את השיעור', async () => {
      if (!await confirm('למחוק את השיעור?', 'אפשר לשחזר מההיסטוריה.', 'למחוק')) return;
      S.lesson = '';
      edit(path, o => o.lessons.splice(i, 1));
    }, 'danger'),
  ];
}

// ---------------------------------------------------------------- training
const THEMES = { PARTNER: 'הקשר', CHECKING: 'בדיקה', PANIC: 'פאניקה', WORTH: 'ערך עצמי', UNCERTAINTY: 'אי-ודאות', JUDGMENT: 'שיפוט' };
function trainingPage() {
  const path = 'content/training.json';
  const t = get(path);
  const group = helpful => [
    h('div', { class: 'row between' }, h('h2', {}, helpful ? 'מחשבות שעוזרות' : 'מחשבות של חרדה'),
      button('להוסיף', () => edit(path, o => o.statements.push({ text: '', helpful, theme: 'WORTH' })), 'quiet')),
    t.statements.map((s, n) => s.helpful !== helpful ? null : h('div', { class: 'row line' },
      h('input', { value: s.text, maxlength: '200', 'aria-label': 'משפט', oninput: e => edit(path, o => { o.statements[n].text = e.target.value; }, false) }),
      h('select', { 'aria-label': 'נושא', onchange: e => edit(path, o => { o.statements[n].theme = e.target.value; }, false) }, S.catalog.themes.map(x => h('option', { value: x, selected: x === s.theme }, THEMES[x] ?? x))),
      button('✕', () => edit(path, o => o.statements.splice(n, 1)), 'icon', { 'aria-label': 'למחוק משפט' }))),
  ];
  return [h('h1', {}, 'אימון מחשבות'), h('p', { class: 'hint' }, 'בכל אימון מופיעים 7 משפטים מכל סוג, לפי מה שהשאלון מראה.'), group(true), group(false),
    h('h2', {}, 'משפטים מרגיעים במסך העזרה'),
    h('section', { class: 'card' }, field('משפט בכל שורה', t.reframes.join('\n'), v => edit(path, o => { o.reframes = v.split('\n').map(s => s.trim()).filter(Boolean); }, false), { area: true }))];
}

// ---------------------------------------------------------------- design
const COLOR_GROUPS = [
  ['צבע ראשי', { primary: 'כפתורים ואייקונים', onPrimary: 'טקסט על כפתור', primaryContainer: 'רקע מודגש', onPrimaryContainer: 'טקסט על רקע מודגש' }],
  ['צבע משני', { secondary: 'משני', onSecondary: 'טקסט על משני', secondaryContainer: 'רקע משני', onSecondaryContainer: 'טקסט על רקע משני' }],
  ['צבע חם', { tertiary: 'חם', onTertiary: 'טקסט על חם', tertiaryContainer: 'רקע חם', onTertiaryContainer: 'טקסט על רקע חם' }],
  ['רקעים וטקסט', { background: 'רקע המסך', onBackground: 'טקסט על הרקע', surface: 'משטח', onSurface: 'טקסט', surfaceVariant: 'משטח שקט', onSurfaceVariant: 'טקסט שקט', surfaceContainerLowest: 'כרטיס', surfaceContainerLow: 'כרטיס שקט', surfaceContainer: 'משטח 3', surfaceContainerHigh: 'משטח 4', surfaceContainerHighest: 'משטח 5', outline: 'מסגרת', outlineVariant: 'מסגרת עדינה', error: 'מחיקה', onError: 'טקסט על מחיקה' }],
];
function designPage() {
  const path = 'content/design.json';
  const d = get(path);
  const palette = () => ({ ...S.catalog.palettes[S.mode], ...(get(path)[S.mode] ?? {}) });
  const preview = h('div', { class: 'phone', 'aria-label': 'תצוגה מקדימה' });
  const warn = h('div', { class: 'warn' });
  const refresh = () => {
    const p = palette(), x = get(path);
    phone(preview, p, x);
    warn.replaceChildren(...unreadable(p, S.catalog.contrast).map(([a, b, r, least]) => h('p', {}, `קשה לקרוא: ${a} על ${b} (${r.toFixed(1)}, צריך ${least})`)));
  };
  const color = (role, label) => {
    const input = h('input', { type: 'color', value: palette()[role].toLowerCase(), id: 'c-' + role, oninput: e => {
      edit(path, o => {
        o[S.mode] ??= {};
        if (e.target.value.toUpperCase() === S.catalog.palettes[S.mode][role]) delete o[S.mode][role]; else o[S.mode][role] = e.target.value.toUpperCase();
      }, false);
      refresh();
    } });
    return h('div', { class: 'color' }, input, h('label', { for: 'c-' + role }, label));
  };
  const slider = (key, label, min, max) => {
    const out = h('output', {}, Math.round((d[key] ?? 1) * 100) + '%');
    const id = 's-' + key;
    return h('div', { class: 'field' }, h('label', { for: id }, label, ' ', out),
      h('input', { id, type: 'range', min, max, step: '0.05', value: d[key] ?? 1, oninput: e => { out.textContent = Math.round(e.target.value * 100) + '%'; edit(path, o => { o[key] = +e.target.value; }, false); refresh(); } }));
  };
  refresh();
  return [h('h1', {}, 'עיצוב'),
    h('div', { class: 'split' },
      h('div', {},
        h('div', { class: 'row', role: 'group', 'aria-label': 'מצב' }, [['light', 'בהיר'], ['dark', 'כהה']].map(([m, label]) => button(label, () => { S.mode = m; draw(); }, S.mode === m ? 'chip on' : 'chip', { 'aria-pressed': String(S.mode === m) })),
          button('לאפס את הצבעים', () => edit(path, o => { o[S.mode] = {}; }), 'link')),
        COLOR_GROUPS.map(([title, roles]) => h('section', { class: 'card' }, h('h2', {}, title), h('div', { class: 'colors' }, Object.entries(roles).filter(([r]) => r in S.catalog.palettes.light).map(([r, l]) => color(r, l))))),
        h('section', { class: 'card' }, h('h2', {}, 'גדלים'), slider('textScale', 'גודל טקסט', 0.85, 1.3), slider('cornerScale', 'עיגול פינות', 0, 1.6), slider('spacingScale', 'רווחים', 0.7, 1.6),
          select('גופן הכותרות', d.headingFont ?? 'serif', [['serif', 'פרנק ריהל (עם תגים)'], ['sans', 'רוביק (בלי תגים)']], v => { edit(path, o => { o.headingFont = v; }, false); refresh(); }))),
      h('aside', {}, preview, warn))];
}

/** A small drawing of the home screen with the chosen colours. */
function phone(el, p, d) {
  for (const [k, v] of Object.entries(p)) el.style.setProperty('--' + k, v);
  el.style.setProperty('--scale', d.textScale ?? 1);
  el.style.setProperty('--corner', d.cornerScale ?? 1);
  el.style.setProperty('--gap', d.spacingScale ?? 1);
  el.classList.toggle('sans', d.headingFont === 'sans');
  el.replaceChildren(
    h('small', { class: 'p-quiet' }, 'יום שלישי'), h('h3', {}, 'בוקר טוב'),
    h('div', { class: 'p-tile p-primary' }, h('b', {}, 'עזרה עכשיו'), h('span', {}, 'גל של חרדה, התקף או רגע קשה')),
    h('h4', {}, 'התוכנית של היום'),
    h('div', { class: 'p-tile p-done' }, h('span', { class: 'p-ink' }, 'בוקר'), h('b', {}, 'לגלוש על הגל'), h('span', {}, 'הושלם')),
    h('div', { class: 'p-tile' }, h('span', { class: 'p-ink' }, 'צהריים'), h('b', {}, 'אימון מחשבות'), h('span', { class: 'p-quiet' }, 'שתי דקות')),
    h('div', { class: 'p-tile p-warm' }, h('b', {}, 'חלון הניתוח'), h('span', {}, 'מה שמחכה לשעה הקבועה')),
    h('div', { class: 'p-tile p-second' }, h('b', {}, 'חזרה קצרה'), h('span', {}, '3 שאלות מחכות לך')),
    h('div', { class: 'p-button' }, 'להתחיל'));
}

// ---------------------------------------------------------------- home screen
const BLOCKS = { plan: 'התוכנית של היום', reviews: 'חזרה קצרה', experiments: 'ניסוי מחכה לתוצאה', picture: 'התמונה שלך', window: 'חלון הניתוח', assessment: 'שאלון מעקב', cards: 'הכרטיסים שלי' };
const ROUTES = { learn: 'לימוד', tools: 'כלים', progress: 'התקדמות', chat: 'שיחה', review: 'חזרה', breathe: 'נשימה', urge: 'טיימר דחף', fact: 'עובדה מול סיפור', window: 'חלון הניתוח', letter: 'מכתב חמלה', experiment: 'ניסוי', checkin: 'צ׳ק-אין', training: 'אימון מחשבות', assessment: 'שאלון', profile: 'התמונה שלך', help: 'עזרה ותמיכה', sources: 'מקורות' };
function homePage() {
  const path = 'content/home.json';
  const o = get(path);
  const blocks = [...(o.blocks ?? []), ...S.catalog.homeBlocks.filter(b => !(o.blocks ?? []).some(x => x.id === b)).map(id => ({ id, visible: true }))];
  const cards = o.cards ?? [];
  const setBlocks = fn => edit(path, x => { x.blocks = blocks.map(b => ({ ...b })); fn(x.blocks); });
  const setCard = (n, fn, redraw = false) => edit(path, x => fn(x.cards[n]), redraw);
  return [h('h1', {}, 'מסך הבית'),
    h('p', { class: 'hint' }, '״עזרה עכשיו״ תמיד ראשון, ואי אפשר להסתיר אותו.'),
    h('ol', { class: 'cards' }, blocks.map((b, i) => h('li', { class: 'card item' + (b.visible === false ? ' dim' : '') },
      toggle(BLOCKS[b.id] ?? b.id, b.visible !== false, v => setBlocks(l => { l[i].visible = v; })),
      mover(i, blocks.length, (a, c) => setBlocks(l => swap(l, a, c)))))),
    h('div', { class: 'row between' }, h('h2', {}, 'הכרטיסים שלי'), button('כרטיס חדש', () => edit(path, x => (x.cards ??= []).push({ id: freshId('card', new Set(cards.map(c => c.id))), title: 'כרטיס חדש', body: '', icon: 'heart', lesson: '', route: 'learn', url: '' })), 'quiet')),
    cards.map((c, n) => {
      const kind = c.lesson ? 'lesson' : c.url !== '' && !c.route ? 'url' : 'route';
      return h('section', { class: 'card grid' },
        field('כותרת', c.title, v => setCard(n, x => { x.title = v; }), { max: 80 }),
        field('טקסט', c.body, v => setCard(n, x => { x.body = v; }), { max: 300 }),
        select('אייקון', c.icon, S.catalog.icons.map(i => [i, i]), v => setCard(n, x => { x.icon = v; })),
        select('לאן מוביל', kind, [['route', 'מסך באפליקציה'], ['lesson', 'שיעור'], ['url', 'אתר']], v => setCard(n, x => { x.route = v === 'route' ? 'learn' : ''; x.lesson = v === 'lesson' ? allLessons()[0]?.id ?? '' : ''; x.url = v === 'url' ? 'https://' : ''; }, true)),
        kind === 'lesson' ? select('שיעור', c.lesson, allLessons().map(l => [l.id, `${l.course} › ${l.title}`]), v => setCard(n, x => { x.lesson = v; }))
          : kind === 'url' ? field('כתובת', c.url, v => setCard(n, x => { x.url = v.trim(); }), { dir: 'ltr', max: 500 })
            : select('מסך', c.route, S.catalog.routes.map(r => [r, ROUTES[r] ?? r]), v => setCard(n, x => { x.route = v; })),
        button('למחוק כרטיס', () => edit(path, x => x.cards.splice(n, 1)), 'link danger'));
    })];
}

// ---------------------------------------------------------------- texts
function textsPage() {
  const path = 'content/texts.json';
  const changed = get(path) ?? {};
  const listEl = h('div');
  const known = new Set(S.catalog.texts.map(t => t.text));
  const items = [...S.catalog.texts, ...Object.keys(changed).filter(k => !known.has(k)).map(text => ({ screen: 'לא בשימוש', text }))];
  const fill = () => {
    const q = S.filter.trim();
    const hits = items.filter(t => !isLocked(t.text, S.catalog) && (q === '*' ? t.text in (get(path) ?? {}) : !q || t.text.includes(q) || t.screen.includes(q) || (get(path)?.[t.text] ?? '').includes(q)));
    listEl.replaceChildren(h('p', { class: 'hint' }, `${hits.length} טקסטים`), ...hits.slice(0, 120).map(t =>
      h('section', { class: 'card' }, field(`${t.screen} · ${t.text}`, get(path)?.[t.text] ?? '', v => edit(path, o => { if (v.trim()) o[t.text] = v; else delete o[t.text]; }, false), { max: 1000, area: t.text.length > 60, hint: 'ריק = הטקסט המקורי' }))),
      hits.length > 120 ? h('p', { class: 'hint' }, 'מוצגים 120 הראשונים. אפשר לחפש.') : '');
  };
  fill();
  return [h('h1', {}, 'טקסטים'),
    h('p', { class: 'hint' }, 'הטקסטים הקבועים במסכים. טקסטים של עזרה וחירום נעולים, וגם טקסטים שיש בהם מספר שמשתנה.'),
    h('div', { class: 'row' }, h('input', { type: 'search', value: S.filter === '*' ? '' : S.filter, placeholder: 'לחפש טקסט או מסך', 'aria-label': 'חיפוש', oninput: e => { S.filter = e.target.value; fill(); } }),
      button('רק מה ששיניתי', () => { S.filter = S.filter === '*' ? '' : '*'; draw(); }, S.filter === '*' ? 'chip on' : 'chip', { 'aria-pressed': String(S.filter === '*') })),
    listEl];
}

// ---------------------------------------------------------------- chat style
function chatPage() {
  const path = 'content/chat.json';
  return [h('h1', {}, 'סגנון השיחה'),
    h('p', { class: 'hint' }, 'איך עוגן מדבר: טון, אורך, דגשים. זה לא משנה את כללי הבטיחות, את זיהוי המצוקה ואת הכלל שלא מרגיעים בלופ.'),
    h('section', { class: 'card' }, field('העדפות סגנון', get(path)?.style ?? '', v => edit(path, o => { o.style = v; }, false), { area: true, max: 2000, hint: 'עד 2,000 תווים. לא כותבים כאן מידע אישי: זה נשמר בריפו, ולא בתיק המוצפן.' }))];
}

// ---------------------------------------------------------------- history
function historyPage() {
  const box = h('div', {}, h('p', { class: 'hint' }, 'טוען…'));
  S.gh.history().then(list => box.replaceChildren(h('ol', { class: 'cards' }, list.map((c, i) => h('li', { class: 'card item' },
    h('div', {}, h('strong', {}, c.message), h('small', {}, `${when(c.at)} · ${c.by} · ${c.sha.slice(0, 7)}`)),
    i === 0 ? h('small', {}, 'הגרסה הנוכחית') : button('לחזור לגרסה הזו', async () => {
      if (Object.keys(changes()).length) { toast('קודם מפרסמים או מבטלים את השינויים הפתוחים.', true); return; }
      if (!await confirm('לחזור לגרסה הזו?', 'ייווצר פרסום חדש עם התוכן הישן. שום גרסה לא נמחקת.', 'לחזור')) return;
      try { await S.gh.restore(S.base, c.sha, 'חזרה לגרסה ' + c.sha.slice(0, 7)); await reload(); toast('חזרת לגרסה הקודמת.'); } catch (e) { toast(e.message, true); }
      draw();
    }, 'quiet')))))).catch(e => box.replaceChildren(h('p', { class: 'error' }, e.message)));
  return [h('h1', {}, 'היסטוריה'), box];
}

// ---------------------------------------------------------------- start
window.addEventListener('beforeunload', e => { if (S.gh && Object.keys(changes()).length) e.preventDefault(); });

async function restoreDraft() {
  const d = drafts.read();
  if (!d?.edited) return;
  S.edited = d.edited;
  if (d.base !== S.base) toast('פורסמה גרסה חדשה מאז העריכה האחרונה. כדאי לעבור על השינויים לפני פרסום.');
}

(async () => {
  const token = keep.session();
  if (!token) { signIn(); return; }
  show(h('main', { class: 'signin' }, h('p', {}, 'טוען…')));
  try {
    S.gh = github(token, REPO);
    await reload();
    await restoreDraft();
    draw();
  } catch (e) {
    keep.lock();
    signIn(e instanceof GitHubError ? e.message : 'משהו השתבש. אפשר להתחבר שוב.');
  }
})();
