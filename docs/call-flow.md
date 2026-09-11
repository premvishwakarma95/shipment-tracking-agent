# Call Flow

```mermaid
flowchart TD
    A[MDR: POST /mdr/call-requests] --> B[Raw-capture payload]
    B --> C{Validate required fields}
    C -- missing --> C1[400]
    C -- duplicate mdr_call_id --> C2[202 already_accepted]
    C -- ok --> D[Create CallRequest]
    D --> E[Build call variables]
    E --> F[Vapi: create outbound call]
    F --> G[202 accepted, voice_call_id]

    G -.async gap: call in progress.-> H[Vapi conducts conversation]
    H --> I{Special-case outcome?}
    I -- wrong contact / callback / email / escalation --> J[Vapi: tool-calls webhook]
    J --> K[Write tool_flags on CallRequest]
    I -- none --> L[Conversation continues]
    K --> L

    L --> M[Vapi: end-of-call-report webhook]
    M --> N[classifyCallStatus: tool_flags takes precedence over endedReason]
    N --> O[Assemble CallResultPayload from structured-data extraction + tool_flags]
    O --> P[mdr.pushCallResult]
    P -- success --> Q[mdr_pushed_at set]
    P -- failure --> R[left null, manual reconciliation]
```

## Node-to-spec cross reference

| Node | Client spec section |
|---|---|
| Raw-capture / validate | §2 "What MDR Will Send to Voice API" |
| Build call variables (previous_interactions/open_items) | §3 "Previous Conversation Information" |
| Vapi conducts conversation — introduction | §4 "Voice Agent General Introduction" |
| Vapi conducts conversation — per call_type questions | §5-8 (OUT_FOR_DELIVERY / PICKUP_TODAY / DISPATCHED / IN_TRANSIT) |
| Reconfirm-not-reask behavior | §9 "If Previous Information Exists" |
| NO_ANSWER / BUSY (no tool, endedReason-derived) | §10 "No Answer" |
| LEFT_VOICEMAIL (no tool, endedReason-derived) | §11 "Voicemail" |
| reportWrongContact tool | §12 "Wrong Person" |
| reportCallbackRequested tool | §13 "Callback Requested" |
| reportEmailRequested tool | §14 "Email Requested" |
| CALL_DROPPED (partial capture) | §15 "Call Dropped" |
| Null-not-guessed fields | §16 "Carrier Does Not Know an Answer" |
| flagHumanEscalation tool | §17 "Serious Issue / Human Escalation" |
| Structured result assembly | §18-19 "Voice Must Return Structured Information" / "Common Response Format" |
| call_status enum | §20 "Required Call Statuses" |
| Whole flow | §21-22 "Important Rules" / "Very Simple Responsibility Split" |
