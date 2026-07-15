# Fable high review: V35 local/private implementation, attempt 1

Date: 2026-07-14

Verdict: **BLOCK**

The first local-only revision still contained stale hosted-Weco decisions and did not yet specify enough
technical enforcement. Required corrections were:

- remove hosted service paths and resolve the privacy, resource-cap, and objective-ordering decisions;
- isolate candidate action code out of process from the trusted engine and replay producer;
- derive private/final seeds from a sealed secret and mediate selection through an immutable query broker;
- define chained signed replay/resource evidence and key custody outside candidate mounts;
- hard-pin GPU 7, keep GPUs 4-6 forbidden, and scrub state between tenants;
- validate snapshot-score/full-game correlation and reject an engine-hoarding Goodhart candidate;
- compare every optimizer through identical infrastructure using measured local compute cost;
- sandbox the evolved Phase 4 researcher and require at least three corrected independent pairs;
- technically withhold production credentials/final results and define key/seed rotation after incidents.

No V35 implementation or experiment was authorized by this review.
