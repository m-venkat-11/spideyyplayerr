"""
PIXEL DECK - Internal YouTube Music Search Microservice
Powered by ytmusicapi (queries YouTube Music structured catalog)

TRADEOFF / MAINTENANCE NOTE:
ytmusicapi is an unofficial library that interacts with YouTube Music's internal web API.
Unlike YouTube Data API v3, it provides complete structured metadata (artist, album,
duration, official track verification, high-res artwork) with no daily quota limits.
However, because it uses internal endpoints, changes on YouTube's backend can occasionally
require updating ytmusicapi (e.g. `pip install --upgrade ytmusicapi`).
"""

import sys
import json
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
from ytmusicapi import YTMusic

# Ensure UTF-8 output on all platforms (especially Windows)
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Initialize YTMusic instance
try:
    yt = YTMusic()
except Exception as e:
    sys.stderr.write(f"Failed to initialize YTMusic: {e}\n")
    yt = None

PORT = 5005

def format_duration(seconds):
    if not seconds or seconds < 0:
        return "00:00"
    m = seconds // 60
    s = seconds % 60
    return f"{m:02d}:{s:02d}"

def normalize_track(item):
    """Normalize ytmusicapi track item into PIXEL DECK internal model"""
    video_id = item.get("videoId")
    if not video_id:
        return None

    title = item.get("title") or "Unknown Title"

    # Extract clean artists list
    artists = item.get("artists") or []
    artist_names = [a.get("name") for a in artists if a.get("name")]
    artist_str = ", ".join(artist_names) if artist_names else "Official Artist"

    # Extract album
    album_obj = item.get("album")
    album_str = album_obj.get("name") if (album_obj and isinstance(album_obj, dict)) else "Official Release"

    # Parse duration in seconds
    dur_sec = item.get("duration_seconds")
    if dur_sec is None:
        dur_text = item.get("duration") or ""
        parts = dur_text.split(":")
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            dur_sec = int(parts[0]) * 60 + int(parts[1])
        elif len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit() and parts[2].isdigit():
            dur_sec = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        else:
            dur_sec = 210

    # Artwork resolution: prefer highest resolution available
    thumbnails = item.get("thumbnails") or []
    artwork = None
    if thumbnails:
        largest = thumbnails[-1].get("url")
        if largest:
            # Upgrade thumbnail dimensions to high resolution
            artwork = re.sub(r"=w\d+-h\d+", "=w500-h500", largest)
    if not artwork:
        artwork = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

    return {
        "id": f"yt_{video_id}",
        "provider": "youtube",
        "providerTrackId": video_id,
        "title": title,
        "artist": artist_str,
        "album": album_str,
        "artwork": artwork,
        "duration": dur_sec,
        "durationFormatted": format_duration(dur_sec),
        "playable": True,
        "sourceType": "youtube"
    }

def perform_search(query, page=1, limit=20):
    if not yt:
        raise RuntimeError("YTMusic client is not initialized")

    # Fetch enough results to satisfy page offset
    fetch_limit = min(80, page * limit + 10)
    raw_results = yt.search(query, filter="songs", limit=fetch_limit)
    
    tracks = []
    seen_ids = set()
    for item in raw_results:
        track = normalize_track(item)
        if track and track["providerTrackId"] not in seen_ids:
            seen_ids.add(track["providerTrackId"])
            tracks.append(track)

    # Server-side pagination slicing
    start_idx = (page - 1) * limit
    end_idx = start_idx + limit
    paginated_tracks = tracks[start_idx:end_idx]

    return paginated_tracks, len(tracks)

class SearchHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Concise logging
        sys.stdout.write(f"[SearchService] {args[0]} {args[1]}\n")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return

        if parsed.path != "/search":
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"error","message":"Not found"}')
            return

        params = parse_qs(parsed.query)
        query = params.get("query", params.get("q", [""]))[0]
        query = unquote(query).strip()

        try:
            page = max(1, int(params.get("page", ["1"])[0]))
        except ValueError:
            page = 1

        try:
            limit = min(50, max(5, int(params.get("limit", ["20"])[0])))
        except ValueError:
            limit = 20

        if not query:
            self.send_response(400)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "status": "error",
                "message": "Query parameter is required",
                "results": []
            }).encode("utf-8"))
            return

        try:
            tracks, total = perform_search(query, page, limit)
            response_data = {
                "status": "success",
                "query": query,
                "page": page,
                "limit": limit,
                "total": total,
                "results": tracks
            }
            body = json.dumps(response_data, ensure_ascii=False).encode("utf-8")

            self.send_response(200)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        except Exception as e:
            sys.stderr.write(f"Search error for '{query}': {e}\n")
            err_body = json.dumps({
                "status": "error",
                "message": f"Search execution failed: {str(e)}",
                "results": []
            }, ensure_ascii=False).encode("utf-8")

            self.send_response(500)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(err_body)))
            self.end_headers()
            self.wfile.write(err_body)

def run():
    server = HTTPServer(("127.0.0.1", PORT), SearchHandler)
    sys.stdout.write(f"PIXEL DECK Search Microservice running on http://127.0.0.1:{PORT}\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()

if __name__ == "__main__":
    run()
