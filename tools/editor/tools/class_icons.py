# Proposed class icons (2026-11-10): flat one-color SVG symbols, 240 x 240. Writes references/icons/classes_new/svg/<Class>.svg and <Class>.png.
import math, os, subprocess
C = '#413c3b'
OUT = os.path.expanduser('~/ArcSpiritsArt/references/icons/classes_new/')
S = f'fill="none" stroke="{C}" stroke-linecap="round" stroke-linejoin="round"'
F = f'fill="{C}" fill-rule="evenodd"'
def star(cx, cy, R, r, n=4, rot=-90):
    pts = []
    for i in range(n * 2):
        a = math.radians(rot + i * 180 / n); k = R if i % 2 == 0 else r
        pts.append(f'{cx + k * math.cos(a):.1f},{cy + k * math.sin(a):.1f}')
    return 'M' + ' L'.join(pts) + ' Z'
def circ(cx, cy, r): return f'M{cx - r} {cy} a{r} {r} 0 1 0 {2 * r} 0 a{r} {r} 0 1 0 {-2 * r} 0 Z'
SWORD = 'M0 -100 L12 -78 L12 40 L40 40 L40 56 L10 56 L10 88 A12 12 0 1 1 -10 88 L-10 56 L-40 56 L-40 40 L-12 40 L-12 -78 Z'
I = {
 'Arcane Alchemist': f'<path {F} d="M96 22 L144 22 L144 38 L136 38 L136 86 C176 98 200 134 196 170 C192 204 160 222 120 222 C80 222 48 204 44 170 C40 134 64 98 104 86 L104 38 L96 38 Z {circ(100,170,14)} {circ(142,150,10)} {circ(134,190,8)}"/>',
 'Battle Adept': f'<g {S} stroke-width="14"><path d="M54 214 L168 54"/><path d="M186 214 L72 54"/></g><path {F} d="M150 30 C196 26 220 60 204 104 C196 80 176 70 150 76 Z"/><path {F} d="M90 30 C44 26 20 60 36 104 C44 80 64 70 90 76 Z"/>',
 'Captain': f'<path {S} stroke-width="16" d="M56 222 L56 22"/><path {F} d="M68 30 C110 14 140 54 204 34 L204 126 C140 146 110 106 68 122 Z"/>',
 'Healer': f'<path {F} d="M120 214 C40 160 16 116 24 78 C34 30 96 22 120 66 C144 22 206 30 216 78 C224 116 200 160 120 214 Z M106 84 L134 84 L134 108 L158 108 L158 136 L134 136 L134 160 L106 160 L106 136 L82 136 L82 108 L106 108 Z"/>',
 'Monster Hunter': f'<circle {S} stroke-width="16" cx="120" cy="120" r="74"/><g {S} stroke-width="14"><path d="M120 18 L120 76"/><path d="M120 164 L120 222"/><path d="M18 120 L76 120"/><path d="M164 120 L222 120"/></g><circle fill="{C}" cx="120" cy="120" r="14"/>',
 'Sharpshooter': f'<circle {S} stroke-width="14" cx="104" cy="136" r="80"/><circle {S} stroke-width="14" cx="104" cy="136" r="44"/><circle fill="{C}" cx="104" cy="136" r="14"/><path {S} stroke-width="12" d="M104 136 L206 34"/><path {F} d="M190 22 L222 18 L218 50 L204 44 L196 36 Z"/>',
 'Beast': f'<path {F} d="M40 30 C58 60 70 120 84 214 C104 150 112 84 100 30 Z"/><path {F} d="M200 30 C182 60 170 120 156 214 C136 150 128 84 140 30 Z"/><path {F} d="M104 30 L136 30 L120 96 Z"/>',
 'Cultivator': f'<path {S} stroke-width="14" d="M120 186 L120 96"/><path {F} d="M120 110 C120 60 80 36 36 40 C36 86 70 116 120 110 Z"/><path {F} d="M120 86 C124 46 160 26 204 34 C200 78 166 100 120 86 Z"/><path {F} d="M36 222 C56 180 184 180 204 222 Z"/>',
 'Cursed Spirit': f'<path {F} d="M120 22 C64 22 30 60 30 106 C30 136 44 156 66 168 L66 204 L88 204 L88 186 L110 186 L110 204 L130 204 L130 186 L152 186 L152 204 L174 204 L174 168 C196 156 210 136 210 106 C210 60 176 22 120 22 Z {circ(84,110,22)} {circ(156,110,22)} M120 132 L132 158 L108 158 Z"/>',
 'Elementalist': f'<path {F} d="M120 16 L164 60 L120 104 L76 60 Z"/><path {F} d="M180 76 L224 120 L180 164 L136 120 Z"/><path {F} d="M60 76 L104 120 L60 164 L16 120 Z"/><path {F} d="M120 136 L164 180 L120 224 L76 180 Z"/>',
 'Fighter': f'<g transform="translate(120 122) rotate(40)"><path {F} d="{SWORD}"/></g><g transform="translate(120 122) rotate(-40)"><path {F} d="{SWORD}"/></g>',
 'Mystic': f'<path {F} d="M14 120 C54 60 96 40 120 40 C144 40 186 60 226 120 C186 180 144 200 120 200 C96 200 54 180 14 120 Z {circ(120,120,46)}"/><circle fill="{C}" cx="120" cy="120" r="22"/>',
 'Assassin': f'<g transform="translate(120 120) rotate(45)"><path {F} d="M0 -112 C18 -70 16 -10 12 30 L44 30 L44 46 L10 46 L10 96 A10 10 0 1 1 -10 96 L-10 46 L-44 46 L-44 30 L-12 30 C-16 -10 -18 -70 0 -112 Z"/></g>',
 'Bastion': f'<path {F} d="M40 24 L74 24 L74 52 L103 52 L103 24 L137 24 L137 52 L166 52 L166 24 L200 24 L200 96 L182 96 L196 222 L44 222 L58 96 L40 96 Z M100 222 L100 172 A20 20 0 0 1 140 172 L140 222 Z"/>',
 'Cleric': f'<path {F} d="M96 18 L144 18 L144 76 L204 76 L204 124 L144 124 L144 222 L96 222 L96 124 L36 124 L36 76 L96 76 Z"/>',
 'Corruptor': f'<path {F} d="M20 40 L220 40 C220 70 206 84 196 84 C190 84 186 100 186 130 A14 14 0 1 1 158 130 C158 110 150 96 140 96 C130 96 124 120 124 176 A16 16 0 1 1 92 176 C92 130 86 96 74 96 C64 96 60 106 60 118 A12 12 0 1 1 36 118 C36 96 20 80 20 40 Z"/><circle fill="{C}" cx="172" cy="184" r="12"/>',
 'Druid': f'<path {F} d="M120 16 C160 16 184 44 180 76 C212 84 224 120 204 146 C188 168 156 170 136 160 L140 196 L172 222 L68 222 L100 196 L104 160 C84 170 52 168 36 146 C16 120 28 84 60 76 C56 44 80 16 120 16 Z"/>',
 'Fairy': f'<path {F} d="M114 116 C96 50 56 18 22 26 C10 72 40 120 114 124 Z"/><path {F} d="M126 116 C144 50 184 18 218 26 C230 72 200 120 126 124 Z"/><path {F} d="M114 132 C70 132 40 156 44 200 C80 212 108 184 114 132 Z"/><path {F} d="M126 132 C170 132 200 156 196 200 C160 212 132 184 126 132 Z"/><path {S} stroke-width="10" d="M120 96 L120 204"/>',
 'Huntress': f'<path {S} stroke-width="14" d="M30 210 L170 70"/><path {F} d="M222 18 C216 60 200 96 176 112 L128 64 C144 40 180 24 222 18 Z"/><path {S} stroke-width="10" d="M60 150 L44 134 M90 180 L106 196"/>',
 'King': f'<path {F} d="M30 190 L22 92 L70 132 L96 74 L120 120 L144 74 L170 132 L218 92 L210 190 Z"/><rect fill="{C}" x="30" y="200" width="180" height="22" rx="8"/><path {F} d="M110 16 L130 16 L130 30 L144 30 L144 48 L130 48 L130 70 L110 70 L110 48 L96 48 L96 30 L110 30 Z"/>',
 'Mage': f'<path {F} d="M128 14 C150 70 170 130 180 172 L60 172 C76 120 96 64 128 14 Z {star(122,116,26,10,5)}"/><path {F} d="M14 196 C60 168 180 168 226 196 C190 224 50 224 14 196 Z"/>',
 'Nomad': f'<circle {S} stroke-width="14" cx="120" cy="120" r="96"/><path {F} d="{star(120,120,78,18,4)}"/>',
 'Paladin': f'<path {F} d="M120 16 C150 36 180 44 210 44 C212 130 180 190 120 224 C60 190 28 130 30 44 C60 44 90 36 120 16 Z M108 64 L132 64 L132 96 L164 96 L164 120 L132 120 L132 176 L108 176 L108 120 L76 120 L76 96 L108 96 Z"/>',
 'Queen': f'<path {F} d="M60 186 L36 86 L84 130 L120 60 L156 130 L204 86 L180 186 Z"/><circle fill="{C}" cx="34" cy="74" r="14"/><circle fill="{C}" cx="206" cy="74" r="14"/><circle fill="{C}" cx="120" cy="42" r="18"/><path {F} d="M52 196 L188 196 L200 224 L40 224 Z"/>',
 'Relic Envoy': f'<path {F} d="M120 20 L186 96 L120 172 L54 96 Z M120 52 L146 96 L120 140 L94 96 Z"/><path {F} d="M24 176 C60 176 80 196 120 196 C160 196 180 176 216 176 L216 198 C180 198 160 224 120 224 C80 224 60 198 24 198 Z"/>',
 'Relic Sentinel': f'<path {F} d="M120 16 C150 36 180 44 210 44 C212 130 180 190 120 224 C60 190 28 130 30 44 C60 44 90 36 120 16 Z M120 62 L168 116 L120 178 L72 116 Z"/>',
 'Sentinel': f'<path {F} d="M120 16 C176 16 204 60 204 110 L204 200 L150 224 L150 150 L90 150 L90 224 L36 200 L36 110 C36 60 64 16 120 16 Z M60 100 L180 100 L180 122 L132 122 L132 150 L108 150 L108 122 L60 122 Z"/>',
 'Sorcerer': f'<path {S} stroke-width="14" d="M92 224 L130 104"/><path {F} d="M146 16 C186 16 214 46 210 82 C206 112 180 130 152 126 C176 114 186 92 178 70 C172 54 160 46 146 46 C122 46 110 70 118 92 C100 76 100 46 118 28 C126 20 136 16 146 16 Z"/><circle fill="{C}" cx="148" cy="80" r="16"/>',
 'Spellblade': f'<g transform="translate(104 132) rotate(30)"><path {F} d="{SWORD}"/></g><path {F} d="{star(190,52,34,10,4)}"/><path {F} d="{star(204,128,18,6,4)}"/>',
 'Summoner': f'<circle {S} stroke-width="12" cx="120" cy="120" r="100"/><circle {S} stroke-width="8" cx="120" cy="120" r="76"/><path {F} d="{star(120,120,70,28,5)}"/>',
 'Titan': f'<path {F} d="M120 60 C168 60 196 96 196 136 L196 206 L146 224 L146 168 L94 168 L94 224 L44 206 L44 136 C44 96 72 60 120 60 Z M68 122 L172 122 L172 142 L68 142 Z"/><path {F} d="M54 86 C24 76 12 46 20 14 C36 36 58 50 84 60 Z"/><path {F} d="M186 86 C216 76 228 46 220 14 C204 36 182 50 156 60 Z"/>',
 'Warden': f'<path {S} stroke-width="14" d="M120 224 L120 60"/><path {S} stroke-width="14" d="M56 40 C52 96 80 122 120 122 C160 122 188 96 184 40"/><path {F} d="M120 12 L140 52 L100 52 Z"/><path {F} d="M56 12 L74 50 L38 50 Z"/><path {F} d="M184 12 L202 50 L166 50 Z"/><path {S} stroke-width="12" d="M96 176 L144 176"/>',
 'Woundreaver': f'<path {S} stroke-width="14" d="M176 224 L88 30"/><path {F} d="M84 22 C140 10 200 36 226 100 C190 62 140 50 96 62 Z"/>',
}
os.makedirs(OUT + 'svg', exist_ok=True)
for name, body in I.items():
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">{body}</svg>'
    open(f'{OUT}svg/{name}.svg', 'w').write(svg)
    subprocess.run(['rsvg-convert', '-w', '240', '-h', '240', f'{OUT}svg/{name}.svg', '-o', f'{OUT}{name}.png'], check=True)
print(len(I))
