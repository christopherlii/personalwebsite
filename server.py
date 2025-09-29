#!/usr/bin/env python3
"""
Simple HTTP server for testing the markdown renderer
"""
import http.server
import socketserver
import os
from urllib.parse import urlparse

class MarkdownHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Parse the URL
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        
        # If requesting the posts directory, serve a directory listing
        if path == '/posts/' or path == '/posts':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            
            # Generate directory listing
            posts_dir = 'posts'
            files = os.listdir(posts_dir)
            md_files = [f for f in files if f.endswith('.md')]
            
            html = f"""
            <!DOCTYPE html>
            <html>
            <head><title>Posts Directory</title></head>
            <body>
            <h1>Posts Directory</h1>
            <ul>
            """
            
            for file in md_files:
                html += f'<li><a href="{file}">{file}</a></li>'
            
            html += """
            </ul>
            </body>
            </html>
            """
            
            self.wfile.write(html.encode())
            return
        
        # For .md files, serve them with proper content type
        if path.endswith('.md'):
            file_path = path[1:]  # Remove leading slash
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
    PORT = 8000
    
    with socketserver.TCPServer(("", PORT), MarkdownHandler) as httpd:
        print(f"Server running at http://localhost:{PORT}")
        print("Press Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown() 