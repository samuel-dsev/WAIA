// Small bounded reader for the provider's static public HTML. It never evaluates
// scripts, follows resources or renders remote markup.
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', acute: '´', ordm: 'º', ordf: 'ª', sup2: '²', copy: '©' };
for (const [names, characters] of [
  ['agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml times oslash ugrave uacute ucirc uuml yacute thorn szlig', 'àáâãäåæçèéêëìíîïðñòóôõö×øùúûüýþß'],
]) names.split(' ').forEach((name, index) => { entities[name] = characters[index]; entities[name[0].toUpperCase() + name.slice(1)] = characters[index].toUpperCase(); });

export function decodeHtml(value) {
  return String(value).replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (original, entity) => {
    if (!entity.startsWith('#')) return entities[entity] ?? original;
    const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
  }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

export function readPublicHtml(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024) throw new TypeError('HTML público excede o limite.');
  const root = { tag: 'root', attrs: {}, children: [] }, stack = [root];
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const content = html.replace(/<!--[\s\S]*?-->|<(script|style|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '');
  let nodes = 0;
  for (const match of content.matchAll(/<\/?[a-z][^>]*>|[^<]+/giu)) {
    if (++nodes > 100_000 || stack.length > 100) throw new TypeError('HTML público excede a complexidade permitida.');
    const token = match[0];
    if (!token.startsWith('<')) { stack.at(-1).children.push(decodeHtml(token)); continue; }
    const tag = token.match(/^<\/?([a-z][\w:-]*)/iu)?.[1].toLowerCase();
    if (!tag) continue;
    if (token.startsWith('</')) {
      const position = stack.findLastIndex(node => node.tag === tag);
      if (position > 0) stack.length = position;
      continue;
    }
    const attrs = {};
    for (const attr of token.slice(tag.length + 1).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
      const key = attr[1].toLowerCase();
      if (['class', 'id', 'href', 'src', 'srcset', 'value', 'title', 'name', 'content'].includes(key)) attrs[key] = decodeHtml(attr[2] ?? attr[3] ?? attr[4]);
    }
    const node = { tag, attrs, children: [] };
    stack.at(-1).children.push(node);
    if (!voids.has(tag) && !token.endsWith('/>')) stack.push(node);
  }
  return root;
}

export const hasClass = (node, name) => Boolean(node?.attrs?.class?.split(/\s+/u).includes(name));
export function findHtml(node, predicate) {
  const result = [], pending = [node];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') continue;
    if (predicate(current)) result.push(current);
    pending.push(...current.children.slice().reverse());
  }
  return result;
}
export function htmlText(node, { paragraphs = false } = {}) {
  if (typeof node === 'string') return node;
  const body = node.children.map(child => htmlText(child, { paragraphs })).join(' ');
  return ((paragraphs && ['br', 'p', 'div', 'li', 'h5'].includes(node.tag)) ? body + '\n' : body)
    .replace(/[ \t\r]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}
