"""YouTube Data API v3 integration — OAuth and video upload.

Wraps the synchronous ``google-api-python-client`` library with
``asyncio.to_thread`` so callers can use ``await`` without blocking
the event loop.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog

from shortsfactory.core.security import decrypt_value, encrypt_value

logger: structlog.stdlib.BoundLogger = structlog.get_logger(__name__)


class YouTubeService:
    """High-level service for YouTube OAuth and video uploads."""

    SCOPES = [
        "https://www.googleapis.com/auth/youtube.upload",
        "https://www.googleapis.com/auth/youtube",
    ]

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        encryption_key: str,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.encryption_key = encryption_key
        # Store PKCE code_verifiers keyed by OAuth state parameter
        self._pending_states: dict[str, str | None] = {}

    # ── OAuth ────────────────────────────────────────────────────────────

    def _client_config(self) -> dict[str, Any]:
        """Build a client config dict for ``google_auth_oauthlib``."""
        return {
            "web": {
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        }

    def get_auth_url(self) -> tuple[str, str]:
        """Generate the Google OAuth consent URL for YouTube authorization.

        Uses manual URL construction to avoid google_auth_oauthlib's
        automatic PKCE (which requires persisting code_verifier state).
        """
        import secrets
        from urllib.parse import urlencode

        state = secrets.token_urlsafe(24)
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": " ".join(self.SCOPES),
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        }
        auth_url = f"https://accounts.google.com/o/oauth2/auth?{urlencode(params)}"
        return auth_url, state

    async def handle_callback(self, code: str, state: str | None = None) -> dict[str, Any]:
        """Exchange an authorization code for OAuth tokens.

        Uses direct HTTP token exchange (no PKCE) to avoid state
        persistence issues with google_auth_oauthlib.
        """

        def _exchange() -> dict[str, Any]:
            import httpx as _httpx
            from google.oauth2.credentials import Credentials
            from googleapiclient.discovery import build

            # Exchange code for tokens via direct HTTP POST
            token_resp = _httpx.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "redirect_uri": self.redirect_uri,
                    "grant_type": "authorization_code",
                },
            )
            token_resp.raise_for_status()
            token_data = token_resp.json()

            credentials = Credentials(
                token=token_data["access_token"],
                refresh_token=token_data.get("refresh_token"),
                token_uri="https://oauth2.googleapis.com/token",
                client_id=self.client_id,
                client_secret=self.client_secret,
                scopes=self.SCOPES,
            )

            # Encrypt tokens.
            access_enc, key_ver = encrypt_value(credentials.token, self.encryption_key)
            refresh_enc = ""
            if credentials.refresh_token:
                refresh_enc, _ = encrypt_value(credentials.refresh_token, self.encryption_key)

            # Fetch channel info.
            youtube = build("youtube", "v3", credentials=credentials)
            response = youtube.channels().list(part="snippet", mine=True).execute()
            items = response.get("items", [])
            if not items:
                raise ValueError("No YouTube channel found for this account")

            channel = items[0]
            return {
                "channel_id": channel["id"],
                "channel_name": channel["snippet"]["title"],
                "access_token_encrypted": access_enc,
                "refresh_token_encrypted": refresh_enc,
                "token_key_version": key_ver,
                "token_expiry": credentials.expiry,
            }

        result = await asyncio.to_thread(_exchange)
        logger.info(
            "youtube_oauth_callback_success",
            channel_id=result["channel_id"],
            channel_name=result["channel_name"],
        )
        return result

    # ── Credentials ──────────────────────────────────────────────────────

    def _build_credentials(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
    ) -> Any:
        """Decrypt tokens and construct a ``google.oauth2.credentials.Credentials``."""
        from google.oauth2.credentials import Credentials

        access_token = decrypt_value(access_token_encrypted, self.encryption_key)
        refresh_token = None
        if refresh_token_encrypted:
            refresh_token = decrypt_value(refresh_token_encrypted, self.encryption_key)

        # Google's Credentials uses naive datetimes internally (utcnow),
        # so strip timezone info to avoid comparison errors.
        expiry = token_expiry
        if expiry and expiry.tzinfo is not None:
            expiry = expiry.replace(tzinfo=None)

        return Credentials(
            token=access_token,
            refresh_token=refresh_token,
            token_uri="https://oauth2.googleapis.com/token",
            client_id=self.client_id,
            client_secret=self.client_secret,
            expiry=expiry,
        )

    # ── Upload ───────────────────────────────────────────────────────────

    async def delete_video(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
        video_id: str,
    ) -> None:
        """Delete a video from YouTube via the Data API v3."""
        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _do_delete() -> None:
            from googleapiclient.discovery import build

            youtube = build("youtube", "v3", credentials=credentials)
            youtube.videos().delete(id=video_id).execute()

        await asyncio.to_thread(_do_delete)
        logger.info("youtube_video_deleted", video_id=video_id)

    async def upload_video(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
        video_path: Path,
        title: str,
        description: str,
        tags: list[str],
        privacy_status: str,
        thumbnail_path: Path | None = None,
    ) -> dict[str, str]:
        """Upload a video to YouTube via the Data API v3.

        Returns a dict with ``video_id`` and ``url``.
        """
        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _do_upload() -> dict[str, str]:
            from googleapiclient.discovery import build
            from googleapiclient.http import MediaFileUpload

            youtube = build("youtube", "v3", credentials=credentials)

            body: dict[str, Any] = {
                "snippet": {
                    "title": title,
                    "description": description,
                    "tags": tags,
                    "categoryId": "22",  # "People & Blogs"
                },
                "status": {
                    "privacyStatus": privacy_status,
                    "selfDeclaredMadeForKids": False,
                },
            }

            media = MediaFileUpload(
                str(video_path),
                mimetype="video/mp4",
                resumable=True,
                chunksize=10 * 1024 * 1024,  # 10 MB chunks
            )

            request = youtube.videos().insert(
                part="snippet,status",
                body=body,
                media_body=media,
            )

            response = None
            while response is None:
                _, response = request.next_chunk()

            video_id = response["id"]
            url = f"https://www.youtube.com/watch?v={video_id}"

            # Set thumbnail if provided.
            if thumbnail_path and thumbnail_path.exists():
                try:
                    youtube.thumbnails().set(
                        videoId=video_id,
                        media_body=MediaFileUpload(str(thumbnail_path), mimetype="image/jpeg"),
                    ).execute()
                    logger.info(
                        "youtube_thumbnail_set",
                        video_id=video_id,
                    )
                except Exception:
                    logger.warning(
                        "youtube_thumbnail_set_failed",
                        video_id=video_id,
                        exc_info=True,
                    )

            return {"video_id": video_id, "url": url}

        logger.info(
            "youtube_upload_starting",
            video_path=str(video_path),
            title=title,
            privacy=privacy_status,
        )
        result = await asyncio.to_thread(_do_upload)
        logger.info(
            "youtube_upload_complete",
            video_id=result["video_id"],
            url=result["url"],
        )
        return result

    # ── Token refresh ────────────────────────────────────────────────────

    async def refresh_tokens_if_needed(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
    ) -> dict[str, Any] | None:
        """Refresh the access token if it has expired.

        Returns updated encrypted tokens dict if refreshed, or ``None`` if
        the token is still valid.
        """
        if token_expiry:
            # Ensure both datetimes are timezone-aware for comparison
            expiry = token_expiry if token_expiry.tzinfo else token_expiry.replace(tzinfo=UTC)
            if expiry > datetime.now(UTC):
                return None

        if not refresh_token_encrypted:
            logger.warning("youtube_no_refresh_token")
            return None

        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _refresh() -> dict[str, Any]:
            import google.auth.transport.requests

            request = google.auth.transport.requests.Request()
            credentials.refresh(request)

            new_access_enc, key_ver = encrypt_value(credentials.token, self.encryption_key)
            result: dict[str, Any] = {
                "access_token_encrypted": new_access_enc,
                "token_key_version": key_ver,
                "token_expiry": credentials.expiry,
            }
            if credentials.refresh_token:
                new_refresh_enc, _ = encrypt_value(credentials.refresh_token, self.encryption_key)
                result["refresh_token_encrypted"] = new_refresh_enc
            return result

        updated = await asyncio.to_thread(_refresh)
        logger.info("youtube_token_refreshed")
        return updated

    # ── Playlists ─────────────────────────────────────────────────────────

    async def create_playlist(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
        title: str,
        description: str,
        privacy_status: str,
    ) -> dict[str, Any]:
        """Create a new YouTube playlist and return its metadata.

        Returns a dict with ``playlist_id``, ``title``, ``description``,
        ``privacy_status``, and ``item_count``.
        """
        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _create() -> dict[str, Any]:
            from googleapiclient.discovery import build

            youtube = build("youtube", "v3", credentials=credentials)
            body = {
                "snippet": {
                    "title": title,
                    "description": description,
                },
                "status": {"privacyStatus": privacy_status},
            }
            response = youtube.playlists().insert(part="snippet,status", body=body).execute()
            return {
                "playlist_id": response["id"],
                "title": response["snippet"]["title"],
                "description": response["snippet"].get("description", ""),
                "privacy_status": response["status"]["privacyStatus"],
                "item_count": response["contentDetails"].get("itemCount", 0)
                if "contentDetails" in response
                else 0,
            }

        result = await asyncio.to_thread(_create)
        logger.info("youtube_playlist_created", playlist_id=result["playlist_id"], title=title)
        return result

    async def list_playlists(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
    ) -> list[dict[str, Any]]:
        """Return all playlists owned by the authenticated channel.

        Each entry contains ``playlist_id``, ``title``, ``description``,
        ``privacy_status``, and ``item_count``.
        """
        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _list() -> list[dict[str, Any]]:
            from googleapiclient.discovery import build

            youtube = build("youtube", "v3", credentials=credentials)
            results: list[dict[str, Any]] = []
            page_token: str | None = None

            while True:
                kwargs: dict[str, Any] = {
                    "part": "snippet,status,contentDetails",
                    "mine": True,
                    "maxResults": 50,
                }
                if page_token:
                    kwargs["pageToken"] = page_token

                response = youtube.playlists().list(**kwargs).execute()
                for item in response.get("items", []):
                    results.append(
                        {
                            "playlist_id": item["id"],
                            "title": item["snippet"]["title"],
                            "description": item["snippet"].get("description", ""),
                            "privacy_status": item["status"]["privacyStatus"],
                            "item_count": item.get("contentDetails", {}).get("itemCount", 0),
                        }
                    )
                page_token = response.get("nextPageToken")
                if not page_token:
                    break

            return results

        return await asyncio.to_thread(_list)

    async def add_to_playlist(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
        playlist_id: str,
        video_id: str,
    ) -> dict[str, Any]:
        """Add a video to a playlist.

        Returns the created playlist item resource dict (includes ``id``).
        """
        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _add() -> dict[str, Any]:
            from googleapiclient.discovery import build

            youtube = build("youtube", "v3", credentials=credentials)
            body = {
                "snippet": {
                    "playlistId": playlist_id,
                    "resourceId": {
                        "kind": "youtube#video",
                        "videoId": video_id,
                    },
                }
            }
            return youtube.playlistItems().insert(part="snippet", body=body).execute()  # type: ignore[no-any-return]

        result = await asyncio.to_thread(_add)
        logger.info(
            "youtube_playlist_item_added",
            playlist_id=playlist_id,
            video_id=video_id,
            item_id=result.get("id"),
        )
        return result

    async def delete_playlist(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
        playlist_id: str,
    ) -> None:
        """Delete a YouTube playlist by its playlist ID."""
        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        def _delete() -> None:
            from googleapiclient.discovery import build

            youtube = build("youtube", "v3", credentials=credentials)
            youtube.playlists().delete(id=playlist_id).execute()

        await asyncio.to_thread(_delete)
        logger.info("youtube_playlist_deleted", playlist_id=playlist_id)

    # ── Analytics ─────────────────────────────────────────────────────────

    async def get_video_stats(
        self,
        access_token_encrypted: str,
        refresh_token_encrypted: str | None,
        token_expiry: datetime | None,
        video_ids: list[str],
    ) -> list[dict[str, Any]]:
        """Fetch statistics and snippet for a batch of video IDs.

        Returns a list of dicts with ``video_id``, ``title``, ``views``,
        ``likes``, ``comments``, and ``published_at``.  The YouTube API
        silently omits videos that do not exist or are private, so the
        returned list may be shorter than ``video_ids``.
        """
        if not video_ids:
            return []

        credentials = self._build_credentials(
            access_token_encrypted, refresh_token_encrypted, token_expiry
        )

        # YouTube API accepts a comma-joined string for the ``id`` parameter.
        ids_param = ",".join(video_ids)

        def _fetch() -> list[dict[str, Any]]:
            from googleapiclient.discovery import build

            youtube = build("youtube", "v3", credentials=credentials)
            response = (
                youtube.videos()
                .list(
                    part="statistics,snippet",
                    id=ids_param,
                )
                .execute()
            )

            stats: list[dict[str, Any]] = []
            for item in response.get("items", []):
                statistics = item.get("statistics", {})
                snippet = item.get("snippet", {})
                stats.append(
                    {
                        "video_id": item["id"],
                        "title": snippet.get("title", ""),
                        "views": int(statistics.get("viewCount", 0)),
                        "likes": int(statistics.get("likeCount", 0)),
                        "comments": int(statistics.get("commentCount", 0)),
                        "published_at": snippet.get("publishedAt"),
                    }
                )
            return stats

        return await asyncio.to_thread(_fetch)
