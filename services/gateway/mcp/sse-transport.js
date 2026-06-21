import { writeSseOrClose } from './sessions.js';
import { swallow } from '@cortex/sdk/errors';

/**
 * Bun-native SSE transport implementing the MCP SDK transport interface.
 * SSE protocol: GET /mcp opens the stream and sends `event: endpoint`. The
 * client then POSTs JSON-RPC messages to /mcp/message?sessionId=xxx, which
 * handler.js dispatches into this transport via onmessage.
 */
export class BunSSETransport {
  constructor(writer, id) {
    this._writer = writer;
    this._enc = new TextEncoder();
    this.id = id;
    this.closed = false;
  }

  async start() {}

  async send(message) {
    const line = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    // Adapt to writeSseOrClose's session shape.
    const sessionLike = {
      id: this.id,
      writer: { write: (chunk) => this._writer.write(chunk), close: () => this._writer.close() },
      closed: this.closed,
      onclose: () => this.onclose?.(),
    };
    await writeSseOrClose(sessionLike, this._enc.encode(line));
    if (sessionLike.closed) this.closed = true;
  }

  async close() {
    this.closed = true;
    try { await this._writer.close(); } catch (err) { swallow('mcp_sse_close_threw', err); }
    try { this.onclose?.(); } catch (err) { swallow('mcp_sse_onclose_threw', err); }
  }
}
