# Optional Office decision delivery

Disabled without deployment-owned trust configuration. Ordinary MCP settings,
server names, tool text and approval links cannot enable native delivery.
No hosted model or new notification service is required.

The API and worker use the existing MCP connection, secret store and network
policy. `TRUSTED_MCP_BINDINGS` is a JSON list of bindings with these fields:

- `kind`: `office-decisions-v1`
- `nativeAuthority`: the exact native authentication authority; must match the
  API composition's auth URL and the worker's configured `BETTER_AUTH_URL`
  (or `WEB_ORIGIN`).
- `officeId`, `spaceId`, `userId`, `botId`: the Office and originating native scope.
- `serverId`, `serverRevision`, `endpoint`: the exact assigned authenticated
  streamable-HTTP MCP connection. An edited or ambiguous connection is not trusted.
- `protectedTools`: exact protected Office tool names.
- `members`: explicit `{nativeUserId, nativeSpaceId, officeMemberId}` principal mappings.

These are operator-held static principal mappings, independent of login-provider
identity continuity. They do not infer identity by email, raw OIDC subject, browser
arguments or audit headers, and do not promise OIDC reset/rebinding revocation.
The native server authenticates the caller and checks current native membership;
Office checks current active, non-bot membership under its own member namespace.
Missing, ambiguous or mismatched mappings fail closed.

## Office protocol

A protected tool's actual authenticated pending response contains
`{pending:true,status:"pending",request_id:<uuid>}`. Native verifies it by calling
the same requester's assigned server with read-only `office_decision_read`:

    {request_id:<uuid>, office_member_id:<mapped Office member principal>}

Its JSON MCP result must contain only the following authoritative dimensions:

    {version:1, office_id, request_id, requester_bot_id, office_member_id,
     authorized:true, status, decision_id}

Status is pending, approved, rejected, expired or stale. Pending has null
`decision_id`; a rejection has a stable identity derived from the existing
immutable decision, for example `office-decision:v1:<office-id>:<request-id>:rejected`.
The tool must verify the actual authenticated requester bot, Office and request,
and the queried active employee principal. Return no client values, proposed
fields, history, names or directory. An arbitrary echoed native space is not proof.

A real human-origin native run is required. Native stores the exact source,
marker, run, execution and history fence in a transaction; background-only runs
remain in Activity. A failed native receipt write preserves the already successful
Office pending response and must not repeat the protected mutation.

## Delivery and retry

After an authoritative Office rejection succeeds, the authenticated client may call
`officeDecisions.deliverRejected({officeId,requestId})`. A losing decision/409 must
not invoke delivery. Native independently re-reads canonical Office status.

The internal integration actor can deliver from one employee's personal space to
the original employee's separate personal space only through the explicit mapping
and uniquely attested receipt. It grants no ordinary cross-space chat read/send,
returns no private target/history to the caller and never speaks as the owner.
The original owner must still belong to the original space; the caller must still
belong to the authenticated caller space. Missing/cleared/deleted/ambiguous origin
stays in Activity. Source validation precedes replay and insertion under native
thread/request locks. A predictable client nonce alone is never accepted as proof.

Responses contain only `state` and `retryable`. State is `activity-only`,
`delivery-failed`, or `native-send-accepted`. Explicit retry repeats this RPC only,
not Office approve/reject or a protected write. The receipt effect deduplicates
concurrent tabs/reload/retry. Native acceptance does not establish model receipt,
a successful report or later no-retry behavior. Actual semantic acceptance uses
an opt-in provider-neutral versioned rubric, never prose keyword grading.

The decision-source report turn exposes no tools and refuses hidden tool dispatch.
An existing active conversational run uses native steering and a bound protected-
Office-call guard until a later human turn. Shared bot permissions are unchanged.
The fixed rejection instruction does not itself prove later model behavior.

Web, desktop and mobile clients without this optional callback continue to show
the authoritative decision in Activity. Enabling a consumer/carrier or changing
its source pin is separate from this source implementation.
