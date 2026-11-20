def lum(h):
    h = h.lstrip('#')
    r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    def f(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)

def cr(a, b):
    la, lb = lum(a), lum(b)
    if la < lb:
        la, lb = lb, la
    return (la + 0.05) / (lb + 0.05)

L = {'bg': '#f4f6fa', 'surface': '#ffffff', 'surface2': '#e9edf4', 'text': '#161c2a', 'muted': '#455064', 'border': '#8892a6', 'accent': '#1a47c4', 'accent_text': '#ffffff', 'link': '#1a47c4',
     'amber_bg': '#fff1c7', 'amber_tx': '#452b00', 'amber_bd': '#8a5700', 'blue_bg': '#e1ebff', 'blue_tx': '#0e2766', 'blue_bd': '#2b55c7', 'red_bg': '#fde4e2', 'red_tx': '#5a0e08', 'red_bd': '#b42318',
     'grey_bg': '#e7ebf2', 'grey_tx': '#2a3244', 'grey_bd': '#6b768b', 'info_bg': '#e3edf4', 'info_tx': '#17364d', 'info_bd': '#3b6e95',
     'gA_bg': '#d9f2e1', 'gA_tx': '#0c4a28', 'gB_bg': '#dce8ff', 'gB_tx': '#12388f', 'gC_bg': '#e8e0ff', 'gC_tx': '#37238a', 'gD_bg': '#ffe6bd', 'gD_tx': '#5e3500', 'gN_bg': '#ffdada', 'gN_tx': '#6e0c0c'}
D = {'bg': '#0b101b', 'surface': '#131a29', 'surface2': '#1c2538', 'text': '#e8edf7', 'muted': '#b0bacd', 'border': '#6a7690', 'accent': '#8fb2ff', 'accent_text': '#0a1226', 'link': '#9dbaff',
     'amber_bg': '#3a2a06', 'amber_tx': '#ffe3a8', 'amber_bd': '#d99a1e', 'blue_bg': '#14264f', 'blue_tx': '#d3e2ff', 'blue_bd': '#7aa0ff', 'red_bg': '#40130f', 'red_tx': '#ffd6d1', 'red_bd': '#ff8272',
     'grey_bg': '#222c42', 'grey_tx': '#dde4f1', 'grey_bd': '#8793ac', 'info_bg': '#14303f', 'info_tx': '#cfe8f7', 'info_bd': '#6fb0d8',
     'gA_bg': '#12402a', 'gA_tx': '#c4f2d4', 'gB_bg': '#1b3270', 'gB_tx': '#d0defe', 'gC_bg': '#33276b', 'gC_tx': '#e0d8ff', 'gD_bg': '#4a3208', 'gD_tx': '#ffe2b0', 'gN_bg': '#521818', 'gN_tx': '#ffd5d5'}

for n, P in (('light', L), ('dark', D)):
    print(n)
    pairs = [('text', 'bg'), ('text', 'surface'), ('muted', 'surface'), ('muted', 'bg'), ('muted', 'surface2'), ('text', 'surface2'), ('accent_text', 'accent'), ('link', 'surface'), ('link', 'bg')]
    for k in ('amber', 'blue', 'red', 'grey', 'info'):
        pairs.append((k + '_tx', k + '_bg'))
    for g in 'ABCDN':
        pairs.append(('g' + g + '_tx', 'g' + g + '_bg'))
    for a, b in pairs:
        r = cr(P[a], P[b])
        print('  %-12s on %-10s %5.2f %s' % (a, b, r, 'ok' if r >= 4.5 else 'LOW'))
    for a, b in (('border', 'surface'), ('border', 'bg'), ('amber_bd', 'amber_bg'), ('blue_bd', 'blue_bg'), ('red_bd', 'red_bg'), ('grey_bd', 'grey_bg')):
        r = cr(P[a], P[b])
        print('  border %-9s on %-9s %5.2f %s' % (a, b, r, 'ok' if r >= 3 else 'LOW'))
