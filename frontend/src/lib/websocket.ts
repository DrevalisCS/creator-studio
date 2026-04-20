// =============================================================================
// WebSocket Client for Real-Time Progress Updates
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ProgressMessage } from '@/types';

// ---------------------------------------------------------------------------
// Raw WebSocket manager
// ---------------------------------------------------------------------------

interface WSOptions {
  onMessage: (msg: ProgressMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Event) => void;
  reconnectInterval?: number;
  maxRetries?: number;
}

class ProgressWebSocket {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private url: string,
    private options: WSOptions,
  ) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.retryCount = 0;
        this.options.onOpen?.();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as ProgressMessage;
          this.options.onMessage(data);
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.options.onClose?.();
        this.scheduleReconnect();
      };

      this.ws.onerror = (err) => {
        this.options.onError?.(err);
        // onclose will fire after onerror, which handles reconnection
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.closed) return;

    const maxRetries = this.options.maxRetries ?? 10;
    if (this.retryCount >= maxRetries) return;

    const interval = this.options.reconnectInterval ?? 3000;
    const backoff = Math.min(interval * Math.pow(1.5, this.retryCount), 30000);
    this.retryCount++;

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, backoff);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// React Hook: useEpisodeProgress
// ---------------------------------------------------------------------------

export interface EpisodeProgressState {
  connected: boolean;
  messages: ProgressMessage[];
  latestByStep: Record<string, ProgressMessage>;
  error: string | null;
}

export function useEpisodeProgress(
  episodeId: string | null | undefined,
): EpisodeProgressState {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ProgressMessage[]>([]);
  const [latestByStep, setLatestByStep] = useState<
    Record<string, ProgressMessage>
  >({});
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<ProgressWebSocket | null>(null);

  const handleMessage = useCallback((msg: ProgressMessage) => {
    setMessages((prev) => {
      const next = [...prev, msg];
      return next.length > 200 ? next.slice(-200) : next;
    });
    setLatestByStep((prev) => ({
      ...prev,
      [msg.step]: msg,
    }));
    if (msg.error) {
      setError(msg.error);
    }
  }, []);

  useEffect(() => {
    if (!episodeId) return;

    // Determine WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/progress/${episodeId}`;

    setMessages([]);
    setLatestByStep({});
    setError(null);

    const ws = new ProgressWebSocket(wsUrl, {
      onMessage: handleMessage,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onError: () => setError('WebSocket connection error'),
      reconnectInterval: 3000,
      maxRetries: 10,
    });

    wsRef.current = ws;

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [episodeId, handleMessage]);

  return { connected, messages, latestByStep, error };
}

// ---------------------------------------------------------------------------
// React Hook: useActiveJobsProgress (all active jobs)
// ---------------------------------------------------------------------------

export function useActiveJobsProgress(): {
  connected: boolean;
  latestByEpisode: Record<string, Record<string, ProgressMessage>>;
} {
  const [connected, setConnected] = useState(false);
  const [latestByEpisode, setLatestByEpisode] = useState<
    Record<string, Record<string, ProgressMessage>>
  >({});
  const wsRef = useRef<ProgressWebSocket | null>(null);

  const handleMessage = useCallback((msg: ProgressMessage) => {
    setLatestByEpisode((prev) => ({
      ...prev,
      [msg.episode_id]: {
        ...(prev[msg.episode_id] ?? {}),
        [msg.step]: msg,
      },
    }));
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws/progress/all`;

    const ws = new ProgressWebSocket(wsUrl, {
      onMessage: handleMessage,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      reconnectInterval: 5000,
      maxRetries: 15,
    });

    wsRef.current = ws;

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [handleMessage]);

  return { connected, latestByEpisode };
}
