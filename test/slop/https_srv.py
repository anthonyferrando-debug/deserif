#!/usr/bin/env python3
"""Static HTTPS server for the slop test. facebook.com is HSTS-preloaded, so the
fake feed has to come over TLS. Usage: https_srv.py PORT CERTDIR DOCROOT"""
import functools, http.server, os, ssl, sys

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

class Server(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        pass   # Chromium drops connections when it exits; not interesting

port, certdir, root = int(sys.argv[1]), sys.argv[2], sys.argv[3]
srv = Server(('127.0.0.1', port), functools.partial(Quiet, directory=root))
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(os.path.join(certdir, 'cert.pem'), os.path.join(certdir, 'key.pem'))
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
