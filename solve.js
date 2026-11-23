// site-generator-speed round 2: a faster drop-in for makefun-site 1.0.0.
// Written from scratch against the vendor README + reference behaviour.
// Speed ideas: bulk HTML escaping (no regex per character), a fused
// Markdown scanner (no token objects, no per-line regexes), cached slugs
// with an ASCII fast path, a manual word counter, and a template walker
// that appends to one parts array with reusable loop scopes.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** HTML-escape `s` in one pass. Never called re-entrantly, so the shared regex is safe. */
function esc(s) {
  let out = '';
  let last = 0;
  ESC_RE.lastIndex = 0;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    out += s.slice(last, m.index) + ESC[m[0]];
    last = m.index + 1;
  }
  if (last === 0) return s;
  return out + s.slice(last);
}

/** True when code unit `c` is a JS \s whitespace character. */
function isWS(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

const WS128 = new Uint8Array(128);
WS128[9] = 1;
WS128[10] = 1;
WS128[11] = 1;
WS128[12] = 1;
WS128[13] = 1;
WS128[32] = 1;

/** The words of `text`: runs of non-whitespace characters, counted without a regex match array. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128 ? WS128[c] === 1 : isWS(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
}

const slugCache = new Map();

/** The slug of `text`, cached: titles, tags and headings repeat across a site. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  if (slugCache.size < 16384) slugCache.set(text, out);
  return out;
}

function slugifySlow(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) {
      ascii = false;
      break;
    }
  }
  // For pure ASCII, NFKD is the identity and there are no combining marks.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** `s[a..b)` with spaces/tabs trimmed at both ends (no allocation when already trimmed). */
function trimST(s, a, b) {
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(a, b);
}

function isBlankLine(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * Pass 1 finds the closing `---` line first (a parse error must not shadow "not closed");
 * pass 2 parses the header lines. `text` has "\n" line ends.
 */
export function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  let i = 4;
  let closeNl = -1;
  while (true) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    if (end - i === 3 && text.charCodeAt(i) === 45 && text.charCodeAt(i + 1) === 45 && text.charCodeAt(i + 2) === 45) {
      closeNl = nl;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    i = nl + 1;
  }
  const data = {};
  let j = 4;
  let lineNo = 2;
  while (j < i) {
    const nl = text.indexOf('\n', j);
    const end = nl === -1 || nl > i ? i : nl;
    const line = text.slice(j, end);
    if (!isBlankLine(text, j, end) && !line.startsWith('#')) {
      const c = line.indexOf(':');
      if (c < 1) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, c);
      let ok = true;
      for (let k = 0; k < key.length; k++) {
        const ch = key.charCodeAt(k);
        if (!((ch >= 97 && ch <= 122) || ch === 95)) {
          ok = false;
          break;
        }
      }
      if (!ok) return { error: `line ${lineNo} is not "key: value"` };
      const rest = line.slice(c + 1);
      let raw;
      if (rest === '') raw = '';
      else if (rest.charCodeAt(0) === 32) raw = trimST(rest, 1, rest.length);
      else return { error: `line ${lineNo} is not "key: value"` };
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1 || nl >= i) break;
    j = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Backslashes immediately before `j` (from `from`): odd means `j` is escaped. */
function escapedBefore(s, j, from) {
  let b = 0;
  let k = j - 1;
  while (k >= from && s.charCodeAt(k) === 92) {
    b++;
    k--;
  }
  return (b & 1) === 1;
}

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    if (!escapedBefore(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (!escapedBefore(s, j, from)) {
      if (s.charCodeAt(j + 1) !== 42) return j;
      j = s.indexOf('*', j + 2);
    } else {
      j = s.indexOf('*', j + 1);
    }
  }
  return -1;
}

/**
 * `s` rendered inline; `link(target)` is a link's href. A regex finds the next
 * special character so plain runs are copied in bulk instead of one char at a time.
 */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. A regex finds the next
 * special character so plain runs are copied in bulk instead of one char at a time.
 * The regex is shared: every branch restores lastIndex before the next exec,
 * and the fast path resets it, so the recursive calls cannot corrupt the scan.
 */
export function inline(s, link) {
  INLINE_RE.lastIndex = 0;
  let m = INLINE_RE.exec(s);
  if (m === null) return s;
  const parts = [];
  let last = 0;
  let i = 0;
  while (true) {
    const j = m.index;
    const c = m[0];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      parts.push(s.slice(last, j), ESC[c]);
      i = j + 1;
    } else if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        const n = s[j + 1];
        parts.push(s.slice(last, j), ESC[n] === undefined ? n : ESC[n]);
        i = j + 2;
      } else {
        parts.push(s.slice(last, j), '\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        parts.push(s.slice(last, j), '<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        parts.push(s.slice(last, j), '`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          parts.push(s.slice(last, j), '<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          i = k + 2;
        } else {
          parts.push(s.slice(last, j), '**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          parts.push(s.slice(last, j), '<em>', inline(s.slice(j + 1, k), link), '</em>');
          i = k + 1;
        } else {
          parts.push(s.slice(last, j), '*');
          i = j + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        parts.push(s.slice(last, j), '<a href="', esc(link(target)), '">', inline(s.slice(j + 1, k), link), '</a>');
        i = mm + 1;
      } else {
        parts.push(s.slice(last, j), '[');
        i = j + 1;
      }
    }
    last = i;
    INLINE_RE.lastIndex = i;
    m = INLINE_RE.exec(s);
    if (m === null) break;
  }
  parts.push(s.slice(last));
  return parts.join('');
}

// --- line classifiers over (src, pos, end), no per-line regexes ---

function fenceLang(src, pos, end) {
  if (end - pos < 3 || src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return null;
  let j = pos + 3;
  while (j < end) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = src.slice(pos + 3, j);
  while (j < end && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  return j === end ? lang : null;
}

function isFenceClose(src, pos, end) {
  if (end - pos < 3 || src.charCodeAt(pos) !== 96 || src.charCodeAt(pos + 1) !== 96 || src.charCodeAt(pos + 2) !== 96) return false;
  for (let j = pos + 3; j < end; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null (a heading's text is never empty). */
function headingOf(src, pos, end) {
  let n = 0;
  while (n < 6 && pos + n < end && src.charCodeAt(pos + n) === 35) n++;
  if (n === 0) return null;
  if (pos + n >= end) return null;
  const c = src.charCodeAt(pos + n);
  if (c !== 32 && c !== 9) return null;
  const text = trimST(src, pos + n, end);
  return text === '' ? null : { depth: n, text };
}

function isHR(src, pos, end) {
  if (end - pos < 3) return false;
  const a = src.charCodeAt(pos);
  const b = src.charCodeAt(pos + 1);
  const d = src.charCodeAt(pos + 2);
  if (!((a === 45 && b === 45 && d === 45) || (a === 42 && b === 42 && d === 42))) return false;
  for (let j = pos + 3; j < end; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * One dispatch for a line: 0 blank, 1 fence, 2 heading, 3 break, 4 quote,
 * 5 bullet list, 6 ordered list, 7 paragraph. Indented lines are only ever
 * blank or paragraph (every block marker is anchored at column 0).
 */
function lineKind(src, pos, end) {
  if (pos >= end) return 0;
  const c = src.charCodeAt(pos);
  if (c === 32 || c === 9) {
    for (let i = pos; i < end; i++) {
      const d = src.charCodeAt(i);
      if (d !== 32 && d !== 9) return 7;
    }
    return 0;
  }
  if (c === 96) return fenceLang(src, pos, end) === null ? 7 : 1;
  if (c === 35) return headingOf(src, pos, end) === null ? 7 : 2;
  if (c === 45 || c === 42) {
    if (isHR(src, pos, end)) return 3;
    return bulletAt(src, pos, end) === null ? 7 : 5;
  }
  if (c === 62) return 4;
  if (c >= 48 && c <= 57) return orderedAt(src, pos, end) === null ? 7 : 6;
  return 7;
}

/** Whether the line at (pos, end) ends a paragraph: blank, a fence, a heading or a break. */
function endsParagraph(src, pos, end) {
  const k = lineKind(src, pos, end);
  return k === 0 || k === 1 || k === 2 || k === 3;
}

/** Bullet item text start, or null. */
function bulletAt(src, pos, end) {
  if (end - pos < 2) return null;
  const c = src.charCodeAt(pos);
  if ((c === 45 || c === 42) && src.charCodeAt(pos + 1) === 32) return pos + 2;
  return null;
}

/** Ordered item { num, textStart }, or null. */
function orderedAt(src, pos, end) {
  let d = 0;
  while (d < 9 && pos + d < end) {
    const c = src.charCodeAt(pos + d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0) return null;
  if (pos + d + 1 >= end) return null;
  if (src.charCodeAt(pos + d) !== 46 || src.charCodeAt(pos + d + 1) !== 32) return null;
  return { num: Number(src.slice(pos, pos + d)), textStart: pos + d + 2 };
}

/** A line of two or more spaces then a non-space continues a list item. */
function isContinued(src, pos, end) {
  let n = 0;
  while (pos + n < end && src.charCodeAt(pos + n) === 32) n++;
  if (n < 2 || pos + n >= end) return false;
  return !isWS(src.charCodeAt(pos + n));
}

/**
 * `src` rendered: its HTML, its table of contents and its excerpt.
 * Lexing and rendering are fused: lines are scanned by index, blocks are
 * emitted straight to the parts array, no token objects are built.
 */
export function renderMarkdown(src, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const N = src.length;
  let pos = 0;
  while (pos < N) {
    const nl = src.indexOf('\n', pos);
    const end = nl === -1 ? N : nl;
    const next = nl === -1 ? N : nl + 1;
    const kind = lineKind(src, pos, end);
    if (kind === 0) {
      pos = next;
      continue;
    }
    if (kind === 1) {
      const lang = fenceLang(src, pos, end);
      const lines = [];
      pos = next;
      while (pos < N) {
        const nl2 = src.indexOf('\n', pos);
        const end2 = nl2 === -1 ? N : nl2;
        if (isFenceClose(src, pos, end2)) {
          pos = nl2 === -1 ? N : nl2 + 1;
          break;
        }
        lines.push(src.slice(pos, end2));
        pos = nl2 === -1 ? N : nl2 + 1;
      }
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      const body = lines.length === 0 ? '' : esc(lines.join('\n')) + '\n';
      blocks.push(`<pre><code${cls}>${body}</code></pre>`);
      continue;
    }
    if (kind === 2) {
      const hd = headingOf(src, pos, end);
      const id = uniqueSlug(slugify(hd.text), ids);
      const html = inline(hd.text, link);
      blocks.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      pos = next;
      continue;
    }
    if (kind === 3) {
      blocks.push('<hr>');
      pos = next;
      continue;
    }
    if (kind === 4) {
      let text = '';
      let first = true;
      while (pos < N) {
        const nl2 = src.indexOf('\n', pos);
        const end2 = nl2 === -1 ? N : nl2;
        if (src.charCodeAt(pos) !== 62) break;
        let st = pos + 1;
        if (src.charCodeAt(st) === 32) st++;
        const t = trimST(src, st, end2);
        if (t !== '') {
          if (!first) text += '\n';
          text += t;
          first = false;
        }
        pos = nl2 === -1 ? N : nl2 + 1;
      }
      blocks.push(text === '' ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(text, link)}</p>\n</blockquote>`);
      continue;
    }
    const bStart = kind === 5 ? bulletAt(src, pos, end) : null;
    const oStart = kind === 6 ? orderedAt(src, pos, end) : null;
    if (bStart !== null || oStart !== null) {
      const ordered = oStart !== null;
      const items = [trimST(src, ordered ? oStart.textStart : bStart, end)];
      const start = ordered ? oStart.num : 1;
      pos = next;
      while (pos < N) {
        const nl2 = src.indexOf('\n', pos);
        const end2 = nl2 === -1 ? N : nl2;
        const m2 = ordered ? orderedAt(src, pos, end2) : bulletAt(src, pos, end2);
        if (m2 !== null) {
          items.push(trimST(src, ordered ? m2.textStart : m2, end2));
          pos = nl2 === -1 ? N : nl2 + 1;
        } else if (isContinued(src, pos, end2)) {
          items[items.length - 1] += '\n' + trimST(src, pos, end2);
          pos = nl2 === -1 ? N : nl2 + 1;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let inner = '';
      for (const it of items) inner += `<li>${inline(it, link)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    let text = trimST(src, pos, end);
    pos = next;
    while (pos < N) {
      const nl2 = src.indexOf('\n', pos);
      const end2 = nl2 === -1 ? N : nl2;
      if (endsParagraph(src, pos, end2)) break;
      text += '\n' + trimST(src, pos, end2);
      pos = nl2 === -1 ? N : nl2 + 1;
    }
    const html = inline(text, link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

export const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line goes with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlankLine(src, lineStart, open) && isBlankLine(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Tree-walking renderer (baseline for A/B). */
export function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text': out.push(n.text); break;
      case 'var': out.push(esc(textOf(lookup(scope, n.path)))); break;
      case 'raw': out.push(textOf(lookup(scope, n.path))); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = { [n.name]: undefined, loop };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          loop.index = k + 1; loop.first = k === 0; loop.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s, cards) {
  const c = s.post ? cards.get(s) : cardOf(s);
  return {
    ...c,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const ck = `${dir}\0${target}`;
      const hit = linkCache.get(ck);
      if (hit !== undefined) {
        if (hit[1]) broken.add(`broken-link ${s.path} -> ${target}`);
        return hit[0];
      }
      let href;
      let isBroken = false;
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) href = target;
      else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
        else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
        else {
          href = target;
          isBroken = true;
        }
      }
      linkCache.set(ck, [href, isBroken]);
      if (isBroken) broken.add(`broken-link ${s.path} -> ${target}`);
      return href;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    const seen = new Set();
    s.tagRefs = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const rootScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates, escape: esc };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: rootScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pagesCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pagesCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
