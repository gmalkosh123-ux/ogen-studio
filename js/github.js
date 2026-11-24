// Talks to one private repository on api.github.com. The token is passed in and never stored here.
const API = 'https://api.github.com/repos/';

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const explain = status => ({
  401: 'GitHub לא קיבל את הטוקן. אולי פג תוקפו.',
  403: 'לטוקן אין הרשאה לפעולה הזו, או שהגעת למגבלת הבקשות.',
  404: 'ריפו התוכן לא נמצא. כדאי לבדוק שלטוקן יש גישה ל-ogen-content.',
  409: 'ריפו התוכן ריק או נעול כרגע.',
  422: 'GitHub לא קיבל את השינוי. ייתכן שמישהו פרסם בינתיים.',
}[status] || `GitHub החזיר שגיאה (קוד ${status}).`);

const utf8 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

export function github(token, repo) {
  async function call(path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
    let r;
    try {
      r = await fetch(API + repo + '/' + path, {
        method,
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: accept, Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new GitHubError(0, 'אין חיבור ל-GitHub. אם הרשת מסוננת, ייתכן שהסינון חוסם אותו.');
    }
    if (!r.ok) throw new GitHubError(r.status, explain(r.status));
    return r.json();
  }

  const head = async () => (await call('git/ref/heads/main')).object.sha;

  /** Every content file of the newest version, plus the catalog that describes the app. */
  async function load() {
    const sha = await head();
    const tree = await call(`git/trees/${sha}?recursive=1`);
    const wanted = tree.tree.filter(f => f.type === 'blob' && (/^content\/.*\.json$/.test(f.path) || f.path === 'catalog.json'));
    const texts = await Promise.all(wanted.map(async f => [f.path, utf8((await call('git/blobs/' + f.sha)).content)]));
    const files = Object.fromEntries(texts);
    if (!files['catalog.json']) throw new GitHubError(404, 'חסר הקובץ catalog.json בריפו התוכן.');
    const catalog = JSON.parse(files['catalog.json']);
    delete files['catalog.json'];
    return { sha, files, catalog };
  }

  /** One commit with all changes. changes: path to text, or null to delete. Fails if base is not the newest. */
  async function publish(base, changes, message) {
    if (await head() !== base) throw new GitHubError(422, 'פורסמה בינתיים גרסה אחרת. טוענים אותה ומנסים שוב.');
    const commit = await call('git/commits/' + base);
    const tree = await call('git/trees', {
      method: 'POST',
      body: {
        base_tree: commit.tree.sha,
        tree: Object.entries(changes).map(([path, text]) => text === null
          ? { path, mode: '100644', type: 'blob', sha: null }
          : { path, mode: '100644', type: 'blob', content: text }),
      },
    });
    return advance(base, tree.sha, message);
  }

  async function advance(base, treeSha, message) {
    const c = await call('git/commits', { method: 'POST', body: { message, tree: treeSha, parents: [base] } });
    await call('git/refs/heads/main', { method: 'PATCH', body: { sha: c.sha, force: false } });
    return c.sha;
  }

  async function history() {
    const list = await call('commits?sha=main&path=content&per_page=40');
    return list.map(c => ({ sha: c.sha, message: c.commit.message.split('\n')[0], at: c.commit.committer.date, by: c.commit.author.name }));
  }

  /** A new version whose content folder is the one of an older version. Nothing is erased from the history. */
  async function restore(base, old, message) {
    if (await head() !== base) throw new GitHubError(422, 'פורסמה בינתיים גרסה אחרת. טוענים אותה ומנסים שוב.');
    const folder = async sha => {
      const c = await call('git/commits/' + sha);
      const t = await call('git/trees/' + c.tree.sha);
      return { root: c.tree.sha, content: t.tree.find(f => f.path === 'content' && f.type === 'tree')?.sha };
    };
    const [now, then] = [await folder(base), await folder(old)];
    if (!then.content) throw new GitHubError(404, 'בגרסה הזו אין תוכן.');
    const tree = await call('git/trees', { method: 'POST', body: { base_tree: now.root, tree: [{ path: 'content', mode: '040000', type: 'tree', sha: then.content }] } });
    return advance(base, tree.sha, message);
  }

  return { load, publish, history, restore };
}
