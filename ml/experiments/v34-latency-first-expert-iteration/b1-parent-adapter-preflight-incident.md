# V34 B1 parent-adapter no-game preflight incident

No game was started, no seed was consumed, and no outcome was read.

The first no-game SimForge handshake used the frozen general `RemotePolicy` through the new B1 adapter.
Its synchronous bridge timed out after 30 seconds before returning the server info handshake. The same
constructor timeout reproduced locally on Node 25 and remotely on Node 20. Direct framed Python requests
to the same Unix socket succeeded, and an instrumented ready-synchronized worker bridge returned the
expected server info. GPU 7 was then explicitly stopped and verified at 0 MiB/0%.

Resolution: the B1-only adapter now contains a narrow binary client whose async factory waits for the
worker socket-ready message before the first synchronous request. It requests raw logits and reach30 in
one frame. The frozen general inference client, checkpoint, server, and engine source remain unmodified.
The replacement has a fake-server binary-wire test and requires a new live no-game handshake plus Fable
review before any smoke authorization.
