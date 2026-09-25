"""Recursive-descent disassembly of REFLEX.EXE (Turbo C 1.x, small model).

Writes re/funcs.txt: every reachable function starting at main (0x01a5),
with DS string references annotated. Requires: pip install capstone
"""
import re, sys, os
ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..')
from capstone import *
d=open(os.path.join(ROOT,'sourcefiles/reflex/REFLEX.EXE'),'rb').read()
img=d[0x400:]; DS=0xd6e0; code=img[:DS]; data=img[DS:]
def dstr(o):
    if o<0x100 or o>=len(data): return None
    e=data.find(b'\0',o); s=data[o:e]
    if len(s)>=2 and all(32<=c<127 or c in (10,13) for c in s): return s.decode()
md=Cs(CS_ARCH_X86,CS_MODE_16)
funcs={}; seen={}; bound={}; jt={}
todo=[0x1a5]; ftodo=[0x1a5]
def dis_func(start):
    ins_map={}; work=[start]
    while work:
        a=work.pop()
        while a not in ins_map and a<DS:
            try: ins=next(md.disasm(code[a:a+16],a))
            except StopIteration: break
            ins_map[a]=ins
            m=ins.mnemonic; op=ins.op_str
            if m=='jmp' and 'cs:[bx + ' in op:
                T=int(re.search(r'cs:\[bx \+ 0x([0-9a-f]+)\]',op).group(1),16)
                # bound from previous cmp
                n=bound.get(start,8)
                for i in range(n+1):
                    t=code[T+2*i]|code[T+2*i+1]<<8
                    work.append(t); jt.setdefault(a,[]).append(t)
                break
            if m=='cmp' and op.startswith('ax, '):
                try: bound[start]=int(op[4:],16)
                except: pass
            if m=='lcall' and op.startswith('0, '):
                ftodo.append(int(op[3:],16))
            if m.startswith('j') or m in('loop','jcxz'):
                try:
                    t=int(op,16)&0xffff; work.append(t)
                except: pass
                if m=='jmp': break
            if m=='call':
                try: t=int(op,16)&0xffff; ftodo.append(t)
                except: pass
            if m in('ret','retf','iret'): break
            a+=ins.size
    return ins_map
done=set()
while ftodo:
    f=ftodo.pop()
    if f in done: continue
    done.add(f); funcs[f]=dis_func(f)
out=[]
for f in sorted(funcs):
    out.append(f"\n==== sub_{f:04x}")
    for a in sorted(funcs[f]):
        ins=funcs[f][a]; op=re.sub(r'0xffff([0-9a-f]{4})',r'0x\1',ins.op_str)
        t=f"{a:04x}: {ins.mnemonic} {op}"
        if ins.mnemonic in('push','mov') :
            for m in re.finditer(r'(?<![\[\w])0x([0-9a-f]{3,4})\b',op):
                s=dstr(int(m.group(1),16))
                if s: t+=f'   ; "{s[:50]}"'
        out.append(t)
os.makedirs(os.path.join(ROOT,'re'),exist_ok=True); open(os.path.join(ROOT,'re/funcs.txt'),'w').write('\n'.join(out))
print(len(funcs), sorted(hex(f) for f in funcs))
