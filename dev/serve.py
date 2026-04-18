import os, http.server, functools

os.chdir('/Users/chun/Documents/Python/gemini-chat-backup-tool')
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory='/Users/chun/Documents/Python/gemini-chat-backup-tool')
with http.server.HTTPServer(('', 3333), handler) as httpd:
    httpd.serve_forever()
