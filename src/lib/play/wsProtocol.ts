/**
 * Client-visible view of the committed WS wire protocol (server/protocol.ts).
 *
 * `server/` sits OUTSIDE `src/`, so the `$lib` alias does not reach it and we do not want
 * `../../../server/...` climbs scattered across the client tree. This module is the single
 * crossing point: the message types are re-exported type-only (erased at build, zero
 * runtime), and the two heartbeat CONSTANTS are re-exported as values so the client and the
 * server can never drift on them. `server/protocol.ts` itself imports only `import type`, so
 * pulling it into the client bundle adds nothing but those two numbers.
 */

export type {
	CommandId,
	WsError,
	JoinMessage,
	CommandMessage,
	ResyncMessage,
	PingMessage,
	ClientMessage,
	JoinedMessage,
	AckMessage,
	DeltaMessage,
	ErrorMessage,
	PongMessage,
	ServerMessage
} from '../../../server/protocol';

export { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '../../../server/protocol';
