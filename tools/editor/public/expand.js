// Prompt template expansion. Used by the server and by the page preview.
//   - One prompt for each line. Empty lines and lines that start with # are ignored.
//   - {a|b|c} makes one prompt for each option. Multiple groups multiply.
//   - `params` is added to the end of each prompt (unless the prompt already has that flag).
//   - `repeat` sends each prompt that many times.
export const MAX_JOBS = 200;

function expandLine(line) {
  const m = line.match(/\{([^{}]*)\}/);
  if (!m) return [line];
  const out = [];
  for (const opt of m[1].split('|')) {
    out.push(...expandLine(line.slice(0, m.index) + opt.trim() + line.slice(m.index + m[0].length)));
    if (out.length > MAX_JOBS * 4) break;
  }
  return out;
}

// Short and long names of the same flag. A flag in the prompt text wins over the panel setting.
const ALIAS = { s: 'stylize', c: 'chaos', w: 'weird', aspect: 'ar', p: 'profile', niji: 'v', version: 'v' };
const canon = (flag) => { const n = flag.replace(/^--/, ''); return ALIAS[n] ?? n; };

function addParams(prompt, params) {
  if (!params) return prompt;
  const used = new Set([...prompt.matchAll(/(?:^|\s)(--[a-z]+)/g)].map((m) => canon(m[1])));
  let out = prompt;
  for (const f of params.split(/(?=(?:^|\s)--[a-z])/).map((x) => x.trim()).filter(Boolean)) {
    const name = f.split(/\s+/)[0];
    if (!name.startsWith('--') || !used.has(canon(name))) out += ` ${f}`;
  }
  return out;
}

export function expand({ text = '', params = '', repeat = 1, prefix = '', suffix = '' }) {
  const n = Math.max(1, Math.min(20, Number(repeat) || 1));
  const prompts = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    for (const p of expandLine(line)) {
      const body = p.replace(/\s+/g, ' ').trim();
      if (!body) continue;
      // `suffix` is the default prompt style. It goes after the text and before the flags.
      const cut = body.search(/(^|\s)--[a-z]/);
      const styled = !suffix.trim() ? body : cut < 0 ? `${body}, ${suffix.trim()}` : `${body.slice(0, cut).trim()}, ${suffix.trim()} ${body.slice(cut).trim()}`;
      const full = addParams(prefix ? `${prefix.trim()} ${styled}` : styled, params.trim());
      for (let i = 0; i < n; i++) prompts.push(full);
    }
  }
  return prompts;
}
