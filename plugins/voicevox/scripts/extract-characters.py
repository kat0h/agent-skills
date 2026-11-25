import re, json, glob, sys, os
d = sys.argv[1]
calls = open(os.path.join(d, 'callNameInfo.ts')).read()
out = []
for f in sorted(glob.glob(os.path.join(d, '*.ts'))):
    if os.path.basename(f) in ('callNameInfo.ts', 'helper.ts'): continue
    s = open(f).read()
    g = lambda k: (m := re.search(k + r':\s*\n?\s*"((?:[^"\\]|\\.)*)"', s)) and m.group(1)
    key = re.search(r'const key = "([^"]+)"', s).group(1)
    blk = re.search(r'\n  ' + re.escape(key) + r': \{(.*?)\n  \},', calls, re.S)
    me = you = []
    if blk:
        me = re.findall(r'"([^"]+)"', re.search(r'me: \[(.*?)\]', blk.group(1), re.S).group(1))
        you = re.findall(r'"([^"]+)"', re.search(r'you: \[(.*?)\]', blk.group(1), re.S).group(1))
    labels = re.findall(r'label: "([^"]+)",\s*value:\s*"((?:[^"\\]|\\.)*)"', s)
    out.append(dict(key=key, name=(re.search(r'\n  name: "([^"]+)"', s).group(1)), voice=g('voiceFeature'),
        description=re.sub(r'<br\s*/?>', '', g('description') or ''), labels=labels, me=me, you=you, detailUrl=g('detailUrl')))
json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
