// Chat filter: masks common insults/slurs (English, German, Turkish) and personal info.
// Deliberately conservative — it only catches obvious cases; the report button handles the rest.

// Matched at the start of a word, any ending (e.g. "fuck" also catches "fucking").
const STEMS = [
  'fuck', 'motherf', 'shitt', 'shithead', 'bullshit', 'cunt', 'bitch', 'asshole', 'arsehole', 'dickhead', 'wanker', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'kike', 'chink', 'spastic',
  'hurensohn', 'wichser', 'fotze', 'schlampe', 'missgeburt', 'schwuchtel', 'arschloch', 'ficken', 'fick dich',
  'orospu', 'siktir', 'sikerim', 'sikeyim', 'yarrak', 'amına', 'amina koy', 'ananı', 'pezevenk', 'kahpe', 'gavat',
];
// Only matched as whole words (too short or too common inside other words).
const WORDS = ['shit', 'shits', 'fag', 'fags', 'cock', 'cocks', 'pussy', 'twat', 'spic', 'spast', 'amk', 'aq', 'piç', 'göt'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
const L = '\\p{L}\\p{N}';
const STEM_RE = new RegExp(`(^|[^${L}])(${STEMS.map(esc).join('|')})[${L}]*`, 'giu');
const WORD_RE = new RegExp(`(^|[^${L}])(${WORDS.map(esc).join('|')})(?=$|[^${L}])`, 'giu');
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE_RE = /(?:\+|\b0)\d[\d\s\-/().]{6,}\d/g; // starts with + or 0, like real phone numbers
const HANDLE_RE = /(^|\s)@[\w.]{3,}/g;

const mask = (w) => w[0] + '•'.repeat(Math.max(2, [...w].length - 1));

export function filterText(text) {
  return text
    .replace(EMAIL_RE, '[email hidden]')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '[number hidden]' : m))
    .replace(HANDLE_RE, '$1[handle hidden]')
    .replace(STEM_RE, (m, pre, w) => pre + mask(m.slice(pre.length)))
    .replace(WORD_RE, (m, pre, w) => pre + mask(w));
}
