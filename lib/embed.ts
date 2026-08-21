/** Turns a shared document link into one that actually renders in an iframe. */

export function parseUrl(raw: string): URL | null {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

export function toEmbedUrl(rawUrl: string): string {
    const cleaned = String(rawUrl).trim();
    const u = parseUrl(cleaned);
    if (!u) return cleaned;

    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');

    // Already in an embeddable form — leave it untouched.
    if (/\/(preview|embed|pub|pubhtml|htmlembed|viewform|embeddedfolderview)$/.test(path)
        || /\/embed\//.test(path)
        || path === '/embeddedfolderview') {
        return u.href;
    }

    const gid = u.searchParams.get('gid');

    if (host === 'docs.google.com' || host === 'www.docs.google.com') {
        // Published (".../d/e/<token>/...") links use a different id space.
        let m = path.match(/^\/document\/d\/e\/([\w-]+)/);
        if (m) return 'https://docs.google.com/document/d/e/' + m[1] + '/pub?embedded=true';
        m = path.match(/^\/spreadsheets\/d\/e\/([\w-]+)/);
        if (m) return 'https://docs.google.com/spreadsheets/d/e/' + m[1] + '/pubhtml?widget=true&headers=false';
        m = path.match(/^\/presentation\/d\/e\/([\w-]+)/);
        if (m) return 'https://docs.google.com/presentation/d/e/' + m[1] + '/embed?start=false&loop=false&delayms=60000';

        m = path.match(/^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (m) return 'https://docs.google.com/document/d/' + m[1] + '/preview';
        m = path.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (m) return 'https://docs.google.com/spreadsheets/d/' + m[1] + '/preview' + (gid ? '?gid=' + encodeURIComponent(gid) : '');
        m = path.match(/^\/presentation\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (m) return 'https://docs.google.com/presentation/d/' + m[1] + '/embed?start=false&loop=false&delayms=60000&rm=minimal';
        m = path.match(/^\/forms\/(?:u\/\d+\/)?d\/e\/([\w-]+)/);
        if (m) return 'https://docs.google.com/forms/d/e/' + m[1] + '/viewform?embedded=true';
        m = path.match(/^\/forms\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (m) return 'https://docs.google.com/forms/d/' + m[1] + '/viewform?embedded=true';
        // Legacy docs.google.com/file/d/... links point at Drive content.
        m = path.match(/^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    }

    if (host === 'drive.google.com') {
        let m = path.match(/^\/file\/(?:u\/\d+\/)?d\/([\w-]+)/);
        if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
        m = path.match(/^\/(?:drive\/)?(?:u\/\d+\/)?folders\/([\w-]+)/);
        if (m) return 'https://drive.google.com/embeddedfolderview?id=' + m[1] + '#grid';
        if (/^\/(open|uc)$/.test(path)) {
            const id = u.searchParams.get('id');
            if (id) return 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/preview';
        }
    }

    return u.href;
}
