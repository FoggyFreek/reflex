"""Filter re/funcs.txt down to the game's own code (0x01a5-0x2cd0) and label
Turbo C / BGI library calls. Writes re/user.txt."""
import re, os
ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
names={0x4a88:'initgraph',0x4c1c:'setgraphmode',0x4c9c:'restorecrtmode',0x4cc9:'closegraph',0x4d66:'gfx_4d66',0x501b:'setfillstyle',0x517d:'setbkcolor',0x5281:'setpalette',0x533f:'putimage',0x5463:'settextstyle',0x579f:'setvisualpage',0x57c9:'setactivepage',0x59ff:'bar',0x5a22:'bar3d',0x5aea:'setcolor',0x5c28:'outtextxy',0x5d39:'putpixel',0x7f63:'bioskey',0x804d:'clrscr',0x8076:'textcolor',0x808c:'textbackground',0x8200:'cprintf',0x834a:'delay',0x846b:'exit',0x849a:'fclose',0x8725:'fopen',0x8799:'fprintf',0x8857:'fscanf',0x8b19:'fgetc',0x8b60:'getch',0x8be6:'gotoxy',0x8cc9:'registerbgidriver',0x8ced:'inport',0x8d01:'int86',0x8e39:'kbhit',0x9346:'outport',0x935e:'printf',0x9375:'lib_9375',0x9468:'fputc',0x9564:'srand',0x9575:'rand',0xa256:'sleep',0xa2b3:'sound',0xa2df:'nosound',0xa30c:'sprintf',0xa36a:'strcpy'}
txt=open(os.path.join(ROOT,'re/funcs.txt')).read()
blocks=re.split(r'\n==== sub_',txt)[1:]
out=[]
for b in blocks:
    name,body=b.split('\n',1); f=int(name,16)
    if not(0x1a5<=f<0x2cd0): continue
    out.append(f'\n==== sub_{f:04x}')
    for l in body.split('\n'):
        m=re.search(r'(call|lcall 0,) 0x([0-9a-f]+)$',l)
        if m and int(m.group(2),16) in names: l+='   ; '+names[int(m.group(2),16)]
        out.append(l)
open(os.path.join(ROOT,'re/user.txt'),'w').write('\n'.join(out))
print(len(out))
