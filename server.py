#!/usr/bin/env python3
"""
Simple HTTP server for testing the markdown renderer
"""
import http.server
import socketserver
import os
from urllib.parse import urlparse

class MarkdownHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Content (posts, reading, favs) lives in the private repo checked
        # out at content/, mirroring the site's paths — fall back to it.
        local = super().translate_path(path)
        if not os.path.exists(local):
            content = super().translate_path('/content' + path)
            if os.path.exists(content):
                return content
        return local

    def do_GET(self):
        # Parse the URL
        parsed_url = urlparse(self.path)
        path = parsed_url.path

        # For .md files, serve them with proper content type
        if path.endswith('.md'):
            file_path = self.translate_path(path)
            if os.path.exists(file_path):
                self.send_response(200)
                self.send_header('Content-type', 'text/markdown')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                
                with open(file_path, 'rb') as f:
                    self.wfile.write(f.read())
                return
        
        # Default behavior for other files
        super().do_GET()

if __name__ == "__main__":
    PORT = 8001
    
    with socketserver.TCPServer(("", PORT), MarkdownHandler) as httpd:
        print(f"Server running at http://localhost:{PORT}")
        print("Press Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown() 