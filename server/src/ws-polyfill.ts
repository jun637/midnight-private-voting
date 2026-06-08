// The wallet SDK and Apollo indexer client expect a global WebSocket in Node.
import WebSocket from "ws";
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;
