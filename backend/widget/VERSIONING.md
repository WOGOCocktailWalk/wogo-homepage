# Booking widget version tag

Cloudflare and browsers keep `wogo-calendar.js` / `.css` for 4 hours. Every page
therefore loads them with a `?v=<hash>` tag. **After any change to the widget
files, refresh the tag in all pages** (otherwise visitors keep the old script
for up to 4 hours):

    python3 - <<'PY'
    import subprocess,re,hashlib
    v=hashlib.sha1(open('backend/widget/wogo-calendar.js','rb').read()+open('backend/widget/wogo-calendar.css','rb').read()).hexdigest()[:8]
    for f in subprocess.check_output(['git','ls-files','*.html']).decode().split():
        s=open(f).read()
        t=re.sub(r'(backend/widget/wogo-calendar\.(?:js|css))(\?v=[0-9a-f]+)?"', lambda m: m.group(1)+'?v='+v+'"', s)
        if t!=s: open(f,'w').write(t)
    PY
